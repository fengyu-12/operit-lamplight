# 灯火阑珊 · Lamplight

> 给 AI 的单轮任务装一道收敛闸：该提醒时提醒，该拦住时拦住，并明确告诉它「现在该交付什么」。

名字取自「蓦然回首，那人却在灯火阑珊处」——热闹（疯狂调工具）散去的地方，才看得见人。硬拦发生后，AI 停下工具调用，回头把进度说清楚，而不是继续往前冲。

这是一个 [Operit](https://github.com/fengyu-12) 的 ToolPkg 插件，包 ID `com.nyan.turn_guard`。

---

## 它解决什么

AI 干长活会跑偏：同一个工具反复调、同一个错反复撞、一轮几十次调用还在原地打转。
本插件挂在工具生命周期钩子上做计数与判定，用六个可调阈值把「继续尝试」和「该收尾了」分开。

| 信号 | 默认值 | 触发后 |
|---|---|---|
| 调用次数 | 10 次 | 注入一次提醒 |
| 相同调用 | 同工具同参数连续 3 次 | **拦截本次调用** |
| 相同失败 | 同工具同参数连续失败 3 次 | 注入一次提醒 |
| 硬阈值 | 50 次调用 | **拦截本次调用** |
| 硬停时长 | 20 分钟 | **拦截本次调用** |
| 空闲重置 | 120 秒 | 静默超过即清零，视为新的一轮 |

判定分两层，互不干扰：软阈值负责「提个醒」，硬阈值负责「按停」。

### 两条提醒，按原因分开

- **调用较多** → 交付结果、补一次关键验证、换一次实质不同方案、报告阻塞，四选一
- **同工具同参数连续失败** → 仅可换一次实质不同方案，否则报告阻塞

原因不同，给的出路也不同。不会把「方法错了」说成「调得太多」。

### 拦住之后还给一条收尾指令

硬拦发生后，下一次请求会再注入一条：说明已验证结果、未完成项、阻塞及可行下一步；不要再调用工具，不得伪称完成。

拦截只负责停下，这条负责让它**说清楚停在哪**。

---

## 安装

**方式一：插件市场**（若已上架）

**方式二：手动导入**

1. 把 `.toolpkg` 放进 Operit 的 `extensions/device/packages/` 目录
2. 用 operit_editor 执行 `package import <路径>`，然后 `package enable turn_guard`
3. 或直接在 App 的「包管理」里导入

---

## 使用

打开插件的设置页，六个步进器（支持直接输入数字，保留 ± 微调）：

```
调用额度
  空闲重置      120 秒    静默超过该时长，本轮计数清零，视为新的一轮
  软阈值         10 次     本轮累计调用达到该次数，注入一次提醒
  硬阈值         50 次     本轮累计调用达到该次数，拒绝后续工具调用
  硬停时长       20 分钟   从本轮首次调用开始计时，到时拒绝工具调用

重复检测
  相同调用        3 次     同一工具、同一参数连续出现多少次，判定为原地打转
  相同失败        3 次     同一工具、同一参数连续报错多少次，判定当前做法没有进展
```

保存后立即生效，**不用重装，也不用重启 app**。另有两个开关：达到上限时是否拦截、接近阈值时是否提醒。

日志：单文件 `turn_guard-timeline.jsonl`，只记触发事件（提醒 / 拦截），覆盖写、最多留 5 条。

---

## 开发

要求 Node.js ≥ 18、TypeScript 5.x、Python 3（打包用）。

```bash
# 1. 编译（src/*.ts → dist/*.js）
npm i -g typescript
tsc -p tsconfig.json

# 2. 跑测试（五套，零依赖）
node test/test-v0.6.6.cjs
node test/test-v0.6.cjs
node test/test-v0.6.2.cjs
node test/test-v0.5-config.cjs
node test/test-v0.4.cjs

# 3. 打包
python3 tools/pack_toolpkg.py . artifacts/operit-lamplight.toolpkg
```

**注意两件事**：

1. `src/ui/settings/index.ui.js` 是**手写**的 Compose DSL 页面，不经过 tsc 编译。改动后要同步复制到 `dist/ui/settings/index.ui.js`，打包取的是 dist 那份。
2. `dist/` 已随仓库提供（省得别人先装 TypeScript 才能打包），但它**是构建产物**：改了 `src/*.ts` 必须重新 `tsc`，否则产物与源码不一致。

### 目录结构

```
manifest.json          包清单（toolpkg_id / version / display_name）
tsconfig.json          TS 编译配置
src/guard.ts           判定核心（纯逻辑，可脱离 Operit 单测）
src/main.ts            钩子与 UI 注册入口
src/tools.ts           两个工具：turn_guard_status / turn_guard_config
src/ui/settings/       设置页（手写 Compose DSL）
dist/                  构建产物
test/                  五套零依赖单测
tools/pack_toolpkg.py  打包脚本
```

---

## 已知限制

- **做不到强制结束回合**。Operit 的 prompt 钩子只能改提示内容，没有 stop/abort。所以守卫能做的上限是「封工具 + 喊收尾」，最终交不交付仍取决于模型本身。
- **AI 被拦后自救不了**。拦截生效期间连配置工具一起拦（有意如此，免得被绕过）。要放宽阈值请从设置页改——这条路不受拦截影响。
- **单计数器**。切换会话会清零本轮计数，所以它衡量的是「当前这一轮」，不是跨会话的长期统计。
- **不统计工具内部的嵌套调用**，只数模型直接发起的调用。

---

## 设计来源

收敛判定的思路参考了 DSH 生态的同名插件 turn-guard：
<https://github.com/xiaoxiao44443/dfy-dsh-plugins/tree/main/plugins/turn-guard>

代码为 Operit ToolPkg 运行时**重新实现**（TypeScript → CommonJS，钩子与 UI 均按 Operit 的 API 重写），未复用该项目源码。原项目以 MIT 许可发布，版权归 xiaoxiao44443 所有。

---

## License

MIT © 2026 fengyu-12
