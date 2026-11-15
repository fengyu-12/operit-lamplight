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
 await g.flushEvents();console.log('v0.8 全部通过');
})().catch(e=>{console.error(e);process.exitCode=1;});
