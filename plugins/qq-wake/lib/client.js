// qq-wake —— 浏览器半侧（DSH Web GUI）
//
// 在侧边栏「技能中心」正下方注入一个「唤醒」按键：点一下 = 拉起 QQ 机器人并发一句
// 「睡醒了」。
//
// 为什么要用 DOM 注入而不是 slot：
//   DSH 侧边栏外壳没有对外开放的 slot（官方 dsh-client-ui-sidebar 只声明
//   brand / workspaces / settings 三处席位），社区插件（skill-explorer / task-board /
//   dsh-ssh）一律走「DOM 行 + MutationObserver 自愈」这条路。这里沿用同一套做法，
//   只是把锚点钉在技能中心那一行下面。
//
// 纪律：本文件的 apply 绝不抛异常 —— 客户端插件 apply 抛出会让整个 Web 外壳启动失败。
// 整个 load 都包在 try/catch 里：外壳（__ModuleLoader__）还没就绪时 load 自己就会抛，
// 那条路径以前没人兜住，抛出去就是整个 Web 外壳起不来（本项目踩过这个坑）。
try {
  window.__ModuleLoader__.load({
  id: "qq-wake",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    /** 本行自己的锚点属性（幂等键）。 */
    const ROW_ATTRIBUTE = "data-dsh-qq-wake-entry";
    const ROW_SELECTOR = "[data-dsh-qq-wake-entry]";
    /** 「技能中心」那一行 —— 新行贴它下面。 */
    const SKILL_SELECTOR = "[data-dsh-skill-explorer-entry]";
    /** 已知的社区插件功能行：找不到技能中心时按这个家族排序兜底。 */
    const FAMILY_SELECTORS = [
      "[data-dsh-taskboard-entry]",
      "[data-dsh-ssh-entry]",
      "[data-dsh-skill-explorer-entry]"
    ];
    const CSS_TAG_ID = "qq-wake";
    const LABEL_IDLE = "唤醒";
    const LABEL_BUSY = "唤醒中…";
    const LABEL_OK = "已唤醒 ✓";
    const LABEL_FAIL = "唤醒失败";
    const ICON = "<svg viewBox=\"0 0 16 16\" width=\"18\" height=\"18\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.3\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\"><path d=\"M8 2.2a4 4 0 0 0-4 4v2.5L2.7 11.2h10.6L12 8.7V6.2a4 4 0 0 0-4-4z\"/><path d=\"M6.4 12.6a1.7 1.7 0 0 0 3.2 0\"/></svg>";

    const CSS = [
      ".qqwake-entry{box-sizing:border-box;width:100%;height:36px;color:var(--dsw-alias-label-secondary);cursor:pointer;white-space:nowrap;background:0 0;border:none;border-radius:8px;align-items:center;gap:8px;padding:0 10px;font-size:13px;display:flex;font-family:inherit}",
      ".qqwake-entry:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}",
      ".qqwake-entry[data-qqwake-state=busy]{color:var(--dsw-alias-label-primary);cursor:progress}",
      ".qqwake-entry[data-qqwake-state=ok]{color:var(--dsw-alias-label-primary)}",
      ".qqwake-entry[data-qqwake-state=fail]{color:var(--dsw-alias-label-error,#d4380d)}",
      ".qqwake-entryIcon{flex:none;justify-content:center;align-items:center;width:24px;height:24px;display:inline-flex}",
      ".qqwake-entryIcon svg{width:18px;height:18px;display:block}",
      ".qqwake-entryLabel{text-overflow:ellipsis;overflow:hidden}",
      "[data-dsh-frame][data-sidebar-collapsed] .qqwake-entry,[data-sidebar-collapsed] .qqwake-entry{border-radius:50%;justify-content:center;width:36px;height:36px;margin:0 auto 12px;padding:0}",
      "[data-dsh-frame][data-sidebar-collapsed] .qqwake-entryLabel,[data-sidebar-collapsed] .qqwake-entryLabel{display:none}"
    ].join("");

    /** 注入样式表（只注入一次）。 */
    function ensureCss() {
      if (typeof document === "undefined") return;
      if (document.querySelector("style[data-plugin-css=" + JSON.stringify(CSS_TAG_ID) + "]") !== null) return;
      const style = document.createElement("style");
      style.setAttribute("data-plugin-css", CSS_TAG_ID);
      style.textContent = CSS;
      (document.head ?? document.documentElement).appendChild(style);
    }

    /** 侧边栏外壳根节点（与 community 插件同一套选择器）。 */
    function sidebarRoot() {
      const column = document.querySelector("[data-pane=\"sidebar\"], [class*=\"sidebarCol\"]");
      if (column === null) return undefined;
      return column.querySelector("[class*=\"logoRow\"]")?.parentElement ?? column.firstElementChild;
    }

    /** 「新会话」按钮：新外壳嵌在 logo 行里，老外壳是直接子节点。 */
    function newSessionButton(root) {
      const nested = root.querySelector("button[class*=\"newSession\"]");
      if (nested !== null) return nested;
      for (const child of root.children) if (child.tagName === "BUTTON") return child;
      return undefined;
    }

    /**
     * 把行放到位：优先「技能中心」下一行，其次功能行家族末尾，最后退回新会话下方。
     * @returns {boolean} 是否已就位。
     */
    function placeEntry(root, entry) {
      const skill = root.querySelector(SKILL_SELECTOR);
      if (skill !== null && skill.parentElement === root) {
        if (skill.nextElementSibling !== entry) root.insertBefore(entry, skill.nextElementSibling);
        return true;
      }
      const family = Array.from(root.children).filter(
        (el) => el instanceof HTMLElement && el.matches(FAMILY_SELECTORS.join(", "))
      );
      if (family.length > 0) {
        const last = family[family.length - 1];
        if (last.nextElementSibling !== entry) root.insertBefore(entry, last.nextElementSibling);
        return true;
      }
      const button = newSessionButton(root);
      if (button === undefined && root.firstElementChild === null) return false;
      const row = button?.closest("[class*=\"logoRow\"]");
      const base = row !== null && row !== undefined && row.parentElement === root ? row : button;
      if (base === undefined) {
        root.appendChild(entry);
        return true;
      }
      if (base.nextElementSibling !== entry) root.insertBefore(entry, base.nextElementSibling);
      return true;
    }

    /** 调宿主路由；返回 { ok, ... }，永不抛。 */
    async function callWake(body) {
      try {
        const res = await fetch("/api/qq-wake/wake", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body ?? {})
        });
        const data = await res.json().catch(() => ({}));
        return { httpStatus: res.status, ...data };
      } catch (error) {
        return { ok: false, error: "请求失败：" + (error?.message ?? String(error)) };
      }
    }

    /** 查状态（用于 tooltip）。 */
    async function callStatus() {
      try {
        const res = await fetch("/api/qq-wake/status");
        return await res.json().catch(() => ({}));
      } catch {
        return { ok: false };
      }
    }

    /**
     * 挂载侧边栏按键。
     * @returns {() => void} 卸载函数。
     */
    function mountWakeEntry() {
      if (typeof document === "undefined") return () => {};
      // 旧实例（客户端热更新 / 重复激活）残留的行：它的点击回调已经跟着旧模块一起失效了，
      // 以前这里直接 return 空卸载函数 —— 结果是"按键盘在、点了没反应、新实例永远挂不上"。
      // 现在先摘掉残留行再挂新行（同一时刻仍然只有一行）。
      const stale = document.querySelector(ROW_SELECTOR);
      if (stale !== null && stale.isConnected) {
        console.warn("[qq-wake] 发现残留的旧按键行，先移除再挂载");
        stale.remove();
      }
      ensureCss();

      const entry = document.createElement("button");
      entry.type = "button";
      entry.setAttribute(ROW_ATTRIBUTE, "");
      entry.setAttribute("data-dsh-plugin", "qq-wake");
      entry.setAttribute("data-dsh-part", "sidebar-entry");
      entry.className = "qqwake-entry";
      const iconSpan = document.createElement("span");
      iconSpan.className = "qqwake-entryIcon";
      iconSpan.innerHTML = ICON;
      const labelSpan = document.createElement("span");
      labelSpan.className = "qqwake-entryLabel";
      labelSpan.textContent = LABEL_IDLE;
      entry.append(iconSpan, labelSpan);
      entry.setAttribute("aria-label", LABEL_IDLE);
      entry.title = "唤醒 QQ 机器人（拉起 SnowLuma + qq-bridge，并给管理员发一句「睡醒了」）";

      let revertTimer;
      let busy = false;
      /** 展示一个临时状态，若干毫秒后回到常态。 */
      const flash = (state, label, ms, tooltip) => {
        entry.dataset.qqwakeState = state;
        labelSpan.textContent = label;
        entry.setAttribute("aria-label", label);
        if (typeof tooltip === "string") entry.title = tooltip;
        if (revertTimer !== undefined) clearTimeout(revertTimer);
        if (ms > 0) {
          revertTimer = setTimeout(() => {
            delete entry.dataset.qqwakeState;
            labelSpan.textContent = LABEL_IDLE;
            entry.setAttribute("aria-label", LABEL_IDLE);
          }, ms);
        }
      };

      /** 汇总唤醒结果成一句人话（也塞进 tooltip）。 */
      const describe = (result) => {
        const steps = Array.isArray(result?.steps) ? result.steps : [];
        return steps.map((s) => `${s.ok ? "✓" : "✗"} ${s.name}：${s.detail ?? ""}`).join("\n");
      };

      entry.addEventListener("click", async () => {
        if (busy) return;
        busy = true;
        flash("busy", LABEL_BUSY, 0, "正在拉起机器人…");
        const result = await callWake({});
        busy = false;
        if (result?.ok === true) {
          flash("ok", LABEL_OK, 4000, "已唤醒：" + (result.message ?? "睡醒了") + "\n\n" + describe(result));
        } else {
          flash("fail", LABEL_FAIL, 8000, "唤醒失败：" + (result?.error ?? "未知错误") + "\n\n" + describe(result));
        }
        // 状态回读一次，把最新链路状况写回 tooltip
        // （宿主只回摘要字段：awake / bridgeOk / onebotNickname，桥接原始状态不下发）
        callStatus().then((status) => {
          // 失败提示不能被这次状态回读盖掉（失败时 awake 也可能是 true 的"半醒"状态，
          // 盖掉之后用户看到的就是"已唤醒"，而实际那一步是失败的）。
          if (entry.dataset.qqwakeState === "fail") return;
          if (status?.ok === true && status.awake === true && !busy) {
            const who = status.onebotNickname ?? "";
            entry.title = `已唤醒${who ? "：" + who : ""}（点一下再唤醒一次）`;
          }
        }).catch((error) => console.warn("[qq-wake] 回读状态失败:", error));
      });

      let root;
      let placed = false;
      // 先声明再赋值：tryPlace 里会引用它，早先是 const + 后置声明（靠"调用时机在声明之后"侥幸不炸 TDZ）。
      let rootObserver;
      const tryPlace = () => {
        if (root !== undefined && !root.isConnected) {
          rootObserver?.disconnect();
          root = undefined;
          placed = false;
        }
        if (placed) {
          if (document.body.contains(entry)) return;
          rootObserver?.disconnect();
          root = undefined;
          placed = false;
        }
        root ??= sidebarRoot();
        if (root === undefined) return;
        try {
          placed = placeEntry(root, entry);
        } catch (error) {
          // 以前静默：锚点结构变了的话按键就永远不出现，而控制台一条日志都没有。
          console.warn("[qq-wake] 插入侧边栏行失败（锚点可能已变）:", error);
          placed = false;
        }
        if (placed && rootObserver !== undefined) rootObserver.observe(root, { childList: true, subtree: true });
      };
      const waitObserver = new MutationObserver(() => {
        try { tryPlace(); } catch (error) { console.warn("[qq-wake] 等待锚点失败:", error); }
      });
      waitObserver.observe(document.body, { childList: true, subtree: true });
      rootObserver = new MutationObserver(() => {
        try {
          if (root === undefined || !root.isConnected) {
            placed = false;
            tryPlace();
            return;
          }
          if (!root.contains(entry)) placed = placeEntry(root, entry);
        } catch (error) {
          console.warn("[qq-wake] 自愈重挂失败:", error);
        }
      });
      tryPlace();

      // 挂载时读一次状态，把「机器人现在什么情况」写进 tooltip（不用点也知道）
      callStatus().then((status) => {
        if (status?.ok !== true) return;
        if (status.awake === true) {
          const who = status.onebotNickname ?? "";
          entry.title = `机器人已唤醒${who ? "：" + who : ""}（点一下再唤醒一次）`;
        } else if (status.bridgeOk === true) {
          entry.title = "机器人半醒：桥接在跑，但 QQ 没登录上（点一下试试）";
        } else {
          entry.title = "机器人未运行（点一下唤醒）";
        }
      }).catch(() => {});

      return () => {
        try { waitObserver.disconnect(); } catch (error) { console.warn("[qq-wake] 卸载观察器失败:", error); }
        try { rootObserver?.disconnect(); } catch (error) { console.warn("[qq-wake] 卸载观察器失败:", error); }
        if (revertTimer !== undefined) clearTimeout(revertTimer);
        entry.remove();
      };
    }

    /** 本插件不依赖任何客户端服务。 */
    const inject = [];

    /**
     * 挂载按键。任何异常都只记日志，绝不向外抛（否则整个 Web 外壳起不来）。
     * @param {object} ctx 客户端根上下文。
     */
    function apply(ctx) {
      try {
        const dispose = mountWakeEntry();
        try {
          ctx?.effect?.(() => () => {
            try { dispose(); } catch {}
          }, "qq-wake: sidebar entry");
        } catch {}
      } catch (error) {
        console.warn("[qq-wake] 挂载失败:", error);
      }
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
  });
} catch (error) {
  console.warn("[qq-wake] 客户端半侧加载失败:", error);
}
