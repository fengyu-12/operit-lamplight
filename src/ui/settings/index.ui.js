"use strict";
// 灯火阑珊 · 设置页（Compose DSL）
// 布局：开关卡（硬停/提醒）→ 阈值卡（七个数值步进器：次数×3 + 秒/分钟×3）→
//       操作行（保存/恢复默认/重置计数）→ 最近事件卡（折叠，调试用）。
// 设计取舍见文件末尾注释。

function __operit_render_compose_dsl(ctx) {
    return Screen(ctx);
}

// 步进幅度：次数类阈值按 1 步进，毫秒类阈值按常用档位步进（避免用户手搓毫秒数）。
var STEP = {
    softCalls: 1,
    softMsMin: 1,
    activeResetMsMin: 1,       // 软提醒时长按“分钟”步进，存储仍是毫秒
    hardCalls: 5,
    repeatLimit: 1,
    idleResetMsSec: 10, // 对 idleResetMs 按“秒”步进，UI 展示为秒，存储仍是毫秒
    errRepeatLimit: 1,  // 相同失败：同一工具+参数连续出错多少次算重复
    hardMsMin: 5        // 硬停时长按“分钟”步进，存储仍是毫秒
};

function clampInt(v, min, fallback) {
    var n = Math.floor(Number(v));
    if (!Number.isFinite(n)) return fallback;
    return n < min ? min : n;
}


/** 递归解包：兼容对象 / JSON 字符串 / 带前缀文本（"Tool: x
Success: true
{...}"）/ 多层包装。 */
function deepUnwrap(v, depth) {
    depth = depth || 0;
    if (depth > 8) return v;
    if (typeof v === "string") {
        var t = v.trim();
        if (!t) return v;
        var first = t.charAt(0);
        // 1) 本身就是 JSON
        if (first === "{" || first === "[" || first === '"') {
            try { return deepUnwrap(JSON.parse(t), depth + 1); } catch (e) { /* 继续 */ }
        }
        // 2) 从带前缀的文本里抠出最后一个 JSON 对象（exec 输出会在 JSON 前带 Tool/Success 两行）
        var i = t.indexOf("{");
        var j = t.lastIndexOf("}");
        if (i >= 0 && j > i) {
            try { return deepUnwrap(JSON.parse(t.slice(i, j + 1)), depth + 1); } catch (e) { /* 继续 */ }
        }
        return v;
    }
    if (v && typeof v === "object") {
        if (v.ok === false || v.success === false || v.successful === false) return v;
        // 3) 宿主结果包装：{__type:'StringResultData', value:'...'}
        if (v.__type !== undefined && v.value !== undefined) return deepUnwrap(v.value, depth + 1);
        var key = null;
        if (v.content !== undefined) key = "content";
        else if (v.body !== undefined) key = "body";
        else if (v.text !== undefined) key = "text";
        else if (v.result !== undefined) key = "result";
        else if (v.payload !== undefined) key = "payload";
        if (key) return deepUnwrap(v[key], depth + 1);
        if (v.data !== undefined) return deepUnwrap(v.data, depth + 1);
    }
    return v;
}

function checkedResult(raw) {
    var res = deepUnwrap(raw);
    if (!res || res.ok !== true || !res.config || typeof res.config.hardBlock !== "boolean" || typeof res.config.warn !== "boolean")
        throw new Error(res && res.error ? res.error : "配置响应无效或操作失败");
    return res;
}
function positiveInt(value, allowZero) {
    var text = String(value);
    var n = Number(text);
    if (!/^\d+$/.test(text) || !Number.isSafeInteger(n) || n < (allowZero ? 0 : 1) || n > Number.MAX_SAFE_INTEGER / 1000)
        throw new Error("阈值必须为范围内的正整数");
    return n;
}

async function Screen(ctx) {
    // ===== 状态读取（首次挂载 + 刷新按钮 + 保存后）=====
    var statusPair = ctx.useState("status", null);
    var loadingPair = ctx.useState("loading", true);
    var errorPair = ctx.useState("error", "");
    var savingPair = ctx.useState("saving", false);
    var showEventsPair = ctx.useState("showEvents", false);
    var bootedPair = ctx.useState("booted", false);

    var status = { value: statusPair[0], set: statusPair[1] };
    var loading = { value: loadingPair[0], set: loadingPair[1] };
    var error = { value: errorPair[0], set: errorPair[1] };
    var saving = { value: savingPair[0], set: savingPair[1] };
    var showEvents = { value: showEventsPair[0], set: showEventsPair[1] };

    // 草稿态：用户在界面上调整但还没点“保存”的值。首次拿到 status 后用它填充草稿。
    var draftPair = ctx.useState("draft", null);
    var draft = { value: draftPair[0], set: draftPair[1] };

    function fillDraftFrom(cfg) {
        return {
            activeResetMsMin: Math.round((cfg.activeResetMs || 600000) / 60000),
            softCalls: cfg.softCalls,
            softMsMin: Math.round((cfg.softMs == null ? 300000 : cfg.softMs) / 60000),
            hardCalls: cfg.hardCalls,
            repeatLimit: cfg.repeatLimit,
            idleResetMsSec: Math.round((cfg.idleResetMs || 120000) / 1000),
            errRepeatLimit: Math.round(cfg.errRepeatLimit || 3),
            hardMsMin: Math.round((cfg.hardMs || 1200000) / 60000),
            hardBlock: !!cfg.hardBlock,
            adviceEnabled: cfg.adviceEnabled !== false,
            warn: !!cfg.warn
        };
    }

    async function refresh() {
        loading.set(true);
        try {
            var raw = await ctx.callTool("turn_guard:turn_guard_config", { action: "get" });
            var res = checkedResult(raw);
            var cfg = (res && res.config) ? res.config : res;
            status.set(res && res.status ? res.status : { config: cfg });
            if (!draft.value) draft.set(fillDraftFrom(cfg));
            error.set("");
        } catch (e) {
            error.set("读取配置失败：" + (e && e.message ? e.message : String(e)));
        } finally {
            loading.set(false);
        }
    }

    if (!bootedPair[0]) {
        bootedPair[1](true);
        // 首屏非阻塞拉取，避免打开设置页卡顿。
        setTimeout(function () { refresh(); }, 0);
    }

    var cfgNow = (status.value && status.value.config) ? status.value.config
        : (status.value || {});

    async function save() {
        if (!draft.value) return;
        saving.set(true);
        try {
            var d = draft.value;
            var patch = {
                activeResetMs: positiveInt(d.activeResetMsMin) * 60000,
                softCalls: positiveInt(d.softCalls),
                softMs: positiveInt(d.softMsMin, true) * 60000,
                hardCalls: positiveInt(d.hardCalls),
                repeatLimit: positiveInt(d.repeatLimit),
                idleResetMs: positiveInt(d.idleResetMsSec) * 1000,
                errRepeatLimit: positiveInt(d.errRepeatLimit),
                hardMs: positiveInt(d.hardMsMin) * 60000,
                hardBlock: !!d.hardBlock,
                adviceEnabled: !!d.adviceEnabled,
                warn: !!d.warn
            };
            var res = checkedResult(await ctx.callTool("turn_guard:turn_guard_config", { action: "set", patch: patch }));
            if (res && res.ok === false) {
                error.set("保存失败：" + (res.error || "未知错误"));
            } else {
                error.set("");
                if (ctx.showToast) { try { await ctx.showToast("✅ 已保存并立即生效"); } catch (e2) { } }
                await refresh();
            }
        } catch (e) {
            error.set("保存失败：" + (e && e.message ? e.message : String(e)));
        } finally {
            saving.set(false);
        }
    }

    async function resetDefaults() {
        saving.set(true);
        try {
            var res = checkedResult(await ctx.callTool("turn_guard:turn_guard_config", { action: "reset" }));
            var cfg = (res && res.config) ? res.config : res;
            draft.set(fillDraftFrom(cfg));
            if (ctx.showToast) { try { await ctx.showToast("已恢复默认阈值"); } catch (e2) { } }
            await refresh();
        } catch (e) {
            error.set("恢复默认失败：" + (e && e.message ? e.message : String(e)));
        } finally {
            saving.set(false);
        }
    }

    // ===== 小组件：数值行（可输入数字 + 保留 ± 做小额调整）=====
    function stepRow(label, key, step, min, unitSuffix, desc) {
        var d = draft.value || {};
        var val = d[key];
        var setVal = function (v) {
            var next = Object.assign({}, draft.value);
            next[key] = clampInt(v, min, min);
            draft.set(next);
        };
        var dec = function () { setVal((val || 0) - step); };
        var inc = function () { setVal(Number(val || 0) + step); };
        // 保留编辑态（含空值和非法输入），提交时统一校验。
        var onType = function (txt) {
            var next = Object.assign({}, draft.value);
            next[key] = String(txt == null ? "" : txt);
            draft.set(next);
        };
        var btn = function (txt, fn) {
            return ctx.UI.Surface({ shape: { cornerRadius: 8 }, containerColor: "#EEEEEE", onClick: fn }, [
                ctx.UI.Row({ padding: { horizontal: 14, vertical: 6 } }, [
                    ctx.UI.Text({ text: txt, fontWeight: "bold" })
                ])
            ]);
        };
        return ctx.UI.Column({ fillMaxWidth: true, padding: { vertical: 6 } }, [
            ctx.UI.Text({ text: label, style: "bodySmall" }),
            desc ? ctx.UI.Text({ text: desc, style: "labelSmall", color: "#888888" }) : ctx.UI.Spacer({ height: 0 }),
            ctx.UI.Row({ fillMaxWidth: true, verticalAlignment: "center", padding: { top: 4 } }, [
                btn("−", dec),
                ctx.UI.Box({ width: 110, padding: { horizontal: 6 } }, [
                    ctx.UI.TextField({
                        value: val == null ? "" : String(val),
                        onValueChange: onType,
                        singleLine: true,
                        maxLines: 1,
                        height: 52,
                        width: 110,
                        textAlign: "Center",
                        style: { fontSize: 16, fontWeight: "bold" }
                    })
                ]),
                btn("+", inc),
                unitSuffix ? ctx.UI.Box({ padding: { left: 8 } }, [
                    ctx.UI.Text({ text: unitSuffix, style: "labelSmall" })
                ]) : ctx.UI.Spacer({ height: 0 })
            ])
        ]);
    }

    function toggleRow(label, key, desc) {
        var d = draft.value || {};
        var on = !!d[key];
        var flip = function () {
            var next = Object.assign({}, draft.value);
            next[key] = !on;
            draft.set(next);
        };
        return ctx.UI.Row({ fillMaxWidth: true, verticalAlignment: "center", padding: { vertical: 6 } }, [
            ctx.UI.Column({ weight: 1 }, [
                ctx.UI.Text({ text: label, fontWeight: "bold", style: "bodySmall" }),
                desc ? ctx.UI.Text({ text: desc, style: "labelSmall", color: "#888888" }) : ctx.UI.Spacer({ height: 0 })
            ]),
            ctx.UI.Switch ? ctx.UI.Switch({ checked: on, onCheckedChange: flip }) :
                ctx.UI.Surface({ shape: { cornerRadius: 8 }, containerColor: on ? "#4CAF50" : "#CCCCCC", onClick: flip }, [
                    ctx.UI.Row({ padding: { horizontal: 10, vertical: 4 } }, [ctx.UI.Text({ text: on ? "开" : "关", color: "#FFFFFF" })])
                ])
        ]);
    }

    // ===== 卡片：构建 =====
    var cards = [];

    cards.push(ctx.UI.Row({ fillMaxWidth: true, verticalAlignment: "center" }, [
        ctx.UI.Text({ text: "灯火阑珊", style: "titleMedium", fontWeight: "bold", weight: 1 }),
        ctx.UI.Surface({ shape: { cornerRadius: 8 }, containerColor: "#EEEEEE", onClick: refresh }, [
            ctx.UI.Row({ padding: { horizontal: 10, vertical: 4 } }, [ctx.UI.Text({ text: loading.value ? "刷新中…" : "刷新", style: "labelSmall" })])
        ])
    ]));
    cards.push(ctx.UI.Text({ text: "修改后立即生效，无需重装或重启。", style: "labelSmall", color: "#888888" }));

    // 开关卡
    cards.push(ctx.UI.Card({ fillMaxWidth: true, shape: { cornerRadius: 12 } }, [
        ctx.UI.Column({ fillMaxWidth: true, padding: 12, spacing: 2 }, [
            ctx.UI.Text({ text: "行为设置", fontWeight: "bold", style: "bodySmall" }),
            toggleRow("达到上限时拦截", "hardBlock", "触及硬阈值后拒绝工具调用，而非仅作提示"),
            toggleRow("常驻收敛规则", "adviceEnabled", "将收敛规则加入系统提示，与触发式提醒独立"),
            toggleRow("接近阈值时提醒", "warn", "达到软阈值、时长到点或同一做法连续失败时，注入一次提醒，不中断执行")
        ])
    ]));

    var emptyHint = function () {
        return ctx.UI.Text({ text: loading.value ? "加载中…" : "暂无数据", style: "labelSmall", color: "#888888" });
    };

    // 卡2：调用额度（先定义「一轮」，再定义一轮内的三档额度）
    cards.push(ctx.UI.Card({ fillMaxWidth: true, shape: { cornerRadius: 12 } }, [
        ctx.UI.Column({ fillMaxWidth: true, padding: 12, spacing: 2 }, [
            ctx.UI.Text({ text: "调用额度", fontWeight: "bold", style: "bodySmall" }),
            draft.value ? ctx.UI.Column({ fillMaxWidth: true }, [
                stepRow("空闲重置", "idleResetMsSec", STEP.idleResetMsSec, 1, " 秒",
                    "无在途工具且静默超过该时长，仅清调用计数。"),
                stepRow("活动断档", "activeResetMsMin", STEP.activeResetMsMin, 1, " 分钟",
                    "无在途工具且静默超过此值与空闲重置的较大值，重开活动计时。"),
                stepRow("软阈值", "softCalls", STEP.softCalls, 1, " 次",
                    "本轮累计调用达到该次数，注入一次提醒。"),
                stepRow("提醒时长", "softMsMin", STEP.softMsMin, 0, " 分钟",
                    "从活动首个事件计时；0 关闭时长提醒。"),
                stepRow("硬阈值", "hardCalls", STEP.hardCalls, 1, " 次",
                    "本轮累计调用达到该次数，拒绝后续工具调用。"),
                stepRow("硬停时长", "hardMsMin", STEP.hardMsMin, 1, " 分钟",
                    "从活动首个事件计时，到时拒绝工具调用。")
            ]) : emptyHint()
        ])
    ]));

    // 卡3：重复检测（两个信号：原地打转 / 没有进展）
    cards.push(ctx.UI.Card({ fillMaxWidth: true, shape: { cornerRadius: 12 } }, [
        ctx.UI.Column({ fillMaxWidth: true, padding: 12, spacing: 2 }, [
            ctx.UI.Text({ text: "重复检测", fontWeight: "bold", style: "bodySmall" }),
            draft.value ? ctx.UI.Column({ fillMaxWidth: true }, [
                stepRow("相同调用", "repeatLimit", STEP.repeatLimit, 1, " 次",
                    "同一工具、同一参数连续出现多少次，判定为原地打转。"),
                stepRow("相同失败", "errRepeatLimit", STEP.errRepeatLimit, 1, " 次",
                    "同一工具、同一参数连续报错多少次，判定当前做法没有进展。")
            ]) : emptyHint()
        ])
    ]));

    // 操作行
    cards.push(ctx.UI.Row({ fillMaxWidth: true, spacing: 8 }, [
        ctx.UI.Surface({ containerColor: "#1976D2", shape: { cornerRadius: 10 }, weight: 1, onClick: saving.value ? undefined : save }, [
            ctx.UI.Row({ fillMaxWidth: true, horizontalArrangement: "center", padding: { vertical: 10 } }, [
                ctx.UI.Text({ text: saving.value ? "保存中…" : "保存", color: "#FFFFFF", fontWeight: "bold" })
            ])
        ]),
        ctx.UI.Surface({ containerColor: "#EEEEEE", shape: { cornerRadius: 10 }, weight: 1, onClick: saving.value ? undefined : resetDefaults }, [
            ctx.UI.Row({ fillMaxWidth: true, horizontalArrangement: "center", padding: { vertical: 10 } }, [
                ctx.UI.Text({ text: "恢复默认", fontWeight: "bold" })
            ])
        ])
    ]));

    // 最近事件（折叠）
    var recentEvents = (status.value && status.value.recentEvents) || [];
    cards.push(ctx.UI.Surface({ fillMaxWidth: true, containerColor: "#F5F5F5", shape: { cornerRadius: 10 }, onClick: function () { showEvents.set(!showEvents.value); } }, [
        ctx.UI.Row({ fillMaxWidth: true, padding: { horizontal: 12, vertical: 8 }, verticalAlignment: "center" }, [
            ctx.UI.Text({ text: (showEvents.value ? "▾" : "▸") + " 最近事件（" + recentEvents.length + "）", style: "labelSmall", color: "#555555", weight: 1 })
        ])
    ]));
    if (showEvents.value) {
        var eventNodes = recentEvents.slice(-10).reverse().map(function (line) {
            return ctx.UI.Text({ text: String(line), style: "labelSmall", color: "#777777" });
        });
        cards.push(ctx.UI.Card({ fillMaxWidth: true, shape: { cornerRadius: 10 } }, [
            ctx.UI.Column({ fillMaxWidth: true, padding: 10, spacing: 3 }, eventNodes.length ? eventNodes : [
                ctx.UI.Text({ text: "暂无事件", style: "labelSmall", color: "#999999" })
            ])
        ]));
    }

    if (error.value) {
        cards.push(ctx.UI.Surface({ fillMaxWidth: true, containerColor: "#FFCDD2", shape: { cornerRadius: 10 } }, [
            ctx.UI.Row({ padding: 12, verticalAlignment: "center" }, [
                ctx.UI.Text({ text: String(error.value), style: "bodySmall", color: "#B71C1C", weight: 1 })
            ])
        ]));
    }

    return ctx.UI.LazyColumn({ fillMaxSize: true, padding: 12, spacing: 10 }, cards);
}

try { exports.default = Screen; } catch (e) { }

/*
UI 设计说明：
- 单列纵向滚动（LazyColumn），不分 Tab：六项配置 + 状态 + 操作按钮一屏内容量不大，
  分 Tab 反而增加点击成本，尤其在小屏上。
- 数值项支持 TextField 编辑并保留原始输入；保存时统一校验正整数范围。
  ± 按钮用于小额调整，不代替提交校验。
  idleResetMs 换算成“秒”展示（内部仍存毫秒），避免用户面对 120000 这种数字。
- 开关优先用 ctx.UI.Switch（若宿主提供），否则回退成可点击色块，和 xinchao 样本里
  “组件不可用时自动回退”的写法一致，保证在不同宿主版本下不白屏。
- “保存并生效”和“恢复默认”并排等宽，操作对称；保存后立即重新 refresh() 一次配置，
  让用户在同一屏看到 config 已经变化，验证“即时生效”而不需要跳出设置页。
- 最近事件默认折叠：这是调试信息，不是日常要看的内容，默认收起减少视觉噪音，
  点一下展开最近 10 条（逆序，最新在上）。
- 草稿态（draft）与已生效配置（status.config）分离：用户调整滑块/数字时不会抖动重新拉取，
  只有点“保存”才提交，避免步进点击过程中反复触发网络往返式的 ctx.callTool。
*/
