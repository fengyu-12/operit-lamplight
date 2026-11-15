/// <reference path="../types/index.d.ts" />
import { onToolLifecycle, onToolPrompt, onSystemPrompt, onChatMessage, flushEvents, readStatus } from './guard'
import settingsScreen from './ui/settings/index.ui.js'

/** 工具生命周期钩子：必须是导出的具名函数引用（宿主硬约束，不能写内联箭头）。 */
export function turnGuardLifecycle(ev: any) {
  const result = onToolLifecycle(ev)
  Promise.resolve(flushEvents()).catch(() => { /* 落盘失败不影响判定 */ })
  return result
}

/** 提示组装钩子：同样必须是导出的具名函数引用。 */
export function turnGuardPrompt(ev: any) {
  const result = onToolPrompt(ev)
  Promise.resolve(flushEvents()).catch(() => { /* best effort */ })
  return result
}

/**
 * 系统提示组装钩子（0.9.0）：把常驻收敛规则写进 systemPrompt。
 * 选它而不选 advice 的原因：hook 注册即生效，不依赖 use_package 激活；且 systemPrompt 属高权限层。
 */
export function turnGuardSystemPrompt(ev: any) {
  return onSystemPrompt(ev)
}

/** 消息落盘通知：具名导出以供宿主定位。 */
export function turnGuardMessage(ev: ToolPkg.ChatMessageHookEvent) {
  return onChatMessage(ev)
}

/** Host 调用此函数完成注册；返回 true 表示注册成功。 */
export function registerToolPkg(): boolean {
  ToolPkg.registerChatMessageHook({ id: 'turn_guard_message', function: turnGuardMessage })
  ToolPkg.registerToolLifecycleHook({ id: 'turn_guard_lifecycle', function: turnGuardLifecycle })
  ToolPkg.registerToolPromptComposeHook({ id: 'turn_guard_prompt', function: turnGuardPrompt })
  ToolPkg.registerSystemPromptComposeHook({ id: 'turn_guard_system_prompt', function: turnGuardSystemPrompt })
  ToolPkg.registerUiRoute({
    id: 'turn_guard_settings',
    runtime: 'compose_dsl',
    screen: settingsScreen,
    params: {},
    title: { zh: '灯火阑珊设置', en: 'Turn Guard Settings' },
  })
  ToolPkg.registerNavigationEntry({
    id: 'turn_guard_settings_entry',
    route: 'toolpkg:com.nyan.turn_guard:ui:turn_guard_settings',
    surface: 'main_sidebar_plugins',
    title: { zh: '灯火阑珊', en: 'Turn Guard' },
    icon: 'security',
    order: 30,
  })
  return true
}

/** 供 package exec 验收用：返回当前计数器与最近事件。 */
export function status() {
  return readStatus()
}
