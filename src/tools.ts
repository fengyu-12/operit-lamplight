/* METADATA
{
  "name": "turn_guard",
  "display_name": { "zh": "灯火阑珊", "en": "Turn Guard" },
  "description": {
    "zh": "对单轮任务做收敛判定：调用次数、同参重复、连续失败三路计数，超阈值时提醒或拦截，并按原因给出对应的收尾指令。",
    "en": "Convergence checks for a single turn: counts calls, repeated calls and repeated failures; warns or blocks past thresholds and issues a matching hand-off prompt."
  },
  "enabledByDefault": true,
  "category": "System",
  "tools": [
    {
      "name": "turn_guard_status",
      "display": { "label": { "zh": "灯火阑珊状态", "en": "Turn guard status" }, "icon": "info" },
      "description": {
        "zh": "返回当前计数器、配置与最近触发事件，用于排查「刚才为什么被拦」。",
        "en": "Returns current guard counters and last events (verification only, no side effects)."
      },
      "parameters": []
    },
    {
      "name": "turn_guard_config",
      "display": { "label": { "zh": "灯火阑珊配置", "en": "Turn guard config" }, "icon": "settings" },
      "description": {
        "zh": "读取或修改灯火阑珊阈值配置（softCalls/hardCalls/repeatLimit/errRepeatLimit/idleResetMs/hardMs；时间单位毫秒）。action=get 只读；action=set 需配 patch（部分字段即可，服务器端校验并立即生效）；action=reset 恢复默认值。",
        "en": "Read or update guard thresholds. action=get is read-only; action=set takes a partial patch, validated and applied immediately; action=reset restores defaults."
      },
      "parameters": [
        {
          "name": "action",
          "type": "string",
          "description": { "zh": "get / set / reset", "en": "get / set / reset" },
          "required": true
        },
        {
          "name": "patch",
          "type": "object",
          "description": {
            "zh": "action=set 时的部分字段补丁，如 {\"softCalls\":8}",
            "en": "Partial field patch for action=set, e.g. {\"softCalls\":8}"
          },
          "required": false
        }
      ]
    }
  ]
}
*/

import { readStatus, getConfig, setConfig, resetConfig } from './guard'

/** 返回当前计数器；供 package exec 验收，不产生副作用。 */
export async function turn_guard_status() {
  return readStatus()
}

/** 读写阈值配置：get 只读；set 接收部分字段补丁并立即生效；reset 恢复默认。 */
export async function turn_guard_config(args: { action?: string; patch?: Record<string, unknown> }) {
  const action = String(args?.action ?? 'get')
  if (action === 'get') {
    const config = await getConfig()
    return { ok: true, config, status: readStatus() }
  }
  if (action === 'set') {
    const result = await setConfig(args?.patch ?? {})
    return { ...result, status: readStatus() }
  }
  if (action === 'reset') {
    try {
      const config = await resetConfig()
      return { ok: true, config, status: readStatus() }
    } catch (e) { return { ok: false, error: String(e), config: await getConfig() } }
  }
  return { ok: false, error: "action 必须是 get / set / reset 之一", config: await getConfig() }
}
