/// <reference path="../../types/index.d.ts" />

// 灯火阑珊核心判定：拦截独立计数，软提醒通过 prompt hook 注入。
// 纯逻辑，可脱离 Operit 用 node 单测。

export interface GuardConfig {
  softCalls: number
  errRepeatLimit: number
  hardCalls: number
  hardMs: number
  idleResetMs: number
  repeatLimit: number
  hardBlock: boolean
  warn: boolean
}

export const DEFAULTS: GuardConfig = {
  softCalls: 10,
  errRepeatLimit: 3,
  hardCalls: 50,
  hardMs: 20 * 60_000,
  repeatLimit: 3,
  idleResetMs: 120000,
  hardBlock: true,
  warn: true,
}

interface Ev {
  event: string
  eventPayload?: {
    runtimeContext?: { chatId?: string | null; participantId?: string | null; executionData?: unknown } | null
    success?: boolean
    errorMessage?: string
    toolName?: string
    parameters?: Record<string, string>
  }
  timestampMs?: number
}

interface State {
  chatId: string
  windowStart: number
  calls: number
  icCalls: number
  icRepeat: number
  icLastKey: string
  warningPending: boolean
  warned: boolean
  lastKey: string
  repeat: number
  lastErr: string
  errRepeat: number
  lastEventAt: number
  exemptCalls: number
  lastBlockReason: string
  warnKind: string
  closingPending: boolean
  closingSent: boolean
}

const cfg: GuardConfig = { ...DEFAULTS }
let state: State | undefined
let lastChatId: string | undefined
const recent: string[] = []
const RECENT_MAX = 5

// ===== v0.6.0：元工具白名单 =====
// 配置/状态工具只读写本地配置与计数器，不产生外部副作用；
// 它们若也被自身预算拦住，硬停后就无法自救（改配置也调不动）。
const EXEMPT_TOOLS = ['turn_guard_config', 'turn_guard_status'];
function isExemptTool(name: string | undefined) {
    const n = String(name || '');
    const tail = n.indexOf(':') >= 0 ? n.slice(n.lastIndexOf(':') + 1) : n;
    return EXEMPT_TOOLS.indexOf(tail) >= 0;
}
// ===== 配置化（v0.5.0）：阈值从 getConfigDir()/config.json 读，改完即时生效 =====

const CONFIG_FILE = 'config.json'
let configLoaded = false
let configLoadPromise: Promise<void> | null = null

function clampConfig(raw: Partial<GuardConfig> | null | undefined): Partial<GuardConfig> {
  if (!raw || typeof raw !== 'object') return {}
  const out: Partial<GuardConfig> = {}
  const nums: Array<keyof GuardConfig> = ['softCalls', 'hardCalls', 'hardMs', 'idleResetMs', 'repeatLimit', 'errRepeatLimit']
  for (const k of nums) {
    const v = (raw as Record<string, unknown>)[k]
    if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 1 && v <= 1e9) (out as Record<string, number>)[k] = v
  }
  const bools: Array<keyof GuardConfig> = ['hardBlock', 'warn']
  for (const k of bools) {
    const v = (raw as Record<string, unknown>)[k]
    if (typeof v === 'boolean') (out as Record<string, boolean>)[k] = v
  }
  return out
}

function configPath(): string {
  const dir = ToolPkg.getConfigDir().replace(/\/$/, '')
  return dir + '/' + CONFIG_FILE
}

/** 读配置文件并合并进内存态 cfg；缺字段用 DEFAULTS 兜底；文件不存在或坏则保持默认。 */
async function loadConfigOnce(): Promise<void> {
  if (configLoaded) return
  try {
    const path = configPath()
    const exists = await Tools.Files.exists(path)
    if (exists.exists && !exists.isDirectory) {
      const file = await Tools.Files.read(path)
      const parsed = JSON.parse(file.content)
      Object.assign(cfg, DEFAULTS, clampConfig(parsed))
    }
  } catch {
    // 读取/解析失败：保留当前 cfg（已是 DEFAULTS），不抛出
  } finally {
    configLoaded = true
  }
}

/** 懒加载保护：首次访问配置前确保已尝试读盘一次。 */
function ensureConfigLoaded(): Promise<void> {
  if (!configLoadPromise) configLoadPromise = loadConfigOnce()
  return configLoadPromise
}

/** 工具侧 get：返回当前生效配置（已读盘合并）。 */
export async function getConfig(): Promise<GuardConfig> {
  await ensureConfigLoaded()
  return { ...cfg }
}

/** 工具侧 set：合并补丁、写盘、立即应用到内存态 cfg（无需重装/重启）。 */
export async function setConfig(patch: Partial<GuardConfig>): Promise<{ ok: boolean; config: GuardConfig; error?: string }> {
  await ensureConfigLoaded()
  const clean = clampConfig(patch)
  const next: GuardConfig = { ...cfg, ...clean }
  try {
    const dir = ToolPkg.getConfigDir().replace(/\/$/, '')
    await Tools.Files.mkdir(dir, true)
    const result = await Tools.Files.write(configPath(), JSON.stringify(next, null, 2), false)
    if (!result.operation.successful) throw new Error('config write failed')
  } catch (e) {
    return { ok: false, config: { ...cfg }, error: e instanceof Error ? e.message : String(e) }
  }
  Object.assign(cfg, next) // 立即生效：所有判定都读这同一个 cfg 对象
  return { ok: true, config: { ...cfg } }
}

/** 恢复出厂默认，写盘并即时生效。 */
export async function resetConfig(): Promise<GuardConfig> {
  const result = await setConfig(DEFAULTS)
  if (!result.ok) throw new Error(result.error || 'config reset failed')
  return result.config
}

function say(line: string) {
  recent.push(line)
  if (recent.length > RECENT_MAX) recent.shift()
  try { console.log(line) } catch { /* best effort */ }
}

/** 稳定序列化：递归排序对象键，循环引用记 [Circular]（移植自本机 dsh-turn-guard logic.js）。 */
function stableValue(v: unknown, seen: WeakSet<object>): unknown {
  if (v === null || typeof v === 'string' || typeof v === 'boolean') return v
  if (typeof v === 'number') return Number.isFinite(v) ? v : String(v)
  if (typeof v !== 'object') return String(v)
  if (seen.has(v as object)) return '[Circular]'
  seen.add(v as object)
  if (Array.isArray(v)) return v.map((x) => stableValue(x, seen))
  return Object.fromEntries(Object.entries(v as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, x]) => [k, stableValue(x, seen)]))
}

/** FNV-1a 32 位短 hash（8 hex）。 */
function shortHash(s: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, '0')
}

/** 工具签名：name + 稳定序列化后的 hash（比字符串替换更抗嵌套/哈希形态）。 */
export function normalize(name: string, p: Record<string, string> = {}): string {
  const serialized = JSON.stringify(stableValue(p, new WeakSet()))
  return name + ':' + shortHash(serialized)
}

function stateOf(chatId: string, now: number): State {
  if (!state || lastChatId !== chatId) {
    lastChatId = chatId
    state = { chatId, windowStart: now, calls: 0, icCalls: 0, icRepeat: 0, icLastKey: '', warningPending: false, warned: false, lastKey: '', repeat: 0, lastErr: '', errRepeat: 0, lastEventAt: now, lastBlockReason: '', exemptCalls: 0, warnKind: '', closingPending: false, closingSent: false }
  }
  const s = state
  return s
}

/** 无 turn id 时，同 chat 严格空闲超过 120 秒即重置；持续活动不固定切窗。 */
function rollWindow(s: State, now: number) {
  if (now - s.lastEventAt > cfg.idleResetMs) {
    s.windowStart = now; s.calls = 0; s.warned = false; s.warnKind = ''
    s.repeat = 0; s.errRepeat = 0; s.lastKey = ''; s.lastErr = ''
    s.icCalls = 0; s.icRepeat = 0; s.icLastKey = ''
    s.warningPending = false; s.lastBlockReason = ''
    s.closingPending = false; s.closingSent = false
  }
}

export function onToolLifecycle(ev: Ev): { action: 'allow' | 'block'; reason?: string } | void {
  ensureConfigLoaded().catch(() => { /* best effort，用默认值先判一次 */ })
  const now = ev.timestampMs ?? Date.now()
  const p = ev.eventPayload ?? {}
  const chatId = p.runtimeContext?.chatId ?? '(no-chat)'
  const s = stateOf(chatId, now)
  rollWindow(s, now)
  s.lastEventAt = now

    if (ev.event === 'tool_call_requested') {
        // 白名单工具不计入本轮调用数与重复判定：点几次设置页不该推高 softCalls
        if (!isExemptTool(p.toolName)) {
            s.calls += 1;
            const key = normalize(p.toolName ?? '', p.parameters);
            s.repeat = key === s.lastKey ? s.repeat + 1 : 1;
            s.lastKey = key;
        }
    }
    // 成功结果立即打断失败链；错误结果不能冒充成功。
    if (ev.event === 'tool_execution_result' && p.success !== false && !p.errorMessage) {
        s.errRepeat = 0;
        s.lastErr = '';
    }
    if (ev.event === 'tool_execution_error') {
        const err = normalize(p.toolName ?? '', p.parameters);
        s.errRepeat = err === s.lastErr ? s.errRepeat + 1 : 1;
        s.lastErr = err;
    }
    checkWarning(s, now);
    let decision: { action: 'block'; reason: string } | undefined;
    if (ev.event === 'tool_call_intercept' && cfg.hardBlock) {
        if (isExemptTool(p.toolName)) {
            // 自救通道：不累加 icCalls/icRepeat，也不做任何拦截判定
            s.exemptCalls += 1;
        }
        else {
            const key = normalize(p.toolName ?? '', p.parameters);
            s.icCalls += 1;
            s.icRepeat = key === s.icLastKey ? s.icRepeat + 1 : 1;
            s.icLastKey = key;
            const hitRepeat = s.icRepeat >= cfg.repeatLimit;
            const hitBudget = s.icCalls >= cfg.hardCalls;
            const hitTime = now - s.windowStart >= cfg.hardMs;
            if (hitRepeat || hitBudget || hitTime) {
                s.lastBlockReason = hitRepeat ? '重复调用' : hitBudget ? '超出单轮工具调用预算' : '超出单轮时间预算';
                s.icRepeat = 0;
                if (!s.closingSent) s.closingPending = true;
                decision = { action: 'block', reason: s.lastBlockReason + '，本次调用已拦截。停止工具，直接回复用户：已验证结果、未完成项及阻塞；未验证内容不得当作完成。' };
            }
        }
    }
  // 只记录实际拦截，不记录普通事件或原始 payload（可能携带凭证）。
  if (decision) recordEvent({ event: 'block', timestampMs: now, chatId,
    toolName: p.toolName ?? '', calls: s.calls, icCalls: s.icCalls,
    action: 'block', reason: decision.reason })
  return decision
}

export const WARNING = '调用较多：交付结果、补一次关键验证、换一次实质不同方案、报告阻塞，四选一；继续前说明缺什么及结果如何改变下一步。'
export const CLOSING = '立即用一条用户可见回复说明：已验证结果、未完成项、阻塞及可行下一步。不要再调用工具，不得伪称完成，无需添加“任务完成”结语。'
export const WARNING_ERRORS = '同工具同参数已连续失败：仅可换一次实质不同方案，否则报告阻塞；最近两次调用均无进展时，停止工具并直接回复用户。'

function checkWarning(s: State, now: number) {
  // 软提醒只看两个信号：本轮调用次数、同一「工具+参数」连续失败次数。时间维度已移除。
  // 触发原因记进 state，注入时用对应文案，避免「一直报错」被说成「调用太多」。
  if (!cfg.warn || s.warned) return
  if (s.calls >= cfg.softCalls) {
    s.warned = true; s.warningPending = true; s.warnKind = 'calls'
  } else if (s.errRepeat >= cfg.errRepeatLimit) {
    s.warned = true; s.warningPending = true; s.warnKind = 'errors'
  }
}

export function onToolPrompt(ev: ToolPkg.ToolPromptComposeHookEvent): ToolPkg.PromptHookObjectResult | void {
  const p = ev.eventPayload
  if (!p.chatId) return
  const s = stateOf(p.chatId, ev.timestampMs ?? Date.now())
  const now = ev.timestampMs ?? Date.now()
  rollWindow(s, now)
  checkWarning(s, now)
  if (s.closingPending && !s.closingSent) {
    s.closingPending = false; s.closingSent = true
    return { toolPrompt: (p.toolPrompt ?? '') + '\n' + CLOSING }
  }
  if (!s.warningPending) return
  s.warningPending = false
  const text = s.warnKind === 'errors' ? WARNING_ERRORS : WARNING
  recordEvent({ event: 'soft_warning', timestampMs: now, chatId: s.chatId, text })
  return { toolPrompt: (p.toolPrompt ?? '') + '\n' + text }
}

// 触发时间线：内存最多 5 条；串行覆盖固定文件，不再按天清理。
let writeQueue: Promise<void> = Promise.resolve()
const persistence = { written: 0, failed: 0, lastError: '', lastPath: '' }

function recordEvent(record: { event: 'soft_warning' | 'block'; [key: string]: unknown }) {
  say(JSON.stringify(record))
  const snapshot = recent.join('\n') + '\n'
  writeQueue = writeQueue.then(async () => {
    try {
      const dir = ToolPkg.getLocalDataDir().replace(/\/$/, '')
      const path = dir + '/turn_guard-timeline.jsonl'
      const made = await Tools.Files.mkdir(dir, true)
      if (!made.successful) throw new Error('log directory unavailable')
      const result = await Tools.Files.write(path, snapshot, false)
      if (!result.operation.successful) throw new Error('timeline write failed')
      persistence.written += 1
      persistence.lastPath = path
      persistence.lastError = ''
    } catch {
      persistence.failed += 1
      persistence.lastError = 'JSONL 写入失败，recentEvents 保留最近 5 条'
    }
  })
}

/** Host wrapper awaits queued writes; core stays synchronous for event sequence tests. */
export async function flushEvents(): Promise<void> { await writeQueue }

export function readStatus() {
  return {
    phase: '1-warn+hard-block',
    persistence: { ...persistence },
    config: cfg,
    // 兼容现有状态消费者；此数组最多一个元素，不保存历史会话。
    chats: state ? [{ ...state }] : [],
    lastChatId,
    recentEvents: recent.slice(),
  }
}
