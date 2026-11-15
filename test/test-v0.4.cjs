const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const dir = path.join(__dirname, '.test-jsonl');
let fail = false;
global.ToolPkg = { getConfigDir: () => dir, getLocalDataDir: () => dir };
global.Tools = { Files: {
  mkdir: async p => { fs.mkdirSync(p, {recursive:true}); return {successful:true}; },
  write: async (p, text, append) => {
    if (p.endsWith("/config.json")) return {operation:{successful:true}};
    if (fail) return {operation:{successful:false}};
    assert.equal(append, false); fs.writeFileSync(p, text);
    return {operation:{successful:true}};
  }
}};
const g = require('../dist/guard.js');
console.log = () => {};
const out = text => process.stdout.write(text + '\n');
let events = 0;
function ev(chat, event, arg, t) {
  events++;
  return g.onToolLifecycle({event, timestampMs:t, eventPayload:{toolName:'demo', parameters:{arg:String(arg)}, runtimeContext:{chatId:chat}}});
}
function state(chat) { return g.readStatus().chats.find(s => s.chatId === chat); }
function prompt(chat, t) { return g.onToolPrompt({event:'tool_prompt_compose',timestampMs:t,eventPayload:{chatId:chat,toolPrompt:'ORIGINAL',metadata:{}}}); }
(async () => {
 try {
  await g.setConfig({softMs:0});
  for (let i=0;i<10;i++) ev('calls','tool_call_requested',i,1000+i);
  assert.equal(state('calls').calls,10); assert.equal(state('calls').warned,true);
  const warning = prompt('calls',1010); assert.equal(warning.toolPrompt,'ORIGINAL\n'+g.WARNING);
  assert.ok([...g.WARNING].length<=60); assert.equal(prompt('calls',1011),undefined);
  out('PASS 10 different parameters: calls=10, warned=true; warning <=60 chars, once');
  for (const order of [['tool_call_requested','tool_call_intercept'],['tool_call_intercept','tool_call_requested']]) {
    const chat=order[0]; const actions=[];
    for(let i=0;i<3;i++) for(const e of order) {
      const r=ev(chat,e,'same',2000+i); if(e==='tool_call_intercept') actions.push(r?.action??'allow');
    }
    assert.deepEqual(actions,['allow','allow','block']); assert.equal(state(chat).icRepeat,0);
    assert.equal(ev(chat,'tool_call_intercept','changed',2010),undefined);
    out('PASS '+order.join(' -> ')+': allow,allow,block; changed parameters allow');
  }
  for(let i=0;i<10;i++) ev('calls','tool_execution_finished',i,1020);
  ev('calls','tool_call_intercept','new',602021);
  const s=state('calls'); assert.equal(s.calls,0); assert.equal(s.warned,false);
  assert.equal(s.icCalls,1); assert.equal(s.icRepeat,1); assert.equal(s.lastBlockReason,'');
  out('PASS idle >activeResetMs: window and both counter sets reset');
  for(let i=0;i<6;i++) ev('time','tool_call_requested',i,300000+i*90000);
  assert.equal(state('time').warned,false); assert.equal(prompt('time',750000),undefined);
  out('PASS continuous activity does not trigger time-based soft warning');
  for(let i=0;i<50;i++) {
    const r=ev('budget','tool_call_intercept',i,800000+i);
    assert.equal(r?.action,i===49?'block':undefined);
  }
  out('PASS hardCalls: exactly intercept #50 blocks');
  await g.flushEvents();
  const rows=fs.readdirSync(dir).flatMap(f=>fs.readFileSync(path.join(dir,f),'utf8').trim().split('\n').map(JSON.parse));
  assert.equal(rows.length,4); assert.ok(rows.every(r=>['block','soft_warning'].includes(r.event) && !('parameters' in r)));
  const writes=g.readStatus().persistence.written;
  assert.equal(writes,rows.length);
  out('PASS timeline overwrite: 4 trigger records; ordinary events omitted');
  fail=true; ev('failure','tool_call_intercept',0,900000); ev('failure','tool_call_intercept',0,900001); ev('failure','tool_call_intercept',0,900002); await g.flushEvents();
  assert.equal(g.readStatus().persistence.failed,1); assert.equal(g.readStatus().recentEvents.length,5);
  fail=false; for(let i=0;i<3;i++) ev('recovery','tool_call_intercept',0,900010+i); await g.flushEvents();
  assert.equal(g.readStatus().persistence.lastError,'');
  out('PASS failed write: memory fallback; next trigger write recovers');
 } finally { fs.rmSync(dir,{recursive:true,force:true}); }
})().catch(e=>{process.stderr.write(e.stack+'\n');process.exitCode=1;});
