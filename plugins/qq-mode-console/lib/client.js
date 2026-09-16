// QQ 机器人设置（浏览器半侧）—— DSH 设置页里一个**独立分区**
//
// 注册到 `settings.section`，order=1 —— 也就是排在「通用设置」正下方、Theme 之前。
// 这一页编辑 host 半侧注册的 `qq-mode` 命名空间，也就是 qq-bridge 的整份 config.json。
//
// 表单是**按 schema 自动生成**的：字段（含中文名与长说明）都来自 descriptor 里序列化的
// schema，所以给 host 的 lib/schema.js 加一行，这一页就自动多一项 —— 这里不用改。
//
// 为什么必须自带客户端代码：DSH 的设置页不会自动渲染 settings 命名空间，
// 每个分区都得由插件自己注册（官方只为它自己的几个命名空间写了界面）。
// 整个 load 都包在 try/catch 里：外壳（__ModuleLoader__）还没就绪时 load 自己就会抛，
// 抛出去会让整个 Web 外壳起不来（本项目踩过这个坑）。
try {
  window.__ModuleLoader__.load({
  id: "qq-mode-console",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const React = require("react");
    const NS = "qq-mode";
    const PAGE_ID = "qq-mode-console";

    /** 分组中文名与说明：优先用 schema 里带的 description，这里只是兜底。 */
    const GROUP_FALLBACK = {
      core: { title: "基本", desc: "身份、准入、会话、控制台。这里的项改错后果最直接。" },
      persona: { title: "性格与人设", desc: "管它是什么性格、用什么语气、怎么说话。填了就注入，全留空 = 一个字都不改（保持现状）。" },
      notify: { title: "通知", desc: "什么情况下手机会收到消息 —— 嫌吵就调这几个阈值。" },
      allow: { title: "白名单（谁能跟它说话）", desc: "空白名单 + 放行开关关闭 = 谁都不理。黑名单优先于白名单。" },
      deny: { title: "黑名单", desc: "命中黑名单的会话一律不处理，优先级高于白名单。" },
      slang: { title: "黑话学习", desc: "它会把聊天里看不懂的新词攒起来，够了就让 DSH 去研究并收录。" },
      social: { title: "一代仿真（social）", desc: "早期模式：按概率决定要不要接话、要不要主动找人。" },
      socialV2: { title: "二代仿真（socialV2）", desc: "现在实际在用的模式 —— AI 自己决定什么时候说话、什么时候潜水。" },
      dsh: { title: "模型与 DSH 接线", desc: "机器人跑在哪个模型上、连的是哪个 DSH。" },
      snowluma: { title: "SnowLuma 接线（高级）", desc: "QQ 客户端 ↔ 桥接之间的管道。地址填错会直接连不上，改完要重启桥接。" },
      security: { title: "安全", desc: "拦截/越权时的行为。" }
    };
    /** 顶格字段的分组点名 —— 必须与 host 端 schema.js 的 TOP_LEVEL_GROUPS 一致（测试会校验）。 */
    const TOP_LEVEL_GROUPS = {
      notifyTaskDone: "notify",
      notifyTaskDoneMinTurnMs: "notify",
      notifyTaskDoneDebounceMs: "notify",
      notifyTaskDoneMaxChars: "notify",
      relayApprovalsToOwner: "notify",
      relayQuestionsToOwner: "notify",
      sessionDiscoveryMs: "notify"
    };
    const GROUP_ORDER = ["core", "persona", "notify", "allow", "deny", "slang", "social", "socialV2", "dsh", "snowluma", "security"];
    /** socialV2 下的二级分组标题。 */
    const SUBGROUP_TITLES = {
      tools: "工具开关（AI 能用哪些能力）",
      wake: "潜水 / 唤醒策略",
      send: "发送策略（分条、限流）",
      wait: "等待与抢话保护",
      sticker: "表情包",
      proactive: "主动找人",
      feedback: "反馈",
      context: "上下文"
    };

    const CSS = [
      ".qqp{max-width:880px;font-size:13px;color:var(--dsw-alias-label-primary,inherit)}",
      ".qqp_head{position:sticky;top:0;z-index:2;display:flex;align-items:flex-start;gap:12px;padding:4px 0 10px;background:var(--dsw-alias-bg-base,transparent)}",
      ".qqp_headMain{flex:1;min-width:0}",
      ".qqp_title{margin:0 0 4px;font-size:15px;font-weight:600}",
      ".qqp_intro{margin:0;font-size:12px;line-height:1.7;color:var(--dsw-alias-label-secondary,#8a8f9c)}",
      ".qqp_actions{display:flex;flex-direction:column;align-items:flex-end;gap:6px;flex:0 0 auto}",
      ".qqp_btnRow{display:flex;gap:8px;align-items:center}",
      ".qqp_btn{padding:5px 14px;font:inherit;font-size:12px;border-radius:6px;border:1px solid var(--dsw-alias-border-l1,#d7dae0);background:var(--dsw-alias-bg-base,transparent);color:inherit;cursor:pointer;white-space:nowrap}",
      ".qqp_btn[data-primary=true]{background:var(--dsw-alias-brand-primary,#1668dc);border-color:transparent;color:#fff}",
      ".qqp_btn:disabled{opacity:.45;cursor:default}",
      ".qqp_sec{margin:0 0 14px;border:1px solid var(--dsw-alias-border-l1,#d7dae0);border-radius:10px;overflow:hidden}",
      ".qqp_secHead{display:flex;align-items:center;gap:8px;width:100%;padding:10px 12px;background:0 0;border:none;cursor:pointer;color:inherit;font:inherit;text-align:left}",
      ".qqp_secHead:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.04))}",
      ".qqp_secTitle{font-weight:600;font-size:13px}",
      ".qqp_secMeta{flex:1;font-size:11px;color:var(--dsw-alias-label-secondary,#8a8f9c)}",
      ".qqp_secBody{padding:0 12px 6px;border-top:1px solid var(--dsw-alias-border-l1,#d7dae0)}",
      ".qqp_secDesc{margin:10px 0 4px;font-size:12px;line-height:1.7;color:var(--dsw-alias-label-secondary,#8a8f9c)}",
      ".qqp_sub{margin:12px 0 0;padding:0 0 0 10px;border-left:2px solid var(--dsw-alias-border-l1,#d7dae0)}",
      ".qqp_subTitle{margin:0 0 6px;font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary,#8a8f9c)}",
      ".qqp_row{padding:9px 0;border-top:1px dashed var(--dsw-alias-border-l1,rgba(0,0,0,.07))}",
      ".qqp_rowFirst{border-top:none}",
      ".qqp_rowTop{display:flex;align-items:center;gap:10px}",
      ".qqp_label{flex:1 1 auto;min-width:0;font-size:13px;font-weight:500}",
      ".qqp_key{font-size:11px;color:var(--dsw-alias-label-secondary,#8a8f9c);font-weight:400}",
      ".qqp_ctl{flex:0 0 auto;display:flex;align-items:center;gap:6px}",
      ".qqp_ctl input[type=text],.qqp_ctl input[type=number],.qqp_ctl select,.qqp_ctl textarea{box-sizing:border-box;width:170px;padding:4px 7px;font:inherit;font-size:12px;color:inherit;background:var(--dsw-alias-bg-base,transparent);border:1px solid var(--dsw-alias-border-l1,#d7dae0);border-radius:6px}",
      ".qqp_ctl input[type=number]{width:120px}",
      ".qqp_ctl textarea{width:280px;min-height:70px;resize:vertical;line-height:1.6}",
      ".qqp_desc{margin:4px 0 0;font-size:12px;line-height:1.75;color:var(--dsw-alias-label-secondary,#8a8f9c)}",
      ".qqp_badge{font-size:10px;padding:1px 6px;border-radius:99px;border:1px solid currentColor;background:0 0;color:var(--dsw-alias-label-secondary,#8a8f9c);cursor:pointer;white-space:nowrap}",
      ".qqp_badge[data-kind=user]{color:var(--dsw-alias-label-warning,#d48806)}",
      ".qqp_badge[data-kind=draft]{color:var(--dsw-alias-label-info,#1668dc);cursor:default}",
      ".qqp_err{color:var(--dsw-alias-label-error,#d4380d);font-size:12px}",
      ".qqp_warn{margin:0 0 12px;padding:8px 10px;font-size:12px;line-height:1.7;border:1px solid var(--dsw-alias-label-warning,#d48806);border-radius:8px;color:var(--dsw-alias-label-warning,#d48806)}",
      ".qqp_ok{color:var(--dsw-alias-label-success,#389e0d);font-size:12px}",
      ".qqp_empty{padding:24px 0;color:var(--dsw-alias-label-secondary,#8a8f9c);font-size:12px}"
    ].join("");

    function ensureCss() {
      if (typeof document === "undefined") return;
      if (document.querySelector("style[data-plugin-css=" + JSON.stringify(PAGE_ID) + "]") !== null) return;
      const style = document.createElement("style");
      style.setAttribute("data-plugin-css", PAGE_ID);
      style.textContent = CSS;
      (document.head ?? document.documentElement).appendChild(style);
    }

    // ── schema 走查 ────────────────────────────────────────────────────────

    function nodeOf(schema, uid) {
      if (!schema || typeof schema !== "object") return undefined;
      const refs = schema.refs;
      if (refs && typeof refs === "object" && refs[String(uid)] !== undefined) return refs[String(uid)];
      if (schema.uid === uid) return schema;
      return undefined;
    }

    /** 标签｜说明 → 两段（说明可以为空）。 */
    function splitLabel(text) {
      const raw = String(text ?? "");
      const index = raw.indexOf("｜");
      return index < 0 ? [raw, ""] : [raw.slice(0, index), raw.slice(index + 1)];
    }

    /**
     * 递归收集叶子字段。
     * @returns {Array<{path, group, sub, kind, label, desc, options}>}
     */
    function collectFields(schema) {
      const out = [];
      const walk = (uid, path) => {
        if (out.length > 400) return;
        const node = nodeOf(schema, uid);
        if (node === undefined) return;
        if (node.type === "object" && node.dict) {
          for (const [key, child] of Object.entries(node.dict)) walk(child, [...path, key]);
          return;
        }
        if (node.type === "const" || path.length === 0) return;
        const full = path.join(".");
        const group = TOP_LEVEL_GROUPS[full] !== undefined
          ? TOP_LEVEL_GROUPS[full]
          : (path.length === 1 ? "core" : path[0]);
        const sub = path.length > 2 && path[0] === "socialV2" ? path[1] : "";
        const [label, desc] = splitLabel(node.meta?.description);
        let kind = "string";
        let options;
        if (node.type === "union" && Array.isArray(node.list)) {
          const values = node.list
            .map((ref) => nodeOf(schema, ref))
            .filter((item) => item !== undefined && item.type === "const")
            .map((item) => item.value);
          if (values.length === node.list.length && values.length > 0) {
            kind = "enum";
            options = values;
          }
        } else if (node.type === "boolean") kind = "bool";
        else if (node.type === "number") kind = "number";
        else if (node.type === "string") kind = node.meta?.role === "textarea" ? "text" : "string";
        else if (node.type === "array") {
          const inner = nodeOf(schema, node.inner);
          kind = inner !== undefined && inner.type === "string" ? "strings" : "numbers";
        }
        out.push({ path, group, sub, kind, label: label || path[path.length - 1], desc, options });
      };
      walk(schema?.uid, []);
      return out;
    }

    /** 一组的小标题与说明：优先读 schema 里那个分组对象的 description，没有就用兜底表。 */
    function groupHeading(schema, key) {
      const root = nodeOf(schema, schema?.uid);
      const childUid = root?.dict?.[key];
      const meta = childUid === undefined ? undefined : nodeOf(schema, childUid)?.meta;
      const [title, desc] = splitLabel(meta?.description);
      const fallback = GROUP_FALLBACK[key] ?? { title: key, desc: "" };
      return { title: title || fallback.title, desc: desc || fallback.desc };
    }

    // ── 取值 / 写值 ────────────────────────────────────────────────────────

    const keyOf = (path) => path.join(".");

    function readAt(source, path) {
      let node = source;
      for (const segment of path) {
        if (node === undefined || node === null || typeof node !== "object") return undefined;
        node = node[segment];
      }
      return node;
    }

    function formatValue(field, value) {
      if (value === undefined || value === null) return "";
      if (field.kind === "numbers" || field.kind === "strings") {
        return Array.isArray(value) ? value.join(", ") : String(value);
      }
      return String(value);
    }

    /** 界面上的文本 → schema 需要的类型；返回 undefined 表示"这项没改"。 */
    function parseValue(field, raw) {
      switch (field.kind) {
        case "bool": return Boolean(raw);
        case "number": {
          const raw2 = String(raw).trim();
          // 清空 = 这一项不设（别偷偷写成 0：ownerQQ 变 0 会让管理员判定直接失效）。
          // 想真设 0 就老老实实敲一个 0。
          if (raw2 === "") return undefined;
          const n = Number(raw2);
          return Number.isFinite(n) ? n : undefined;
        }
        case "numbers": {
          const src = String(raw).trim();
          // 清空 = 这一项不设（与 number / enum 同语义）。
          // 以前把空串解析成 []，于是"清空输入框 + 保存"会把白名单实际写成"空名单"
          // （allow.private 空 + allowAllWhenEmpty:false = 谁都不放行），而界面上看起来只是没填。
          if (src === "") return undefined;
          const parts = src.split(/[,，\s]+/).map((s) => Number(s.trim())).filter((n) => Number.isFinite(n));
          // 非空但一个合法项都没有（比如 numbers 字段里敲了汉字）同样视为"没改"，
          // 不要用 [] 覆盖掉原有名单。
          return parts.length === 0 ? undefined : parts;
        }
        case "strings": {
          const src = String(raw).trim();
          // 同上：清空 = 不设置，不用 [] 覆盖。
          if (src === "") return undefined;
          const parts = src.split(/[,，\n]+/).map((s) => s.trim()).filter((s) => s !== "");
          return parts.length === 0 ? undefined : parts;
        }
        case "enum": {
          // 下拉框的第一项是「（不设置，沿用原值）」→ 空值 = 这一项不设。
          // 不能把它当空串提交：enum 的 schema 只接受那几个常量，空串会被校验拒绝。
          const text = String(raw);
          return text === "" ? undefined : text;
        }
        default: return String(raw);
      }
    }

    // ── 组件 ──────────────────────────────────────────────────────────────

    function FieldRow(props) {
      const { field, value, baseValue, overridden, pending, state, first, onChange, onReset } = props;
      // 显示哪个值：改过 → 草稿值；刚点「已改」撤销 → 磁盘值（它马上要回到磁盘值）；
      // 没动过 → 当前生效值（磁盘 + 设置页覆盖的合并结果）。
      // pending 是草稿里的**值**，不是整条记录 —— 早先错把整条记录当值给控件，
      // 症状就是输入框显示 [object Object]、勾选框永远弹回。
      const shown = state === "set" ? pending : (state === "unset" ? baseValue : value);
      const text = formatValue(field, shown);
      const common = { "aria-label": field.label };
      let control;
      if (field.kind === "bool") {
        control = React.createElement("input", {
          ...common,
          type: "checkbox",
          checked: shown === true,
          onChange: (event) => onChange(event.target.checked)
        });
      } else if (field.kind === "enum") {
        control = React.createElement(
          "select",
          { ...common, value: text, onChange: (event) => onChange(event.target.value) },
          React.createElement("option", { value: "" }, "（不设置，沿用原值）"),
          (field.options ?? []).map((option) => React.createElement("option", { key: option, value: option }, option))
        );
      } else if (field.kind === "text") {
        control = React.createElement("textarea", { ...common, value: text, onChange: (event) => onChange(event.target.value) });
      } else {
        control = React.createElement("input", {
          ...common,
          type: field.kind === "string" || field.kind === "strings" ? "text" : "number",
          value: text,
          onChange: (event) => onChange(event.target.value)
        });
      }
      return React.createElement(
        "div",
        { className: first ? "qqp_row qqp_rowFirst" : "qqp_row" },
        React.createElement(
          "div",
          { className: "qqp_rowTop" },
          React.createElement(
            "div",
            { className: "qqp_label", title: field.path.join(".") },
            field.label,
            React.createElement("span", { className: "qqp_key" }, `  ${field.path.join(".")}`)
          ),
          React.createElement(
            "div",
            { className: "qqp_ctl" },
            control,
            overridden ? React.createElement("button", {
              type: "button",
              className: "qqp_badge",
              "data-kind": "user",
              title: "这一项在设置页里被改过；点一下 = 恢复成 config.json 的值",
              onClick: onReset
            }, "已改") : null,
            state !== "none" ? React.createElement("span", { className: "qqp_badge", "data-kind": "draft" }, "待保存") : null
          )
        ),
        field.desc ? React.createElement("p", { className: "qqp_desc" }, field.desc) : null
      );
    }

    function GroupSection(props) {
      const { groupKey, title, desc, fields, values, base, user, draft, onField, onReset, defaultOpen } = props;
      const [open, setOpen] = React.useState(Boolean(defaultOpen));
      const dirty = fields.filter((f) => draft[keyOf(f.path)] !== undefined).length;
      const rows = [];
      const plain = fields.filter((f) => f.sub === "");
      const subs = new Map();
      for (const field of fields) {
        if (field.sub === "") continue;
        if (!subs.has(field.sub)) subs.set(field.sub, []);
        subs.get(field.sub).push(field);
      }
      const renderOne = (field, first) => {
        const entry = draft[keyOf(field.path)];
        // 三态：没动过 / 改过（带值）/ 刚撤销（要显示磁盘上的值）。
        const state = entry === undefined ? "none" : (entry.kind === "unset" ? "unset" : "set");
        return React.createElement(FieldRow, {
          key: keyOf(field.path),
          field,
          first,
          value: readAt(values, field.path),
          baseValue: readAt(base, field.path),
          overridden: readAt(user, field.path) !== undefined,
          pending: entry?.value,
          state,
          onChange: (raw) => onField(field, raw),
          onReset: () => onReset(field)
        });
      };
      plain.forEach((field, index) => rows.push(renderOne(field, index === 0 && subs.size === 0)));
      for (const [sub, list] of subs) {
        rows.push(React.createElement(
          "div",
          { className: "qqp_sub", key: sub },
          React.createElement("h4", { className: "qqp_subTitle" }, SUBGROUP_TITLES[sub] ?? sub),
          list.map((field, index) => renderOne(field, index === 0))
        ));
      }
      return React.createElement(
        "section",
        { className: "qqp_sec", id: `qqp-${groupKey}` },
        React.createElement(
          "button",
          { type: "button", className: "qqp_secHead", onClick: () => setOpen((value) => !value) },
          React.createElement("span", { className: "qqp_secTitle" }, `${open ? "▾ " : "▸ "}${title}`),
          React.createElement("span", { className: "qqp_secMeta" }, `${fields.length} 项${dirty > 0 ? ` · ${dirty} 项待保存` : ""}`)
        ),
        open ? React.createElement(
          "div",
          { className: "qqp_secBody" },
          desc ? React.createElement("p", { className: "qqp_secDesc" }, desc) : null,
          rows
        ) : null
      );
    }

    function QqBotSettingsPage(props) {
      const settings = props.settings;
      const describe = props.describe;
      const subscribe = React.useCallback((listener) => settings.subscribe(listener), [settings]);
      const getSnapshot = React.useCallback(() => settings.getSnapshot(), [settings]);
      const snapshot = React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
      const mirrorSubscribe = React.useCallback((listener) => describe.subscribe(listener), [describe]);
      const mirrorSnapshot = React.useCallback(() => describe.getSnapshot(), [describe]);
      const mirror = React.useSyncExternalStore(mirrorSubscribe, mirrorSnapshot, mirrorSnapshot);

      const [draft, setDraft] = React.useState({});
      const [saving, setSaving] = React.useState(false);
      const [error, setError] = React.useState("");
      const [ok, setOk] = React.useState("");

      const row = mirror?.view?.namespaces?.find((item) => item.ns === NS);
      const schema = row?.schema;
      const fields = React.useMemo(() => {
        try {
          return schema === undefined ? [] : collectFields(schema);
        } catch (failed) {
          console.warn("[qq-mode-console] schema 解析失败", failed);
          return [];
        }
      }, [schema]);

      const dirtyCount = Object.keys(draft).length;
      const groups = new Map();
      for (const field of fields) {
        if (!groups.has(field.group)) groups.set(field.group, []);
        groups.get(field.group).push(field);
      }
      const order = [...groups.keys()].sort((a, b) => {
        const ia = GROUP_ORDER.indexOf(a);
        const ib = GROUP_ORDER.indexOf(b);
        return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
      });

      const onField = (field, raw) => {
        const parsed = parseValue(field, raw);
        setOk("");
        setDraft((previous) => {
          const next = { ...previous };
          const key = keyOf(field.path);
          if (parsed === undefined) {
            // 清空 = 想恢复默认：这一项本来在设置页里被改过就记成「撤销」（保存时 unset），
            // 本来没改过就当没动过 —— 别制造一条没有意义的覆盖。
            if (readAt(snapshot.user, field.path) !== undefined) next[key] = { path: field.path, kind: "unset" };
            else delete next[key];
          } else {
            next[key] = { path: field.path, value: parsed, kind: "set" };
          }
          return next;
        });
      };
      const onReset = (field) => {
        setOk("");
        setDraft((previous) => ({ ...previous, [keyOf(field.path)]: { path: field.path, kind: "unset" } }));
      };
      /** 宽松等值比较：数字/字符串/布尔/数组各按自己的语义比，避免宿主规范化后误判。 */
      const sameValue = (a, b) => {
        if (Array.isArray(a) || Array.isArray(b)) return JSON.stringify(a ?? []) === JSON.stringify(b ?? []);
        if (typeof a === "number" || typeof b === "number") return Number(a) === Number(b);
        if (typeof a === "boolean" || typeof b === "boolean") return a === b;
        return String(a ?? "").trim() === String(b ?? "").trim();
      };
      /** 这一条 op 是否真的落进 user 层了。 */
      const opApplied = (user, op) => {
        const current = readAt(user, op.path);
        if (op.op === "unset") return current === undefined;
        return current !== undefined && sameValue(current, op.value);
      };
      const save = async () => {
        if (saving || dirtyCount === 0) return;
        setSaving(true);
        setError("");
        setOk("");
        try {
          const ops = Object.values(draft).map((entry) => entry.kind === "unset"
            ? { op: "unset", path: entry.path }
            : { op: "set", path: entry.path, value: entry.value });
          // 用**当前**revision 而不是本组件渲染时那份：连续保存两次时，旧 revision 会被宿主拒掉。
          const live = settings.getSnapshot();
          await settings.mutate(ops, live.revision);
          const settled = settings.getSnapshot();
          if (settled.status !== "ready") {
            setError("写入后状态异常，请重新加载页面确认。改动还留在页面上。");
            return;
          }
          // ⚠️ 宿主拒绝写入时，settingsScope.mutate() **既不抛异常、也不返回失败**
          //（DSH 的 SettingsController.mutate 内部只是 recover() 后静默 return）。
          // 只判 status 会把"被拒绝"显示成绿色「已保存」——那正是"改了不生效"的一种成因。
          // 所以这里回读 user 层逐条比对（2026-09-16 审计修复）。
          const settledUser = settled.user;
          const notApplied = settledUser === undefined || settledUser === null
            ? []                                        // user 层读不到就不下结论，保持旧行为
            : ops.filter((op) => !opApplied(settledUser, op));
          if (notApplied.length > 0) {
            const preview = notApplied.slice(0, 3).map((op) => op.path.join(".")).join(", ");
            setError(`保存被拒绝了：${notApplied.length} 项没写进去（${preview}${notApplied.length > 3 ? " 等" : ""}）。`
              + "常见原因：值不合法（schema 校验没过）、或页面数据已过期。改动仍留在页面上，改好后重新保存。");
            return;                                     // 保留草稿，别让用户以为已经保存成功
          }
          setDraft({});
          setOk(`已保存 ${ops.length} 项；桥接会在 5 秒内自动生效（标 ⚠️ 的项要重启桥接）。`);
        } catch (failed) {
          setError(`保存失败：${failed?.message ?? failed}`);
        } finally {
          setSaving(false);
        }
      };
      const discard = () => {
        setDraft({});
        setError("");
        setOk("");
      };

      const header = React.createElement(
        "div",
        { className: "qqp_head" },
        React.createElement(
          "div",
          { className: "qqp_headMain" },
          React.createElement("h2", { className: "qqp_title" }, "QQ 机器人设置"),
          React.createElement("p", { className: "qqp_intro" },
            "这里改的是 qq-bridge 的配置（等价于 config.json）。保存后桥接每 5 秒拉一次，通常 5 秒内生效；"
            + "标了 ⚠️ 的接线项（控制台端口、SnowLuma 地址）要重启桥接。"
            + "在设置页里改过的项会覆盖 config.json，点项右边的「已改」可以恢复成 config.json 的值。"
          )
        ),
        React.createElement(
          "div",
          { className: "qqp_actions" },
          React.createElement(
            "div",
            { className: "qqp_btnRow" },
            React.createElement("button", {
              type: "button",
              className: "qqp_btn",
              "data-primary": "true",
              disabled: saving || dirtyCount === 0,
              onClick: save
            }, saving ? "保存中…" : `保存${dirtyCount > 0 ? `（${dirtyCount}）` : ""}`),
            React.createElement("button", {
              type: "button",
              className: "qqp_btn",
              disabled: saving || dirtyCount === 0,
              onClick: discard
            }, "放弃修改")
          ),
          error !== "" ? React.createElement("span", { className: "qqp_err" }, error) : null,
          ok !== "" ? React.createElement("span", { className: "qqp_ok" }, ok) : null
        )
      );

      if (snapshot.status !== "ready" || snapshot.value === undefined) {
        return React.createElement("div", { className: "qqp" }, header,
          React.createElement("p", { className: "qqp_empty" }, "设置还没加载好（或本机没有可写的设置存储）。"));
      }
      if (fields.length === 0) {
        return React.createElement("div", { className: "qqp" }, header,
          React.createElement("p", { className: "qqp_empty" }, "没读到 schema —— 多半是 host 半侧没挂上（检查 qq-mode-console 插件是否 active）。"));
      }

      const values = snapshot.value;
      const user = snapshot.user ?? {};
      // base 为空 = host 半侧没读到 config.json（文件不存在或读盘失败）。
      // 这时每一项都会显示为空，用户照着重填一遍就会变成整页 user 覆盖 —— 必须在顶部说清楚。
      const baseEmpty = Object.keys(snapshot.base ?? {}).length === 0
        && Object.keys(values ?? {}).length === 0;
      return React.createElement(
        "div",
        { className: "qqp" },
        header,
        baseEmpty
          ? React.createElement("p", { className: "qqp_warn" },
            "⚠️ host 半侧没读到 config.json（文件不存在或读不出来），下面每一项都会显示为空 —— "
            + "先修好配置文件再看这一页，别照着重填一遍（重填会变成整页覆盖）。"
            + "原因可以看 state/qq-mode-plugin.log。")
          : null,
        order.map((key) => {
          const heading = groupHeading(schema, key);
          return React.createElement(GroupSection, {
            key,
            groupKey: key,
            title: heading.title,
            desc: heading.desc,
            fields: groups.get(key),
            values,
            base: snapshot.base ?? {},
            user,
            draft,
            onField,
            onReset,
            // 默认展开日常会改的那几组；两个超长的仿真组默认收起（点标题展开）
            defaultOpen: key !== "social" && key !== "socialV2"
          });
        })
      );
    }

    /** 需要的客户端服务：settingsScope（读/写命名空间）与 slots（注册分区）。 */
    const inject = ["settingsScope", "slots"];

    /**
     * 挂载设置分区。任何异常都只记日志 —— 客户端插件抛出会让整个 Web 外壳起不来。
     * @param {object} ctx 客户端根上下文。
     */
    function apply(ctx) {
      try {
        ensureCss();
        ctx.inject(["settingsScope", "slots"], (settingsCtx) => {
          try {
            const settings = settingsCtx.settingsScope.bind({ namespace: NS });
            const describe = settingsCtx.settingsScope.describe();
            settingsCtx.slots.inject("settings.section", () =>
              settingsCtx.slots.register(
                {
                  name: "settings.section",
                  id: "qq-bot",
                  order: 1,                    // 1 = 排在「通用设置」(order 0) 正下方
                  label: () => "QQ 机器人",
                  inject: () => ({ settings, describe })
                },
                QqBotSettingsPage
              )
            );
          } catch (failed) {
            console.warn("[qq-mode-console] 设置分区挂载失败:", failed);
          }
        });
      } catch (failed) {
        console.warn("[qq-mode-console] apply 失败:", failed);
      }
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
  });
} catch (error) {
  console.warn("[qq-mode-console] 客户端半侧加载失败:", error);
}
