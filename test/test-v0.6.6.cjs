#!/usr/bin/env node
/* 0.6.6 回归：软提醒只看「调用次数」和「相同失败次数」，时间维度已移除。
   判据：① 时间过去 61 秒不再触发提醒 ② 同一工具+参数连错 3 次触发提醒 */
const path = require('path');

global.ToolPkg = {
  getLocalDataDir: () => '/tmp/tg066_data',
  getConfigDir: () => '/tmp/tg066_cfg',
  registerToolLifecycleHook: () => {},
};
global.Tools = {
  Files: {
    mkdir: async () => ({ successful: true }),
    write: async () => ({ operation: { successful: true } }),
    list: async () => ({ entries: [] }),
    deleteFile: async () => ({ operation: { successful: true } }),
    exists: async () => ({ exists: false, isDirectory: false }),
    read: async () => ({ content: '{}' }),
  },
};

const guard = require(path.resolve(__dirname, '../dist/guard.js'));

let pass = 0, fail = 0;
const check = (name, cond, extra) => {
  if (cond) { pass++; console.log('PASS', name); }
  else { fail++; console.log('FAIL', name, extra === undefined ? '' : JSON.stringify(extra)); }
};

function ev(event, toolName, ts, params, chatId) {
  return {
    event, timestampMs: ts,
    eventPayload: {
      toolName,
      parameters: params || { k: 1 },
      runtimeContext: { chatId: chatId || 'c1' },
    },
  };
}

(async () => {
  guard.onToolLifecycle(ev('tool_execution_finished', 'warmup', Date.now() - 5000));
  await new Promise((r) => setTimeout(r, 100));
  // softCalls 拉高，隔离出「相同失败」这一条路径
  await guard.setConfig({ softCalls: 9999, errRepeatLimit: 3, warn: true, hardBlock: true });

  // S3: every numeric field rejects fractions, unsafe integers and out-of-range values.
  const numeric = ['softCalls','hardCalls','hardMs','idleResetMs','repeatLimit','errRepeatLimit'];
  for (const key of numeric) {
    const before = (await guard.getConfig())[key];
    for (const value of [0.5, 1.5, 0, -1, NaN, Infinity, 1e9+1, Number.MAX_SAFE_INTEGER+1]) {
      const res = await guard.setConfig({ [key]: value });
      check(`${key} rejects ${value}`, res.ok && res.config[key] === before);
    }
    const upper = await guard.setConfig({ [key]: 1e9 });
    check(`${key} accepts upper bound`, upper.config[key] === 1e9);
    await guard.setConfig({ [key]: before });
  }
  const fractional = await guard.setConfig({errRepeatLimit:0.5});
  console.log('S3 setConfig({errRepeatLimit:0.5}): ok=' + fractional.ok + ', errRepeatLimit=' + fractional.config.errRepeatLimit);
  const t0 = Date.now();
  for (const [i,event] of ['tool_execution_error','tool_execution_result','tool_execution_error','tool_execution_result','tool_execution_error'].entries()) {
    const e=ev(event,'x',t0+i, {k:1},'alternating');
    e.eventPayload.success=event==='tool_execution_result';
    guard.onToolLifecycle(e);
    const s=guard.readStatus().chats[0];
    if(event==='tool_execution_result') check('success immediately clears errRepeat and lastErr',s.errRepeat===0 && s.lastErr==='');
  }
  let alt=guard.readStatus().chats[0];
  check('S1 alternating failure/success: no warning', !alt.warned && alt.errRepeat===1);
  console.log('S1 alternating: errRepeat='+alt.errRepeat+', warned='+alt.warned);
  // Failed result notifications must not clear a failure chain or count it twice.
  guard.onToolLifecycle(ev('tool_execution_error','x',t0+10,{k:1},'failed-result'));
  const bad=ev('tool_execution_result','x',t0+11,{k:1},'failed-result');bad.eventPayload.success=false;
  guard.onToolLifecycle(bad);
  check('error result does not clear chain',guard.readStatus().chats[0].errRepeat===1);
  bad.eventPayload.success=true;bad.eventPayload.errorMessage='error';guard.onToolLifecycle(bad);
  check('result with errorMessage does not clear chain',guard.readStatus().chats[0].errRepeat===1);
  guard.onToolLifecycle(ev('tool_call_intercept', 'a:t', t0));

  // ① 时间维度已移除：61 秒后的事件不该触发提醒
  guard.onToolLifecycle(ev('tool_execution_finished', 'a:t', t0 + 61000));
  let s = guard.readStatus().chats[0];
  check('61 秒后未提醒（时间维度已移除）', s.warned === false, { warned: s.warned });

  // ② 同一工具+参数连错 2 次：还不够
  guard.onToolLifecycle(ev('tool_execution_error', 'b:fail', t0 + 62000));
  guard.onToolLifecycle(ev('tool_execution_error', 'b:fail', t0 + 63000));
  s = guard.readStatus().chats[0];
  check('连错 2 次未提醒', s.warned === false, { warned: s.warned, errRepeat: s.errRepeat });

  // ③ 第 3 次相同失败：应触发
  guard.onToolLifecycle(ev('tool_execution_error', 'b:fail', t0 + 64000));
  s = guard.readStatus().chats[0];
  console.log('S1 consecutive 3 failures: errRepeat='+s.errRepeat+', warned='+s.warned);
  check('连错 3 次触发提醒', s.warned === true, { warned: s.warned, errRepeat: s.errRepeat });
  check('提醒已置待注入标记', s.warningPending === true, { warningPending: s.warningPending });

  // ③b 触发原因应记为 errors，注入的应是「连续失败」版文案
  check('触发原因记为 errors', s.warnKind === 'errors', { warnKind: s.warnKind });
  const inj1 = guard.onToolPrompt({
    event: 'before_finalize_prompt', timestampMs: t0 + 64500,
    eventPayload: { chatId: 'c1', toolPrompt: 'BASE' },
  });
  check('注入失败版文案', !!(inj1 && inj1.toolPrompt && inj1.toolPrompt.indexOf('连续失败') >= 0), inj1);

  // ④ 换个参数再错：计数重置，不该继续累加
  guard.onToolLifecycle(ev('tool_execution_error', 'b:fail', t0 + 65000, { k: 2 }));
  s = guard.readStatus().chats[0];
  check('换参数后 errRepeat 归 1', s.errRepeat === 1, { errRepeat: s.errRepeat });

  // ⑤ 次数路径：换会话（单计数器按 chatId 重建 state）+ softCalls=1，应注入「调用较多」版文案
  await guard.setConfig({ softCalls: 1 });
  guard.onToolLifecycle(ev('tool_call_requested', 'c:t', t0 + 70000, null, 'c2'));
  s = guard.readStatus().chats[0];
  check('次数触发原因记为 calls', s.warnKind === 'calls', { warnKind: s.warnKind });
  const inj2 = guard.onToolPrompt({
    event: 'before_finalize_prompt', timestampMs: t0 + 70500,
    eventPayload: { chatId: 'c2', toolPrompt: 'BASE' },
  });
  check('注入调用版文案', !!(inj2 && inj2.toolPrompt && inj2.toolPrompt.indexOf('调用较多') >= 0), inj2);

  console.log(`\n结果: ${pass} PASS / ${fail} FAIL`);
  process.exit(fail ? 1 : 0);
})();