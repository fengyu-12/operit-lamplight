const a = require('node:assert/strict');
const metadataSource = require('node:fs').readFileSync(require('node:path').join(__dirname, '../dist/tools.js'), 'utf8');
a.match(metadataSource, /"name"\s*:\s*"directive_converge"\s*,\s*"advice"\s*:\s*true/);
console.log('PASS directive_converge advice:true in built METADATA');
global.ToolPkg = {getConfigDir:()=>'/mock/config',getLocalDataDir:()=>'/mock/data'};
global.Tools = {Files:{exists:async()=>({exists:false}),mkdir:async()=>({successful:true}),write:async()=>({operation:{successful:true}})}};
const g = require('../dist/guard.js');
let chat=0;
const s=()=>g.readStatus().chats.find(s=>s.chatId===String(chat));
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
 for (const text of [g.WARNING,g.WARNING_ERRORS,g.WARNING_TIME]) {a.ok(text.includes('不要静默继续'));a.ok([...text].length<=60);}
 pass('三条文案均含不要静默继续且 <=60 字');
 a.ok(g.WARNING.includes('当前进度'));pass('次数文案含当前进度');
 a.ok(g.WARNING_ERRORS.includes('尚未查明'));pass('失败文案含尚未查明');
 await fresh({softMs:0});const chatA=chat;
 for(let i=0;i<3;i++){event('tool_call_requested',100+i*2);event('tool_execution_result',101+i*2);}
 await fresh({softMs:0});event('tool_call_requested',106);event('tool_execution_result',107);
 a.equal(s().calls,1);chat=chatA;prompt(108);a.equal(s().calls,3);
 pass('多聊天隔离: chatA 3 次 → chatB 1 次 → chatA calls=3');
 const touch=(id,t)=>g.onToolLifecycle({event:'tool_execution_finished',timestampMs:t,eventPayload:{runtimeContext:{chatId:id}}});
 for(let i=0;i<8;i++)touch('lru-'+i,200+i);
 touch('lru-0',208);touch('lru-new',209);
 a.equal(g.readStatus().chats.length,8);a.ok(g.readStatus().chats.some(s=>s.chatId==='lru-0'));a.ok(!g.readStatus().chats.some(s=>s.chatId==='lru-1'));
 a.deepEqual(g.readStatus().chats.map(s=>s.lastEventAt),g.readStatus().chats.map(s=>s.lastEventAt).sort((a,b)=>b-a));
 a.equal(g.readStatus().lastChatId,'lru-new');pass('Map 上限8、最近访问淘汰、状态降序及 lastChatId');
 touch(null,210);a.equal(g.readStatus().chats[0].chatId,'(no-chat)');pass('(no-chat) 独立状态桶');
 const message=(payload,t=110)=>g.onChatMessage({event:'message_persisted',timestampMs:t,eventPayload:{chatId:String(chat),...payload}});
 const three=async()=>{await fresh({warn:false,hardBlock:false});for(let i=0;i<3;i++){event('tool_call_requested',100+i*2);event('tool_execution_result',101+i*2);}a.equal(s().calls,3);};
 await three();message({sender:'user',timestamp:109});a.equal(s().calls,0);a.equal(s().lastSender,'user');a.equal(s().lastSenderAt,109);
 pass('轮次边界 用户消息清零: calls=0');
 await three();message({sender:'assistant'});a.equal(s().calls,0);
 pass('轮次边界 AI 回复清零: calls=0');
 await three();const before=s();for(const payload of [{sender:'system'},{},{sender:42,roleName:null}]){message(payload);a.equal(s().calls,3);a.equal(s().activeSince,before.activeSince);a.equal(s().lastEventAt,before.lastEventAt);}a.equal(s().lastSender,'(unknown)');a.equal(s().lastSenderAt,110);
 pass('轮次边界 未知或缺失 sender 不误清: calls=3');
 await three();const boundaryChat=chat;await fresh();event('tool_call_requested',108);chat=boundaryChat;prompt(109);a.equal(s().calls,3);
 pass('轮次边界 切会话不清零: chatA calls=3');chat=boundaryChat+1;
 await three();event('tool_call_requested',600106);a.equal(s().calls,1);a.equal(s().activeSince,600106);
 pass('轮次边界 10 分钟断档仍清零: calls=1');
 await three();message({roleName:'user'});a.equal(s().calls,0);
 pass('轮次边界 roleName=user 清零: calls=0');
 for(const source of [' User ','HUMAN','我',' Me ','AI',' Assistant ','BOT','model','助手']){await three();message({sender:source});a.equal(s().calls,0);a.equal(s().lastSender,source.trim().toLowerCase());}
 await three();message({sender:'system',roleName:' Assistant '});a.equal(s().calls,0);
 message({chatId:undefined,sender:'user'});a.equal(g.readStatus().chats.find(s=>s.chatId==='(no-chat)').calls,0);a.ok(g.readStatus().chats.length<=8);
 pass('轮次边界 全部别名、大小写空白、roleName 后备及 no-chat');

 // Fresh transpileModule + VM instances ensure no earlier get/set masks cold start.
 const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
 const ts = require('typescript');
 const compile = name => ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src', name), 'utf8'), {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText;
 const guardCode = compile('guard.ts');
 function isolated(files) {
   const exports = {};
   vm.runInNewContext(guardCode, {exports, console, ToolPkg:{getConfigDir:()=>'/mock/config'}, Tools:{Files:files}});
   return exports;
 }
 const sys = (mod, base='BASE') => mod.onSystemPrompt({eventPayload:{systemPrompt:base}});
 let resolveExists, resolveRead, readStarted;
 const reading = new Promise(r=>readStarted=r);
 const cold = isolated({exists:()=>new Promise(r=>resolveExists=r),read:()=>new Promise(r=>{resolveRead=r;readStarted();})});
 let settled=false;
 const first=sys(cold).then(r=>{settled=true;return r;});
 await Promise.resolve();a.equal(settled,false);
 resolveExists({exists:true});await reading;a.equal(settled,false);
 resolveRead({content:'{"softCalls":2}'});
 a.match((await first).systemPrompt,/达到 2 次/);
 pass('M1 cold delayed exists/read: first softCalls=2');
 for (const failure of ['exists','read','parse']) {
   const broken=isolated({exists:async()=>{if(failure==='exists')throw Error('disk');return {exists:true};},read:async()=>{if(failure==='read')throw Error('disk');return {content:'{'};}});
   a.match((await sys(broken)).systemPrompt,/达到 8 次/);
 }
 pass('M1 disk/parse failures: defaults without rejection');
 await fresh();const original=(await sys(g)).systemPrompt;
 a.equal(await sys(g,original),undefined);
 a.equal((await sys(g)).systemPrompt,original);
 await g.setConfig({softCalls:2});
 const updated=(await sys(g,original+'\nAFTER')).systemPrompt;
 a.equal(updated.split('【收敛规则 · 灯火阑珊】').length-1,1);
 a.match(updated,/达到 2 次/);a.doesNotMatch(updated,/达到 9999 次，先给用户/);a.ok(updated.endsWith('\nAFTER'));
 const legacy=(await sys(g,'BEFORE\n【收敛规则 · 灯火阑珊】\nlegacy stale')).systemPrompt;
 a.ok(legacy.startsWith('BEFORE\n'));a.doesNotMatch(legacy,/legacy stale/);
 pass('S1 identical base idempotent; stale/legacy block replaced, surrounding text preserved');
 await fresh({adviceEnabled:false,warn:true});a.equal(await sys(g),undefined);
 await g.setConfig({adviceEnabled:true,warn:false,softCalls:2});a.match((await sys(g)).systemPrompt,/达到 2 次/);
 event('tool_call_requested',0);event('tool_call_requested',1);a.equal(prompt(2),undefined);
 let disk='{}';const files={exists:async()=>({exists:true}),read:async()=>({content:disk}),mkdir:async()=>({successful:true}),write:async(p,text)=>{disk=text;return {operation:{successful:true}};}};
 const persisted=isolated(files);a.equal((await persisted.setConfig({adviceEnabled:false})).ok,true);
 a.equal(JSON.parse(disk).adviceEnabled,false);a.equal((await isolated(files).getConfig()).adviceEnabled,false);
 a.equal((await g.setConfig({adviceEnabled:'false'})).config.adviceEnabled,true);
 pass('S3 independent switches + persisted false survives fresh module; invalid value ignored');
 await fresh({hardBlock:false,warn:false,hardCalls:1,hardMs:1,softMs:90000});
 const exact=(await sys(g)).systemPrompt;
 a.match(exact,/1 分 30 秒/);a.match(exact,/0\.001 秒/);a.doesNotMatch(exact,/会收到|强制收尾/);
 event('tool_call_requested',0);a.equal(event('tool_call_intercept',2),undefined);a.equal(prompt(2),undefined);a.equal(s().closingPending,false);
 pass('S2/S4 no forced promise or action; 90000ms=1分30秒, 1ms=0.001秒');
 await fresh({errRepeatLimit:3});
 const failureRule=(await sys(g)).systemPrompt;a.match(failureRule,/先向用户说明失败原因与已试过的做法；再决定是否换一次实质不同的做法/);
 for(let i=0;i<3;i++)event('tool_execution_error',i);
 a.match(prompt(3).toolPrompt,/停止工具调用/);
 pass('S5 failure rule reports first; WARNING_ERRORS still stops tools');
 const mainExports={};let registered;
 const host=new Proxy({registerSystemPromptComposeHook:o=>{registered=o.function;}},{get:(o,k)=>o[k]||(()=>{})});
 vm.runInNewContext(compile('main.ts'),{exports:mainExports,ToolPkg:host,require:name=>name==='./guard'?g:{default:()=>{}},console});
 mainExports.registerToolPkg();a.equal(registered,mainExports.turnGuardSystemPrompt);
 const wrapped=registered({eventPayload:{systemPrompt:'BASE'}});a.equal(typeof wrapped.then,'function');await wrapped;
 pass('M1/S6 registered turnGuardSystemPrompt returns thenable');
 await g.flushEvents();console.log('v0.8 全部通过');
})().catch(e=>{console.error(e);process.exitCode=1;});
