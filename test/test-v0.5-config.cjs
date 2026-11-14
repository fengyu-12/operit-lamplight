// v0.5.0 配置化自测：get / set 立即生效 / reset / 非法值被 clamp / 写盘失败不崩
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const dataDir = path.join(__dirname, '.test-data-v05');
const configDir = path.join(__dirname, '.test-config-v05');
for (const d of [dataDir, configDir]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }

let failWrite = false;
global.ToolPkg = {
  getLocalDataDir: () => dataDir,
  getConfigDir: () => configDir,
};
global.Tools = {
  Files: {
    mkdir: async p => { fs.mkdirSync(p, { recursive: true }); return { successful: true }; },
    write: async (p, text) => {
      if (failWrite) return { operation: { successful: false } };
      fs.writeFileSync(p, text);
      return { operation: { successful: true } };
    },
    exists: async p => {
      const ok = fs.existsSync(p);
      return { path: p, exists: ok, isDirectory: ok ? fs.statSync(p).isDirectory() : false, size: ok ? fs.statSync(p).size : 0 };
    },
    read: async p => ({ path: p, content: fs.readFileSync(p, 'utf8'), size: fs.statSync(p).size }),
  },
};

const g = require('../dist/guard.js');
const out = text => process.stdout.write(text + '\n');

(async () => {
  // 1) get 读不到文件时回落到 DEFAULTS
  const initial = await g.getConfig();
  assert.equal(initial.softCalls, 10);
  assert.equal(initial.hardCalls, 50);
  out('PASS get(): 无配置文件时返回 DEFAULTS');

  // 2) set 落盘 + 立即生效（同一进程内直接判定行为变化，不重装）
  const before = g.onToolLifecycle({
    event: 'tool_call_intercept', timestampMs: 5000,
    eventPayload: { toolName: 'x', parameters: { a: '1' }, runtimeContext: { chatId: 'cfgtest' } },
  });
  assert.equal(before, undefined); // hardCalls=50 默认，第 1 次不拦

  const setRes = await g.setConfig({ hardCalls: 1 });
  assert.equal(setRes.ok, true);
  assert.equal(setRes.config.hardCalls, 1);
  const filePath = path.join(configDir, 'config.json');
  assert.ok(fs.existsSync(filePath), 'config.json 应已写盘');
  const onDisk = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  assert.equal(onDisk.hardCalls, 1);
  out('PASS set({hardCalls:1}): 写盘成功，内容正确');

  // 同一进程里，下一次 intercept 应该立刻按新阈值拦截（证明“改完即时生效，不重装”）
  const after = g.onToolLifecycle({
    event: 'tool_call_intercept', timestampMs: 5001,
    eventPayload: { toolName: 'x', parameters: { b: '2' }, runtimeContext: { chatId: 'cfgtest' } },
  });
  assert.equal(after && after.action, 'block');
  out('PASS 改配置→行为变化：hardCalls 降到 1 后，下一次 intercept 立即被拦截');

  // 3) 非法值被 clamp 掉，不污染配置
  const badRes = await g.setConfig({ hardCalls: -5, softCalls: 'nope', hardBlock: 'yes' });
  assert.equal(badRes.ok, true);
  assert.equal(badRes.config.hardCalls, 1, '负数非法值应被忽略，保留旧值');
  assert.equal(badRes.config.softCalls, 10, '非数字应被忽略，保留默认');
  assert.equal(badRes.config.hardBlock, true, '非布尔应被忽略，保留默认 true');
  out('PASS set() 对非法字段 clamp：负数/非数字/非布尔被忽略，其余字段不受影响');

  // 4) reset 恢复默认并写盘
  const resetRes = await g.resetConfig();
  assert.equal(resetRes.hardCalls, 50);
  const onDisk2 = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  assert.equal(onDisk2.hardCalls, 50);
  out('PASS reset(): 恢复 DEFAULTS 并写盘');

  // 5) 写盘失败时 ok=false 但不抛异常，内存态配置保持上次已生效值
  failWrite = true;
  const failRes = await g.setConfig({ softCalls: 2 });
  assert.equal(failRes.ok, false);
  assert.ok(failRes.error);
  assert.equal((await g.getConfig()).softCalls, 10, '写盘失败不应改变已生效配置');
  failWrite = false;
  out('PASS 写盘失败: 返回 ok:false + error，内存态配置不被污染，不抛异常');

  out('ALL PASS (v0.5.0 config)');
})().catch(e => { console.error('FAIL', e); process.exitCode = 1; });
