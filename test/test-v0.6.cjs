#!/usr/bin/env node
/* v0.6.0 白名单自测：直接加载 dist/guard.js，模拟 hook 事件。
   验证 4 件事：① 普通工具按预算被拦 ② turn_guard_config 不被拦 ③ 白名单不计入 calls
   ④ 白名单调用后普通工具仍能正常被拦（豁免不影响他人） */
const path = require('path');

function fakeToolPkg() {
  return {
    getLocalDataDir: () => '/tmp/tg_test_' + Date.now(),
    getConfigDir: () => '/tmp/tg_test_cfg_' + Date.now(),
    registerToolLifecycleHook: () => {},
  };
}
global.ToolPkg = fakeToolPkg();
let timeline = '';
global.Tools = {
  Files: {
    mkdir: async () => ({ successful: true }),
    write: async (p, text, append) => {
      if (p.endsWith('turn_guard-timeline.jsonl')) {
        if (append !== false) throw new Error('timeline must overwrite');
        timeline = text;
      }
      return { operation: { successful: true } };
    },
    list: async () => ({ entries: [] }),
    deleteFile: async () => ({ successful: true }),
  },
};

const guard = require(path.resolve(__dirname, '../dist/guard.js'));

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('PASS', name); }
  else { fail++; console.log('FAIL', name, extra === undefined ? '' : JSON.stringify(extra)); }
}

function ev(event, toolName, ts) {
  return {
    event,
    timestampMs: ts,
    eventPayload: {
      toolName,
      parameters: { k: 1, __operit_package_caller_owner: 'com.nyan.turn_guard' },
      runtimeContext: { chatId: 'c1' },
    },
  };
}

(async () => {
  // 先触发一次事件让 ensureConfigLoaded() 从文件异步加载完，否则 setConfig 会被覆盖回文件值
  guard.onToolLifecycle(ev('tool_execution_finished', 'warmup', Date.now() - 1000));
  await new Promise((r) => setTimeout(r, 100));

  // 预算压到 2 次，方便两条工具调用内触发。setConfig 是 async，必须 await，
  // 否则 Object.assign(cfg, next) 在微任务里执行，下面的事件会跑在旧配置上。
  await guard.setConfig({ hardBlock: true, warn: false, hardCalls: 2, repeatLimit: 99, hardMs: 1e9, idleResetMs: 1e9 });
  const t0 = Date.now();

  // ① 普通工具：第 2 次触预算
  const r1 = guard.onToolLifecycle(ev('tool_call_intercept', 'super_admin:bash', t0 + 1));
  const r2 = guard.onToolLifecycle(ev('tool_call_intercept', 'super_admin:bash', t0 + 2));
  check('①a 第 1 次普通调用放行', !r1, r1);
  check('①b 第 2 次普通调用被拦', !!(r2 && r2.action === 'block'), r2);

  // ② 白名单：此刻预算已到，但 config 必须放行
  const r3 = guard.onToolLifecycle(ev('tool_call_intercept', 'turn_guard:turn_guard_config', t0 + 3));
  check('②a 预算已满时 config 仍放行', !r3, r3);
  const r4 = guard.onToolLifecycle(ev('tool_call_intercept', 'turn_guard_config', t0 + 4)); // 无前缀形态
  check('②b 无前缀形态也放行', !r4, r4);

  // ③ 白名单不计入 calls
  const before = guard.readStatus().chats[0].calls;
  guard.onToolLifecycle(ev('tool_call_requested', 'turn_guard:turn_guard_status', t0 + 5));
  guard.onToolLifecycle(ev('tool_call_requested', 'turn_guard:turn_guard_status', t0 + 6));
  const after = guard.readStatus().chats[0].calls;
  check('③ status 调用不计入 calls', before === after, { before, after });

  // ④ 白名单不破坏普通工具拦截：预算仍是满的，但 icRepeat 已被重置 → 观察仍会被拦
  const r5 = guard.onToolLifecycle(ev('tool_call_intercept', 'super_admin:bash', t0 + 7));
  check('④ 豁免后普通工具仍受预算约束', !!(r5 && r5.action === 'block'), r5);

  // ⑤ 诊断字段可见
  const s = guard.readStatus().chats[0];
  check('⑤ exemptCalls 已累加', s.exemptCalls === 2, s.exemptCalls);
  check('⑤ lastBlockReason 有值', !!s.lastBlockReason, s.lastBlockReason);

  await guard.flushEvents();
  const records = timeline.trim().split('\n').filter(Boolean).map(JSON.parse);
  check('⑥ 时间线只记触发且最多 5 条', records.length === 2 && records.length <= 5 && records.every(r => ['soft_warning', 'block'].includes(r.event)), records);
  // 单计数器与时间线回归：文件 mock 也验证覆盖写。
  await guard.setConfig({ warn: false, hardCalls: 999, softCalls: 999, repeatLimit: 999 });
  const send = (chat, event, ts) => guard.onToolLifecycle({ ...ev(event, 'ordinary', ts), eventPayload: { ...ev(event, 'ordinary', ts).eventPayload, runtimeContext: { chatId: chat } } });
  for (let n = 0; n < 8; n++) send('A', 'tool_call_requested', t0 + 100 + n);
  check('单计数器 A 调用 8 次', guard.readStatus().chats[0].calls === 8);
  send('B', 'tool_execution_finished', t0 + 110);
  check('切 B 从 0 开始且清空重复/告警', guard.readStatus().chats.length === 1 && guard.readStatus().chats[0].calls === 0 && guard.readStatus().chats[0].repeat === 0 && !guard.readStatus().chats[0].warned);
  send('A', 'tool_execution_finished', t0 + 111);
  check('切回 A 也从 0 开始', guard.readStatus().chats[0].calls === 0);
  const writesBefore = guard.readStatus().persistence.written;
  const timelineBefore = timeline;
  for (let n = 0; n < 20; n++) {
    send('A', 'tool_call_requested', t0 + 120 + n);
    send('A', 'tool_execution_finished', t0 + 120 + n);
    send('A', 'tool_execution_error', t0 + 120 + n);
  }
  await guard.flushEvents();
  check('20 次普通调用及 result/error 不产生记录', timeline === timelineBefore && guard.readStatus().persistence.written === writesBefore);
  // 新加载的模块模拟全新时间线，保留原来八个白名单断言。
  delete require.cache[require.resolve('../dist/guard.js')];
  const fresh = require('../dist/guard.js');
  await fresh.setConfig({ softCalls: 1, hardCalls: 1, repeatLimit: 999, hardMs: 1200000 });
  fresh.onToolLifecycle(ev('tool_call_requested', 'ordinary', t0));
  fresh.onToolPrompt({ timestampMs: t0, eventPayload: { chatId: 'c1', toolPrompt: '' } });
  fresh.onToolLifecycle(ev('tool_call_intercept', 'ordinary', t0 + 1));
  await fresh.flushEvents();
  const two = timeline.trim().split('\n').map(JSON.parse);
  check('一次软提醒 + 一次硬拦恰好 2 条', two.length === 2 && two[0].event === 'soft_warning' && two[1].event === 'block' && !!two[1].reason);
  for (let n = 0; n < 6; n++) fresh.onToolLifecycle(ev('tool_call_intercept', 'ordinary', t0 + 2 + n));
  await fresh.flushEvents();
  const five = timeline.trim().split('\n').map(JSON.parse);
  check('再触发 6 次后文件和内存仅保留最后 5 条', five.length === 5 && fresh.readStatus().recentEvents.length === 5 && five[0].timestampMs === t0 + 3 && five[4].timestampMs === t0 + 7);
  await fresh.setConfig({ softCalls: 999, hardCalls: 999, hardMs: 2000, idleResetMs: 120000 });
  const timed = (event, ts) => fresh.onToolLifecycle({ ...ev(event, 'ordinary', ts), eventPayload: { ...ev(event, 'ordinary', ts).eventPayload, runtimeContext: { chatId: 'time' } } });
  timed('tool_call_requested', t0);
  const hard = timed('tool_call_intercept', t0 + 2000);
  check('hardMs=2000：2 秒触发时间预算硬拦', hard?.action === 'block' && /时间预算/.test(hard.reason));
  await fresh.setConfig({ warn: false, idleResetMs: 1000 });
  timed('tool_execution_finished', t0 + 2001);
  timed('tool_prompt_idle_probe', t0 + 3002);
  check('idleResetMs=1000：空闲超过 1 秒清零', fresh.readStatus().chats[0].calls === 0 && fresh.readStatus().chats[0].icCalls === 0 && !fresh.readStatus().chats[0].warned);
  await fresh.flushEvents();
  console.log(`\n结果: ${pass} PASS / ${fail} FAIL`);
  process.exit(fail ? 1 : 0);
})();