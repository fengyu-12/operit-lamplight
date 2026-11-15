#!/usr/bin/env node
/* 0.7.0 回归：软提醒新增「本轮时长」信号 + 默认值调整。
   判据：
   ① 默认值 = 软 8 / 软时长 5 分钟 / 硬 50 / 硬停 15 分钟 / 空闲 80 秒
   ② softMs 到点触发，warnKind='time'，注入「耗时较久」版文案；未到点不触发
   ③ 长工具超过 idleResetMs 后，活动时长仍保留（0.8 修复）
   ④ 同一轮里次数与时长都满足时，先报次数（calls 优先）
*/
const path = require('path');

global.ToolPkg = {
  getLocalDataDir: () => '/tmp/tg070_data',
  getConfigDir: () => '/tmp/tg070_cfg',
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
    eventPayload: { toolName, parameters: params || { k: 1 }, runtimeContext: { chatId: chatId || 'c1' } },
  };
}
const prompt = (ts, chatId) => guard.onToolPrompt({
  event: 'before_finalize_prompt', timestampMs: ts,
  eventPayload: { chatId, toolPrompt: 'BASE' },
});

(async () => {
  // 预热：等首次异步配置加载落地，再断言默认值
  guard.onToolLifecycle(ev('tool_execution_finished', 'warmup', Date.now() - 5000, null, 'warm'));
  await new Promise((r) => setTimeout(r, 100));

  // ① 默认值
  const d = await guard.getConfig();
  check('默认 softCalls=8', d.softCalls === 8, d.softCalls);
  check('默认 softMs=300000', d.softMs === 300000, d.softMs);
  check('默认 hardCalls=50', d.hardCalls === 50, d.hardCalls);
  check('默认 hardMs=900000', d.hardMs === 900000, d.hardMs);
  check('默认 idleResetMs=80000', d.idleResetMs === 80000, d.idleResetMs);

  // ② 时长到点触发（把次数/失败阈值拉高，隔离出时长这一条路径）
  await guard.setConfig({ softMs: 1000, softCalls: 9999, errRepeatLimit: 9999 });
  const T0 = 1_800_000_000_000;
  guard.onToolLifecycle(ev('tool_call_requested', 'a:read', T0, null, 't-time'));
  let s = guard.readStatus().chats[0];
  check('刚开轮不提醒', s.warned === false, { warned: s.warned });
  guard.onToolLifecycle(ev('tool_execution_finished', 'a:read', T0 + 400, null, 't-time'));
  s = guard.readStatus().chats[0];
  check('400ms 未到点不提醒', s.warned === false, { warned: s.warned });
  guard.onToolLifecycle(ev('tool_call_requested', 'a:read2', T0 + 1200, null, 't-time'));
  s = guard.readStatus().chats[0];
  check('1200ms 到点触发', s.warned === true, { warned: s.warned });
  check('触发原因记为 time', s.warnKind === 'time', { warnKind: s.warnKind });
  const inj = prompt(T0 + 1300, 't-time');
  check('注入时长版文案', !!(inj && inj.toolPrompt && inj.toolPrompt.indexOf('耗时较久') >= 0), inj);

  // ③ 空闲重置：跨过 idleResetMs 后时长重新起算，不该立刻报警
  const T1 = T0 + 10000;
  guard.onToolLifecycle(ev('tool_call_requested', 'b:x', T1, null, 't-idle'));
  guard.onToolLifecycle(ev('tool_execution_finished', 'b:x', T1 + 90000, null, 't-idle'));
  s = guard.readStatus().chats[0];
  check('长工具保留时长并提醒', s.warned === true && s.calls === 1 && s.activeSince === T1, { warned: s.warned, calls: s.calls });

  // ④ 次数与时长同时满足：先报 calls
  await guard.setConfig({ softMs: 1000, softCalls: 1 });
  const T2 = T1 + 100000;
  guard.onToolLifecycle(ev('tool_call_requested', 'c:y', T2, null, 't-prio'));
  guard.onToolLifecycle(ev('tool_execution_finished', 'c:y', T2 + 5000, null, 't-prio'));
  s = guard.readStatus().chats[0];
  check('次数优先于时长', s.warnKind === 'calls', { warnKind: s.warnKind });

  console.log(`\n结果: ${pass} PASS / ${fail} FAIL`);
  process.exit(fail ? 1 : 0);
})();
