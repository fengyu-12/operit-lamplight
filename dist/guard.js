"use strict";
/// <reference path="../types/index.d.ts" />
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULTS = void 0;
exports.getConfig = getConfig;
exports.setConfig = setConfig;
exports.resetConfig = resetConfig;
exports.normalize = normalize;
exports.onChatMessage = onChatMessage;
exports.onToolLifecycle = onToolLifecycle;
exports.onToolPrompt = onToolPrompt;
exports.onSystemPrompt = onSystemPrompt;

exports.flushEvents = flushEvents;
exports.readStatus = readStatus;
exports.DEFAULTS = {
    softCalls: 8,
    softMs: 5 * 60000,
    errRepeatLimit: 3, // compatibility only; unsupported host event
    failWarnLimit: 3,
    failWarnScope: 'hard',
    hardCalls: 50,
    hardMs: 15 * 60000,
    repeatLimit: 3,
    idleResetMs: 80000,
    activeResetMs: 10 * 60000,
    hardBlock: true,
    adviceEnabled: true,
    warn: true,
};
const cfg = { ...exports.DEFAULTS };
const states = new Map();
const STATES_MAX = 8;
let lastChatId;
const recent = [];
const RECENT_MAX = 5;
// ===== v0.6.0：元工具白名单 =====
// 配置/状态工具只读写本地配置与计数器，不产生外部副作用；
// 它们若也被自身预算拦住，硬停后就无法自救（改配置也调不动）。
const EXEMPT_TOOLS = ['turn_guard_config', 'turn_guard_status'];
function isExemptTool(name) {
    const n = String(name || '');
    const tail = n.indexOf(':') >= 0 ? n.slice(n.lastIndexOf(':') + 1) : n;
    return EXEMPT_TOOLS.indexOf(tail) >= 0;
}
// ===== 配置化（v0.5.0）：阈值从 getConfigDir()/config.json 读，改完即时生效 =====
const CONFIG_FILE = 'config.json';
let configLoaded = false;
let configLoadPromise = null;
function clampConfig(raw) {
    if (!raw || typeof raw !== 'object')
        return {};
    const out = {};
    const nums = ['softCalls', 'softMs', 'hardCalls', 'hardMs', 'idleResetMs', 'activeResetMs', 'repeatLimit', 'errRepeatLimit', 'failWarnLimit'];
    for (const k of nums) {
        const v = raw[k];
        if (typeof v === 'number' && Number.isSafeInteger(v) && v >= (k === 'softMs' ? 0 : 1) && v <= 1e9)
            out[k] = v;
    }
    if (['hard', 'hard+fingerprint'].includes(raw.failWarnScope)) out.failWarnScope = raw.failWarnScope;
    const bools = ['hardBlock', 'warn', 'adviceEnabled'];
    for (const k of bools) {
        const v = raw[k];
        if (typeof v === 'boolean')
            out[k] = v;
    }
    return out;
}
function configPath() {
    const dir = ToolPkg.getConfigDir().replace(/\/$/, '');
    return dir + '/' + CONFIG_FILE;
}
/** 读配置文件并合并进内存态 cfg；缺字段用 DEFAULTS 兜底；文件不存在或坏则保持默认。 */
async function loadConfigOnce() {
    if (configLoaded)
        return;
    try {
        const path = configPath();
        const exists = await Tools.Files.exists(path);
        if (exists.exists && !exists.isDirectory) {
            const file = await Tools.Files.read(path);
            const parsed = JSON.parse(file.content);
            Object.assign(cfg, exports.DEFAULTS, clampConfig(parsed));
        }
    }
    catch {
        // 读取/解析失败：保留当前 cfg（已是 DEFAULTS），不抛出
    }
    finally {
        configLoaded = true;
    }
}
/** 懒加载保护：首次访问配置前确保已尝试读盘一次。 */
function ensureConfigLoaded() {
    if (!configLoadPromise)
        configLoadPromise = loadConfigOnce();
    return configLoadPromise;
}
/** 工具侧 get：返回当前生效配置（已读盘合并）。 */
async function getConfig() {
    await ensureConfigLoaded();
    return { ...cfg };
}
/** 工具侧 set：合并补丁、写盘、立即应用到内存态 cfg（无需重装/重启）。 */
async function setConfig(patch) {
    await ensureConfigLoaded();
    const clean = clampConfig(patch);
    try {
        const path = configPath();
        const exists = await Tools.Files.exists(path);
        const base = exists.exists ? clampConfig(JSON.parse((await Tools.Files.read(path)).content)) : {};
        const next = { ...exports.DEFAULTS, ...base, ...clean };
        const dir = ToolPkg.getConfigDir().replace(/\/$/, '');
        await Tools.Files.mkdir(dir, true);
        const result = await Tools.Files.write(configPath(), JSON.stringify(next, null, 2), false);
        if (!result.operation.successful)
            throw new Error('config write failed');
        const verified = { ...exports.DEFAULTS, ...clampConfig(JSON.parse((await Tools.Files.read(path)).content)) };
        if (Object.keys(next).some(k => verified[k] !== next[k])) throw new Error('config read-back mismatch');
        Object.assign(cfg, verified);
    }
    catch (e) {
        return { ok: false, config: { ...cfg }, error: e instanceof Error ? e.message : String(e) };
    }
    return { ok: true, config: { ...cfg } };
}
/** 恢复出厂默认，写盘并即时生效。 */
async function resetConfig() {
    const result = await setConfig(exports.DEFAULTS);
    if (!result.ok)
        throw new Error(result.error || 'config reset failed');
    return result.config;
}
function say(line) {
    recent.push(line);
    if (recent.length > RECENT_MAX)
        recent.shift();
    try {
        console.log(line);
    }
    catch { /* best effort */ }
}
/** 稳定序列化：递归排序对象键，循环引用记 [Circular]（移植自本机 dsh-turn-guard logic.js）。 */
function stableValue(v, seen) {
    if (v === null || typeof v === 'string' || typeof v === 'boolean')
        return v;
    if (typeof v === 'number')
        return Number.isFinite(v) ? v : String(v);
    if (typeof v !== 'object')
        return String(v);
    if (seen.has(v))
        return '[Circular]';
    seen.add(v);
    if (Array.isArray(v))
        return v.map((x) => stableValue(x, seen));
    return Object.fromEntries(Object.entries(v)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, x]) => [k, stableValue(x, seen)]));
}
/** FNV-1a 32 位短 hash（8 hex）。 */
function shortHash(s) {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i += 1) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(16).padStart(8, '0');
}
/** 工具签名：name + 稳定序列化后的 hash（比字符串替换更抗嵌套/哈希形态）。 */
function normalize(name, p = {}) {
    const serialized = JSON.stringify(stableValue(p, new WeakSet()));
    return name + ':' + shortHash(serialized);
}
function stateOf(chatId, now) {
    let s = states.get(chatId);
    lastChatId = chatId;
    if (!s) {
        s = { chatId, lastSender: '(unknown)', lastSenderAt: 0, activeSince: now, inFlight: [], requestedCall: null, windowStart: now, calls: 0, icCalls: 0, budgetCalls: 0, softBlockedTool: '', icRepeat: 0, icLastKey: '', warned: false, lastKey: '', repeat: 0, lastErr: '', errRepeat: 0, hardFailures: 0, failureFingerprint: '', failureKey: '', lastEventAt: now, lastBlockReason: '', exemptCalls: 0, warnKind: '' };
    }
    // Map insertion order tracks access without changing event/window timestamps.
    states.delete(chatId);
    states.set(chatId, s);
    if (states.size > STATES_MAX)
        states.delete(states.keys().next().value);
    return s;
}
/** 用户消息和 AI 回复均结束旧计数；未知来源仅更新诊断字段。 */
function onChatMessage(ev) {
    if (ev?.event !== 'message_persisted')
        return;
    const p = ev.eventPayload ?? {};
    const now = typeof ev.timestampMs === 'number' && Number.isFinite(ev.timestampMs) ? ev.timestampMs : Date.now();
    const chatId = typeof p.chatId === 'string' ? p.chatId : '(no-chat)';
    const normalizeSender = (value) => typeof value === 'string' ? value.trim().toLowerCase() : '';
    const sender = normalizeSender(p.sender);
    const roleName = normalizeSender(p.roleName);
    const boundary = ['user', 'human', '我', 'me', 'ai', 'assistant', 'bot', 'model', '助手'];
    // 保留既有 assistant 边界：若宿主持久化中途 assistant，pending 也会清零。
    // 尚无真实时序证据；此版不更改轮次语义，需设备日志另验。
    if (boundary.includes(sender) || boundary.includes(roleName))
        states.delete(chatId);
    const s = stateOf(chatId, now);
    s.lastSender = sender || roleName || '(unknown)';
    s.lastSenderAt = typeof p.timestamp === 'number' && Number.isFinite(p.timestamp) ? p.timestamp : now;
}
/** 计数窗口与活动墙钟解耦；在途调用不视为空闲，严格超过阈值才重置。 */
function rollWindow(s, now) {
    const gap = now - s.lastEventAt;
    if (s.inFlight.length)
        return;
    if (gap > Math.max(cfg.idleResetMs, cfg.activeResetMs)) {
        s.activeSince = now;
        s.warned = false;
        s.warnKind = '';
        s.lastBlockReason = '';
    }
    if (gap > cfg.idleResetMs) {
        s.windowStart = now;
        s.calls = 0;
        s.repeat = 0;
        s.errRepeat = 0;
        s.hardFailures = 0;
        s.failureFingerprint = '';
        s.failureKey = '';
        s.lastKey = '';
        s.lastErr = '';
        s.icCalls = 0;
        s.requestedCall = null;
        s.budgetCalls = 0;
        // Keep the soft-block exemption for delayed terminal events. A new request
        // clears it; resetting count/time windows must not turn a reminder into a failure.
        s.icRepeat = 0;
        s.icLastKey = '';
    }
}
function onToolLifecycle(ev) {
    ensureConfigLoaded().catch(() => { });
    const now = ev.timestampMs ?? Date.now();
    const p = ev.eventPayload ?? {};
    const chatId = p.runtimeContext?.chatId ?? '(no-chat)';
    const s = stateOf(chatId, now);
    rollWindow(s, now);
    s.lastEventAt = now;
    if (ev.event === 'tool_call_requested') {
        // 白名单工具不计入本轮调用数与重复判定：点几次设置页不该推高 softCalls
        if (!isExemptTool(p.toolName)) {
            const pendingKey = normalize(p.toolName ?? '', p.parameters);
            if (!s.inFlight.includes(pendingKey))
                s.inFlight.push(pendingKey);
            s.requestedCall = { toolName: p.toolName, key: pendingKey };
            s.failureKey = '';
            // A new attempt ends the soft-block result exemption, even if no terminal event arrived.
            s.softBlockedTool = '';
            s.calls += 1;
            const key = normalize(p.toolName ?? '', p.parameters);
            s.repeat = key === s.lastKey ? s.repeat + 1 : 1;
            s.lastKey = key;
        }
    }
    // result/error/finished 对同一签名幂等结束在途，兼容宿主终态事件组合。
    if (['tool_execution_result', 'tool_execution_error', 'tool_execution_finished'].includes(ev.event)) {
        const key = normalize(p.toolName ?? '', p.parameters);
        s.inFlight = s.inFlight.filter(k => k !== key);
        if (s.requestedCall?.key === key)
            s.requestedCall = null;
    }
    // A soft block returns as a host tool error, but no execution took place.
    // Match by tool name: intercept parameters is a schema, not the requested arguments.
    if (['tool_execution_result', 'tool_execution_error'].includes(ev.event) && !isExemptTool(p.toolName)
        && (!s.softBlockedTool || s.softBlockedTool !== String(p.toolName ?? ''))) {
        const errText = typeof p.errorMessage === 'string' ? p.errorMessage : '';
        const hard = p.timedOut === true || /not allowed|Invalid tool invocation|Cannot access|Path is not a file/i.test(errText)
            || errText.trim().length > 0 || ev.event === 'tool_execution_error';
        const key = normalize(p.toolName ?? '', p.parameters);
        const fingerprint = shortHash((p.timedOut === true ? 'timeout:' : '') + errText);
        // A result + error pair for the same in-flight call counts only once.
        if (hard) {
            if (s.failureKey !== key) {
                s.hardFailures = cfg.failWarnScope === 'hard+fingerprint' && s.failureFingerprint !== fingerprint ? 1 : s.hardFailures + 1;
                s.failureFingerprint = fingerprint;
                s.failureKey = key;
            }
        } else {
            s.hardFailures = 0;
            s.failureFingerprint = '';
            s.failureKey = '';
        }
    }
    let decision;
    if (ev.event === 'tool_call_intercept' && cfg.hardBlock) {
        if (isExemptTool(p.toolName)) {
            // 自救通道：不累加 icCalls/icRepeat，也不做任何拦截判定
            s.exemptCalls += 1;
        }
        else {
            // Associate the observed request with this intercept. Its parameters is a
            // schema, so repeated schemas alone cannot establish repeated arguments.
            const requested = s.requestedCall?.toolName === p.toolName ? s.requestedCall : null;
            s.requestedCall = null;
            const key = requested?.key ?? normalize(p.toolName ?? '', p.parameters);
            s.icCalls += 1;
            s.icRepeat = key === s.icLastKey ? s.icRepeat + 1 : 1;
            s.icLastKey = key;
            const hitRepeat = s.icRepeat >= cfg.repeatLimit;
            const hitBudget = s.budgetCalls + 1 >= cfg.hardCalls;
            const hitTime = now - s.activeSince >= cfg.hardMs;
            if (hitRepeat || hitBudget || hitTime) {
                s.budgetCalls += 1;
                s.lastBlockReason = hitRepeat ? '重复调用' : hitBudget ? '超出单轮工具调用预算' : '超出单轮时间预算';
                s.icRepeat = 0;
                decision = { action: 'block', reason: s.lastBlockReason + '，本次调用已拦截。请立即用一条用户可见回复说明：① 已验证结果 ② 未完成项 ③ 阻塞 ④ 可行下一步。不要再调用工具，不得伪称完成。' };
            }
            else {
                const reason = checkWarning(s, now);
                if (reason) {
                    // Count the attempt in calls/icCalls, but neither in the execution budget
                    // nor in the repeat streak. Retrying starts a fresh streak.
                    s.icRepeat = 0;
                    s.icLastKey = '';
                    s.softBlockedTool = String(p.toolName ?? '');
                    s.inFlight = s.inFlight.filter(k => k !== key);
                    decision = { action: 'block', reason };
                }
                else {
                    s.budgetCalls += 1;
                }
            }
        }
    }
    // 只记录实际拦截，不记录普通事件或原始 payload（可能携带凭证）。
    if (decision)
        recordEvent({ event: 'block', timestampMs: now, chatId,
            toolName: p.toolName ?? '', calls: s.calls, icCalls: s.icCalls,
            action: 'block', reason: decision.reason });
    return decision;
}
const SOFT_TAIL = '本次调用被拦下仅用于提醒，不是错误、不计失败。请先用一句用户可见的话说明当前进度（已确认什么 / 还在查什么），然后继续原任务；后续调用正常放行，不会再被这条提醒拦截。';
function checkWarning(s, now) {
    if (!cfg.hardBlock || !cfg.warn || s.warned) return;
    let text;
    if (s.calls >= cfg.softCalls) {
        s.warnKind = 'calls';
        text = `本轮已连续调用工具 ${s.calls} 次（阈值 ${cfg.softCalls}）。` + SOFT_TAIL;
    }
    else if (s.hardFailures >= cfg.failWarnLimit) {
        s.warnKind = 'errors';
        text = `检测到连续硬失败 ${s.hardFailures} 次（超时 / 权限 / 参数 / 执行异常）。本次调用被拦下仅用于提醒，不是新的错误。请先报告失败原因与已试路径，再决定是否换一次实质不同的做法；后续调用正常放行。`;
    }
    else if (cfg.softMs > 0 && now - s.activeSince >= cfg.softMs) {
        s.warnKind = 'time';
        text = `本轮已连续运行 ${Number(((now - s.activeSince) / 60000).toFixed(2))} 分钟（阈值 ${Number((cfg.softMs / 60000).toFixed(2))} 分钟）。` + SOFT_TAIL;
    }
    if (!text) return;
    s.warned = true;
    return '【软提醒 · 灯火阑珊】' + text;
}
// 兼容导出：宿主无轮内 prompt 注入点，不注册、不消费提醒。
function onToolPrompt() {}
// ===== 0.9.0：常驻收敛规则走 system prompt 层 =====
// 目的：绕过两个缺陷——① advice 必须 use_package 激活才进工具面；② toolPrompt 属低权限层。
// 特征：无状态（不读不写计数器）、幂等（比较并更新自有块），不会消费软提醒门闩。
const PERSISTENT_MARK = '【收敛规则 · 灯火阑珊】';
const PERSISTENT_END = '【收敛规则结束 · 灯火阑珊】';
/** 固定定性文本：阈值、计时开关与失败口径变化不改写 system 前缀。 */
function persistentAdvice() {
    return [
        PERSISTENT_MARK,
        '交付前先说明：已确认什么、还缺什么。',
        '连续工具调用较多或本轮耗时较久时，先给用户一句当前进度再继续原任务。',
        '连续硬失败时，先向用户说明失败原因与已试过的做法，再决定是否换一次实质不同的做法。',
        '同一工具同一参数反复调用视为原地打转，启用硬拦截时会按阻塞处理。',
        '启用硬拦截且达到调用或时长上限时，工具调用会被拒绝；请直接收尾并说明已验证结果、未完成项、阻塞与可行下一步。',
        '触发式软提醒仅用于提醒，不是错误；先报告进度，然后继续原任务，后续调用正常放行。',
        '具体阈值与开关见「灯火阑珊设置」。',
        '用户发来新消息即视为新一轮，重新计数。',
        PERSISTENT_END,
    ].join('\n');
}
/** 等待配置后组装；只替换带边界的自有块，兼容旧版无结束标记。 */
async function onSystemPrompt(ev) {
    await ensureConfigLoaded();
    if (!cfg.adviceEnabled)
        return;
    const base = ev.eventPayload?.systemPrompt ?? '';
    const block = persistentAdvice();
    const start = base.indexOf(PERSISTENT_MARK);
    let next;
    if (start >= 0) {
        const end = base.indexOf(PERSISTENT_END, start + PERSISTENT_MARK.length);
        const stop = end < 0 ? base.length : end + PERSISTENT_END.length;
        next = base.slice(0, start) + block + base.slice(stop);
    }
    else {
        next = base + '\n\n' + block;
    }
    if (next === base)
        return;
    return { systemPrompt: next };
}
// 触发时间线：内存最多 5 条；串行覆盖固定文件，不再按天清理。
let writeQueue = Promise.resolve();
const persistence = { written: 0, failed: 0, lastError: '', lastPath: '' };
function recordEvent(record) {
    say(JSON.stringify(record));
    const snapshot = recent.join('\n') + '\n';
    writeQueue = writeQueue.then(async () => {
        try {
            const dir = ToolPkg.getLocalDataDir().replace(/\/$/, '');
            const path = dir + '/turn_guard-timeline.jsonl';
            const made = await Tools.Files.mkdir(dir, true);
            if (!made.successful)
                throw new Error('log directory unavailable');
            const result = await Tools.Files.write(path, snapshot, false);
            if (!result.operation.successful)
                throw new Error('timeline write failed');
            persistence.written += 1;
            persistence.lastPath = path;
            persistence.lastError = '';
        }
        catch {
            persistence.failed += 1;
            persistence.lastError = 'JSONL 写入失败，recentEvents 保留最近 5 条';
        }
    });
}
/** Host wrapper awaits queued writes; core stays synchronous for event sequence tests. */
async function flushEvents() { await writeQueue; }
function readStatus() {
    return {
        phase: '1-warn+hard-block',
        persistence: { ...persistence },
        config: cfg,
        // 最近事件优先；相同时间按最近访问优先，最多保留 8 个聊天。
        chats: Array.from(states.values()).reverse().sort((a, b) => b.lastEventAt - a.lastEventAt).map(s => ({ ...s })),
        lastChatId,
        recentEvents: recent.slice(),
    };
}
