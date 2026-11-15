const a = require('node:assert/strict');
global.ToolPkg = {getConfigDir:()=>'/mock/config',getLocalDataDir:()=>'/mock/data'};
global.Tools = {Files:{exists:async()=>({exists:false}),mkdir:async()=>({successful:true}),write:async()=>({operation:{successful:true}})}};
const g = require('../dist/guard.js');
let chat=0;
const s=()=>g.readStatus().chats[0];
const event=(event,t,extra={})=>g.onToolLifecycle({event,timestampMs:t,eventPayload:{toolName:'demo',parameters:{x:'1'},runtimeContext:{chatId:String(chat)},...extra}});
const prompt=t=>g.onToolPrompt({timestampMs:t,eventPayload:{chatId:String(chat),toolPrompt:'BASE'}});
async function fresh(patch={}) {chat++; await g.setConfig({...g.DEFAULTS,softCalls:9999,errRepeatLimit:9999,hardCalls:9999,repeatLimit:9999,...patch});}
function pass(text){console.log('PASS '+text);}
(async()=>{
 await fresh(); event('tool_call_requested',0); event('tool_execution_result',300000);
 a.equal(s().calls,1);a.equal(s().activeSince,0);a.equal(s().warnKind,'time');
 pass(`T1 长工具: calls=${s().calls}, activeSince=${s().activeSince}, warnKind=${s().warnKind}`);
 await fresh(); event('tool_call_requested',0);event('tool_execution_result',1);event('tool_call_requested',100001);
 a.equal(s().activeSince,0);a.equal(s().calls,1);event('tool_execution_result',100002);prompt(300000);a.equal(s().warnKind,'time');
 pass(`T1 长思考: activeSince=${s().activeSince}, calls=${s().calls}, warnKind=${s().warnKind}`);
 await fresh();event('tool_execution_result',0);event('tool_call_requested',600001);
 a.equal(s().activeSince,600001);a.equal(s().warned,false);
 pass(`T1 真断档: activeSince=${s().activeSince}, warned=${s().warned}`);
 for(const gap of [60000,80000,80001]) {await fresh();event('tool_call_requested',0);event('tool_execution_result',0);event('tool_call_requested',gap);a.equal(s().calls,gap>80000?1:2);a.equal(s().activeSince,0);}
 pass('60s 计入；80s 不重置，80s+1ms 仅重置计数');
 for(const gap of [600000,600001]) {await fresh();event('tool_execution_result',0);event('tool_call_requested',gap);a.equal(s().activeSince,gap>600000?gap:0);}
 await fresh({activeResetMs:1000,idleResetMs:2000});event('tool_execution_result',0);event('tool_execution_result',2000);a.equal(s().activeSince,0);event('tool_execution_result',4001);a.equal(s().activeSince,4001);
 pass('活动断档严格 > max(idleResetMs, activeResetMs)');
 for(const offset of [-1,0,1]) {
  await fresh();event('tool_call_requested',0);event('tool_execution_result',300000+offset);a.equal(s().warned,offset>=0);
  await fresh();event('tool_call_requested',0);const r=event('tool_call_intercept',900000+offset);a.equal(r?.action,offset>=0?'block':undefined);a.equal(s().activeSince,0);
 }
 pass('softMs±1 / hardMs±1；长工具超过15分钟仍硬拦');
 await fresh({softMs:0});a.equal((await g.getConfig()).softMs,0);event('tool_call_requested',0);event('tool_execution_result',900001);a.equal(prompt(900001),undefined);a.equal(s().warned,false);
 pass('softMs=0: config=0, elapsed=900001ms, warned=false');
 await fresh({softMs:0,softCalls:1});event('tool_call_requested',0);a.equal(s().warnKind,'calls');
 await fresh({softMs:0,errRepeatLimit:1});event('tool_execution_error',0);a.equal(s().warnKind,'errors');
 pass('softMs=0 保留次数/失败提醒');
 await fresh({errRepeatLimit:1});event('tool_call_requested',0);event('tool_execution_error',300000);a.equal(s().warnKind,'errors');a.ok(prompt(300000).toolPrompt.includes(g.WARNING_ERRORS));a.equal(prompt(300001),undefined);event('tool_execution_result',400002);a.equal(prompt(400002),undefined);
 pass('errors+time 优先 errors；计数切窗后不重复注入');
 await fresh();event('tool_call_requested',0);event('tool_call_intercept',900001);a.equal(s().closingPending,true);a.equal(s().closingSent,false);a.ok(prompt(900001).toolPrompt.includes(g.CLOSING));a.equal(s().closingPending,false);a.equal(s().closingSent,true);event('tool_execution_result',900002);event('tool_call_intercept',1000003);const again=prompt(1000003);a.equal(again,undefined);event('tool_call_intercept',1000004);a.equal(prompt(1000004),undefined);
 pass('closingPending/closingSent: 硬拦置位、prompt 送达、不重复');
 a.ok([...g.WARNING_TIME].length<=60);pass('WARNING_TIME <=60 字');
 await g.flushEvents();console.log('v0.8 全部通过');
})().catch(e=>{console.error(e);process.exitCode=1;});
