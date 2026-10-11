/* 由 build.mjs 生成，请勿直接编辑；改 client.js 或 selection-ask.css 后重新构建。 */
window.__ModuleLoader__.load({
  id: "dsh-selection-ask",
  factory: function (require) {
    var module = { exports: {} };
    var __esRequire = require;
/**
 * dsh-selection-ask —— 浏览器半边（源码；由 build.mjs 包进 loader 工厂）
 *
 * 做什么：在 DSH 网页里选中任意文本 → 浮出一个小条 → 「引用到对话」把这段
 * 文本以 markdown 引用块追加进输入框，光标落到末尾，你接着写问题。
 *
 * 为什么挂在 `conversation.input.right` 这个插槽上：
 *   我们需要 `inputActions.setDraft()` 这个**公开的输入动作**才能写进输入框，
 *   而它只作为「会话作用域的插槽标准属性」发给插槽组件。所以我们的组件必须
 *   是会话作用域插槽的一个 occupant —— 哪怕它自己只画一个 1px 的锚点。
 *
 * 为什么浮层走 portal 而不是就地渲染：
 *   插槽在输入框工具行里，那一层可能有 `overflow` / `transform` / flex 约束，
 *   就地渲染一个 `position: fixed` 元素会被这些约束吃掉（元素看起来"贴"在
 *   工具行上而不是选区旁）。`createPortal(…, document.body 下的宿主 div)`
 *   让 DOM 真的落在 body 上，定位与选区一一对应，不受插槽布局影响。
 *   锚点元素仍留在插槽里 —— 用它反查输入框编辑器，不需要知道任何宿主类名。
 *
 * 零依赖：React / react-dom 从平台的模块表里 require（宿主已内置，不打包）。
 */
(function () {
  "use strict";

  var PACKAGE_ID = "dsh-selection-ask";
  /**
   * 样式。占位符由 `build.mjs` 换成 `selection-ask.css` 的正文（JSON 字符串字面量）——
   * **不要手改这一行**：改样式改 `selection-ask.css`，然后 `node build.mjs`。
   */
  var CSS = "/*\n * dsh-selection-ask —— 全部样式\n *\n * 配色一律走宿主的 design token，并带兜底值：\n * 宿主浅色主题下就是浅色浮层、深色主题下就是深色浮层，插件不需要自己判断主题。\n *\n * ⚠️ 兜底值只在宿主 token 缺失时才生效。**写兜底值也要按\"深色底 / 浅色底\"两套走**\n *   （见文件末尾的 `prefers-color-scheme: dark` 段），否则一旦 token 没了，\n *   深色宿主上会出现\"白底白字\"。\n *\n * ⚠️ 对比度是量过的，不是估的（沿用 dsh-effort-slider 2026-10-07 的教训）：\n *   正文小字用 `--dsw-alias-label-primary`，\n *   **不要用 `--dsw-alias-label-tertiary`** —— 它在宿主自己的浅色底上只有 3.71:1，不够 4.5:1。\n */\n\n/* ───────────────────────── 浮层本体 ───────────────────────── */\n\n.dsa-root {\n  position: fixed;\n  z-index: 2147483000;\n  /*\n   * ⚠️ 这一行是**必须**的，不是可选修饰。\n   *\n   * portal 宿主（body 下那个 div）设了 `pointer-events: none` —— 目的是让那一层\n   * 对页面完全透明。但 `pointer-events` 是**继承属性**：浮层不把 `auto` 设回来，\n   * 它就跟着一起变成\"点击穿透\"。\n   *\n   * 症状极具欺骗性：浮层**画得出来、位置也对**，但鼠标事件全部落到下面的正文上，\n   * 于是 mousedown 的\"点到别处就收起\"先把浮层收掉，click 永远到不了按钮 ——\n   * 表现为\"点了没反应，浮层自己消失了\"。\n   *\n   * 实测来源：2026-10-11 端到端验收（`elementFromPoint` 命中浮层下方的正文）。\n   */\n  pointer-events: auto;\n  display: flex;\n  align-items: center;\n  gap: 2px;\n  padding: 4px;\n  box-sizing: border-box;\n  border-radius: 10px;\n  border: 1px solid var(--dsw-alias-border-l1, rgba(15, 17, 21, 0.06));\n  background: var(--dsw-specific-menu, var(--dsw-alias-bg-layer-3, #ffffff));\n  box-shadow: var(\n    --dsw-elevation-prominent,\n    0 3px 8px rgba(15, 17, 21, 0.06),\n    0 0 20px rgba(15, 17, 21, 0.05)\n  );\n  color: var(--dsw-alias-label-primary, #0f1115);\n  font-family: inherit;\n  font-size: 13px;\n  line-height: 1;\n  /* 浮层自己不该被选中，也不该继承宿主的选择行为 */\n  -webkit-user-select: none;\n  user-select: none;\n  -webkit-tap-highlight-color: transparent;\n  animation: dsa-pop 0.12s ease-out;\n}\n\n@keyframes dsa-pop {\n  from {\n    opacity: 0;\n    transform: translateY(3px) scale(0.98);\n  }\n  to {\n    opacity: 1;\n    transform: none;\n  }\n}\n\n@media (prefers-reduced-motion: reduce) {\n  .dsa-root {\n    animation: none;\n  }\n}\n\n/* ───────────────────────── 按钮 ───────────────────────── */\n\n.dsa-btn {\n  display: inline-flex;\n  align-items: center;\n  gap: 6px;\n  height: 26px;\n  padding: 0 9px;\n  margin: 0;\n  border: 0;\n  border-radius: 7px;\n  background: transparent;\n  color: var(--dsw-alias-label-primary, #0f1115);\n  font: inherit;\n  font-size: 12.5px;\n  line-height: 1;\n  white-space: nowrap;\n  cursor: pointer;\n  appearance: none;\n}\n\n.dsa-btn:hover {\n  background: var(--dsw-alias-interactive-bg-hover, rgba(15, 17, 21, 0.06));\n}\n\n.dsa-btn:active {\n  background: var(--dsw-alias-interactive-bg-active, rgba(15, 17, 21, 0.09));\n}\n\n.dsa-btn:focus-visible {\n  outline: 2px solid var(--dsw-alias-brand-primary, #4a6cf7);\n  outline-offset: 1px;\n}\n\n.dsa-ico {\n  display: block;\n  width: 14px;\n  height: 14px;\n  flex: none;\n  opacity: 0.85;\n}\n\n.dsa-btn:hover .dsa-ico {\n  opacity: 1;\n}\n\n/* ───────────────────────── 「已引用」提示 ───────────────────────── */\n\n/*\n * 位置不写死 —— 由 Toast 组件量完自身尺寸后算出来（贴在刚才那次选区旁边）。\n * 这里只负责外观。\n */\n.dsa-toast {\n  position: fixed;\n  z-index: 2147483000;\n  pointer-events: none; /* 提示不拦截任何点击；它不是按钮 */\n  max-width: 60vw;\n  padding: 7px 12px;\n  border-radius: 999px;\n  border: 1px solid var(--dsw-alias-border-l1, rgba(15, 17, 21, 0.06));\n  background: var(--dsw-specific-menu, var(--dsw-alias-bg-layer-3, #ffffff));\n  box-shadow: var(\n    --dsw-elevation-prominent,\n    0 3px 8px rgba(15, 17, 21, 0.06),\n    0 0 20px rgba(15, 17, 21, 0.05)\n  );\n  color: var(--dsw-alias-label-primary, #0f1115);\n  font-family: inherit;\n  font-size: 12.5px;\n  line-height: 1.2;\n  white-space: nowrap;\n  overflow: hidden;\n  text-overflow: ellipsis;\n  -webkit-user-select: none;\n  user-select: none;\n  animation: dsa-toast-in 0.14s ease-out;\n}\n\n@keyframes dsa-toast-in {\n  from {\n    opacity: 0;\n    transform: translateY(3px);\n  }\n  to {\n    opacity: 1;\n    transform: none;\n  }\n}\n\n@media (prefers-reduced-motion: reduce) {\n  .dsa-toast {\n    animation: none;\n  }\n}\n\n/* ─────────── 兜底配色：宿主 token 全缺时的深色底 ─────────── */\n\n@media (prefers-color-scheme: dark) {\n  .dsa-root,\n  .dsa-toast {\n    background: var(--dsw-specific-menu, var(--dsw-alias-bg-layer-3, #353638));\n    color: var(--dsw-alias-label-primary, #e9edf6);\n    border-color: var(--dsw-alias-border-l1, rgba(255, 255, 255, 0.12));\n  }\n\n  .dsa-btn {\n    color: var(--dsw-alias-label-primary, #e9edf6);\n  }\n\n  .dsa-btn:hover {\n    background: var(--dsw-alias-interactive-bg-hover, rgba(255, 255, 255, 0.08));\n  }\n\n  .dsa-btn:active {\n    background: var(--dsw-alias-interactive-bg-active, rgba(255, 255, 255, 0.12));\n  }\n}\n";
  /** 我们自己画的所有 DOM 都带这个属性 —— 用"选中我们自己的字"来排除自引用。 */
  var OWN_ATTR = "data-selection-ask";
  /** 浮层与选区之间的间隙（px）。 */
  var GAP = 8;
  /** 浮层与视口边缘的最小距离（px）。 */
  var EDGE = 8;
  /** 单次引用上限：超出就截断。防止一次误选把几十万字符灌进输入框。 */
  var MAX_QUOTE_CHARS = 8000;
  /** 「已引用」提示停留时长（ms）。 */
  var FLASH_MS = 700;

  /* ──────────────────────────── 文案 ──────────────────────────── */
  var STRINGS = {
    zh: {
      quote: "引用到对话",
      quoted: "已引用",
      truncated: "内容过长，已截断",
      unavailable: "拿不到输入框（插件未生效）",
      aria: "把选中的文本引用到输入框"
    },
    en: {
      quote: "Add to conversation",
      quoted: "Added",
      truncated: "Selection truncated",
      unavailable: "Composer unavailable",
      aria: "Quote the selected text into the composer"
    }
  };

  /** 从 navigator 猜语言：中文系一律走 zh，其余 en。取不到就 en。 */
  function pickLang() {
    var nav = typeof navigator !== "undefined" ? navigator : null;
    var raw = (nav && (nav.language || (nav.languages && nav.languages[0]))) || "en";
    return String(raw).toLowerCase().indexOf("zh") === 0 ? "zh" : "en";
  }

  /* ──────────────────────── 纯函数（可单测） ──────────────────────── */

  /**
   * 把一段文本变成 markdown 引用块。
   *
   * 三个细节都是有意的：
   *  · 统一换行：`\r\n` / `\r` 都归一成 `\n`，否则 Windows 上复制来的文本
   *    会在引用块里多出一堆空 `>` 行；
   *  · 空行写成裸 `>`（不带尾空格）—— 带尾空格的 `> ` 在渲染时是"空引用行"，
   *    在不那么严格的渲染器里会被吃掉，导致引用块的段落结构丢失；
   *  · 结尾的换行先去掉再切分，避免末尾多出一条空引用行。
   *
   * @param {string} text 选中文本
   * @returns {string} 每行以 `> ` 开头的引用块
   */
  function quoteMarkdown(text) {
    var normalized = String(text == null ? "" : text).replace(/\r\n?/g, "\n").replace(/\n+$/, "");
    if (normalized === "") return "";
    return normalized.split("\n").map(function (line) {
      return line === "" ? ">" : "> " + line;
    }).join("\n");
  }

  /**
   * 把引用块并进当前草稿。
   *
   * 规则：已有内容 → 空一行再引用；空草稿 → 直接引用。引用块之后留一个空行，
   * 光标落在那里接着写问题（这是「引用完就问」这个动作的默认节奏）。
   *
   * @param {string} draft 当前草稿
   * @param {string} quote 已经是引用块的文本
   * @returns {string} 新草稿
   */
  function composeDraft(draft, quote) {
    var head = String(draft == null ? "" : draft).replace(/\s+$/, "");
    if (quote === "") return head;
    return (head === "" ? "" : head + "\n\n") + quote + "\n\n";
  }

  /**
   * 这个节点是不是"不该触发浮层"的地方。
   *
   * 排除三类：
   *  · 可编辑区（`contenteditable`，含输入框自己）—— 在里面选中是在编辑，不是引用；
   *  · 原生表单控件（input / textarea / select）；
   *  · 我们自己画的浮层。
   *
   * @param {Node} node 选区里任意一个节点
   * @returns {boolean}
   */
  function isExcludedNode(node) {
    var el = node && node.nodeType === 1 ? node : (node ? node.parentElement : null);
    while (el && el !== document.body) {
      if (el.getAttribute) {
        var editable = el.getAttribute("contenteditable");
        // `contenteditable=""` 与 `"true"` 都为真；`"false"` 不是。
        if (editable === "" || editable === "true") return true;
        if (el.hasAttribute(OWN_ATTR)) return true;
        var tag = el.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
      }
      el = el.parentElement;
    }
    return false;
  }

  /**
   * 把浮层摆到锚点矩形旁边。
   *
   * 锚点取**选区最后一个矩形**（鼠标松开的地方），不是整个选区的外框 ——
   * 选三大段时外框的顶边可能在屏幕外，浮层会飘到看不见的地方去。
   *
   * 竖直方向优先放在选区上方；放不下就翻到下方；两边都放不下就贴边夹住。
   * 水平方向居中于锚点，并夹进视口。
   *
   * @param {{left:number,top:number,width:number,height:number,bottom:number}} anchor 锚点矩形
   * @param {{width:number,height:number}} size 浮层尺寸
   * @param {{width:number,height:number}} viewport 视口尺寸
   * @param {'above'|'below'} [prefer] 首选方向；默认上方（浮层用），提示用下方
   * @returns {{left:number,top:number}} 最终位置
   */
  function clampPosition(anchor, size, viewport, prefer) {
    var top;
    if (prefer === "below") {
      // 「已引用」提示走这条：落在选中行下方，不遮住刚引用的那句话。
      top = anchor.bottom + GAP;
      if (top + size.height > viewport.height - EDGE) top = anchor.top - size.height - GAP;
    } else {
      top = anchor.top - size.height - GAP;
      if (top < EDGE) top = anchor.bottom + GAP;
    }
    if (top + size.height > viewport.height - EDGE) {
      top = Math.max(EDGE, viewport.height - size.height - EDGE);
    }
    if (top < EDGE) top = EDGE;
    var left = anchor.left + anchor.width / 2 - size.width / 2;
    var maxLeft = viewport.width - size.width - EDGE;
    if (left > maxLeft) left = maxLeft;
    if (left < EDGE) left = EDGE;
    return { left: Math.round(left), top: Math.round(top) };
  }

  /**
   * 现在有没有模态对话框开着。
   *
   * 为什么要判它：模态框走的是浏览器的 **top layer**，它盖在所有 z-index 之上 ——
   * 我们的浮层无论 z-index 写多大都会被压住。结果是"浮层看得见、点不着"，
   * 比不出现更糟。而且模态框开着的时候，用户本来就选不到底下的正文。
   *
   * 实测来源：2026-10-11 首次端到端验收，应用的「内测声明」首启弹窗把浮层整个盖住，
   * `document.elementFromPoint` 命中的是弹窗标题而不是按钮。
   *
   * @returns {boolean}
   */
  function hasOpenModal() {
    try {
      return document.querySelector('dialog[open], [aria-modal="true"]') !== null;
    } catch (error) {
      return false;
    }
  }

  /**
   * 读当前选区；不满足浮层条件时返回 null。
   *
   * @returns {{text:string, truncated:boolean, anchor:object}|null}
   */
  function readSelection() {
    if (typeof window === "undefined" || !document.body) return null;
    if (hasOpenModal()) return null;
    var sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
    var text = sel.toString();
    if (!text || text.trim() === "") return null;
    var range = sel.getRangeAt(0);
    if (isExcludedNode(range.commonAncestorContainer)) return null;

    var rects = range.getClientRects();
    var rect = rects && rects.length > 0 ? rects[rects.length - 1] : range.getBoundingClientRect();
    if (!rect || (rect.width === 0 && rect.height === 0)) return null;

    var truncated = false;
    if (text.length > MAX_QUOTE_CHARS) {
      text = text.slice(0, MAX_QUOTE_CHARS);
      truncated = true;
    }
    return {
      text: text,
      truncated: truncated,
      anchor: {
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height,
        bottom: rect.bottom
      }
    };
  }

  /**
   * 从插槽里的锚点元素反查输入框的可编辑元素。
   *
   * 不写死任何宿主类名：从锚点往上走，**第一个包含 contenteditable 的祖先**
   * 就是输入框卡片。这个判据只依赖 DOM 结构关系，宿主改类名不会失效。
   *
   * @param {Element|null} anchorEl
   * @returns {HTMLElement|null}
   */
  function findEditor(anchorEl) {
    var el = anchorEl;
    while (el && el !== document.body) {
      if (el.querySelector) {
        var found = el.querySelector('[contenteditable="true"], [contenteditable=""]');
        if (found) return found;
      }
      el = el.parentElement;
    }
    return null;
  }

  /** 把光标放到可编辑元素的末尾（尽力而为；失败不影响已经写进去的草稿）。 */
  function caretToEnd(editor) {
    if (!editor) return;
    try {
      editor.focus({ preventScroll: true });
    } catch (error) {
      try { editor.focus(); } catch (ignored) { /* 聚焦失败就只是没聚焦 */ }
    }
    try {
      var sel = window.getSelection();
      if (!sel) return;
      var range = document.createRange();
      range.selectNodeContents(editor);
      range.collapse(false);
      sel.removeAllRanges();
      sel.addRange(range);
    } catch (ignored) { /* 光标没落上不算错误 */ }
  }

  /* ──────────────────────────── 图标 ──────────────────────────── */

  /** 引用号图标（两个引号），用 stroke 画，跟着 currentColor 走。 */
  function quoteIcon(h) {
    return h("svg", {
      className: "dsa-ico",
      viewBox: "0 0 16 16",
      fill: "none",
      stroke: "currentColor",
      strokeWidth: 1.5,
      strokeLinecap: "round",
      strokeLinejoin: "round",
      "aria-hidden": "true"
    }, [
      h("path", { key: "a", d: "M6.4 3.8H3.2v3.4h3.2v1.4c0 1.7-1 2.7-2.7 3.2" }),
      h("path", { key: "b", d: "M12.8 3.8H9.6v3.4h3.2v1.4c0 1.7-1 2.7-2.7 3.2" })
    ]);
  }

  /* ──────────────────────────── 插件体 ──────────────────────────── */

  /**
   * 造出 `apply` —— 把 require 注入进来（构建产物里由工厂提供）。
   *
   * @param {Function|null} requireFn 平台模块加载器的 require
   * @returns {(ctx: any) => void}
   */
  function createApply(requireFn) {
    return function apply(ctx) {
      var React = null;
      var ReactDOM = null;
      try { React = requireFn("react"); } catch (error) { React = null; }
      try { ReactDOM = requireFn("react-dom"); } catch (error) { ReactDOM = null; }
      if (!React || !ReactDOM) {
        // 拿不到运行时就什么都别做 —— 但要说清楚，不要静默隐身。
        console.error("[" + PACKAGE_ID + "] 平台模块表里取不到 react / react-dom，插件不会挂载。");
        return;
      }
      var h = React.createElement;
      var lang = pickLang();
      var T = STRINGS[lang] || STRINGS.en;

      /* ---------- 样式：优先走宿主的 styles 服务，拿不到就自己插一个 <style> ---------- */
      // 服务目录本身也可能抛（宿主插件加载中途）。`apply` 抛出去会让这个 entry
      // 加载失败，所以这里连"查服务"这一步都兜住。
      var styles = null;
      try {
        styles = ctx.get ? ctx.get("styles") : null;
      } catch (error) {
        styles = null;
      }
      if (styles && typeof styles.insert === "function") {
        ctx.effect(function () { return styles.insert(CSS); }, PACKAGE_ID + ": styles");
      } else {
        var styleNode = document.createElement("style");
        styleNode.setAttribute("data-plugin", PACKAGE_ID);
        styleNode.textContent = CSS;
        document.head.appendChild(styleNode);
        ctx.effect(function () {
          return function () {
            if (styleNode.parentElement) styleNode.parentElement.removeChild(styleNode);
          };
        }, PACKAGE_ID + ": styles");
      }

      /* ---------- portal 宿主：一个挂在 body 上的固定层 ---------- */
      var hostEl = null;
      function ensureHost() {
        if (hostEl && hostEl.isConnected) return hostEl;
        hostEl = document.createElement("div");
        hostEl.setAttribute(OWN_ATTR, "");
        hostEl.setAttribute("data-dsa-host", "");
        // `pointer-events:none` 让这一层对页面完全透明：只有浮层自己接收点击。
        hostEl.style.cssText =
          "position:fixed;left:0;top:0;width:0;height:0;pointer-events:none;z-index:2147483000;";
        document.body.appendChild(hostEl);
        return hostEl;
      }

      /* ---------- 「已引用」提示：贴着刚才那次选区出现 ---------- */
      /**
       * 为什么不固定贴在屏幕底部：输入框卡片的高度是变的（多行草稿会撑高），
       * 固定 bottom 的提示迟早会压到输入框上 —— 2026-10-11 的截图里它正好糊在
       * 输入框第一行上。贴着**用户刚才看的地方**出现，既不会撞到任何东西，
       * 也不用猜输入框现在多高。
       */
      function Toast(props) {
        var ref = React.useRef(null);
        var posState = React.useState(null);
        var pos = posState[0];
        var setPos = posState[1];

        React.useLayoutEffect(function () {
          var el = ref.current;
          if (!el) return;
          var rect = el.getBoundingClientRect();
          setPos(clampPosition(props.anchor, {
            width: rect.width,
            height: rect.height
          }, {
            width: window.innerWidth,
            height: window.innerHeight
          }, "below"));
        }, [props.anchor]);

        return h("div", {
          ref: ref,
          className: "dsa-toast",
          "data-dsa": "toast",
          role: "status",
          style: pos
            ? { left: pos.left + "px", top: pos.top + "px" }
            : { left: "0px", top: "0px", visibility: "hidden" }
        }, props.text);
      }

      /* ---------- 浮层 ---------- */
      function Toolbar(props) {
        var selection = props.selection;
        var onQuote = props.onQuote;
        var ref = React.useRef(null);
        var posState = React.useState(null);
        var pos = posState[0];
        var setPos = posState[1];

        // 量一次再落位：浮层宽度取决于文案（中英文长度差很多），
        // 写死宽度会在另一种语言下偏出选区。
        React.useLayoutEffect(function () {
          var el = ref.current;
          if (!el || !selection) return;
          var rect = el.getBoundingClientRect();
          var next = clampPosition(selection.anchor, {
            width: rect.width,
            height: rect.height
          }, {
            width: window.innerWidth,
            height: window.innerHeight
          });
          // 探针放在 layout effect 里而不是 render 里：render 期间做副作用是错的。
          setPos(next);
        }, [selection]);

        if (!selection) return null;
        return h("div", {
          ref: ref,
          className: "dsa-root",
          role: "toolbar",
          "data-dsa": "toolbar",
          style: pos
            ? { left: pos.left + "px", top: pos.top + "px" }
            : { left: "0px", top: "0px", visibility: "hidden" },
          // 关键：不 preventDefault 的话，按下按钮会先把选区清掉，
          // 等 click 触发时选区已经没了（拿不到文本）。
          onMouseDown: function (event) { event.preventDefault(); }
        }, [
          h("button", {
            key: "quote",
            type: "button",
            className: "dsa-btn",
            "data-dsa": "quote",
            title: T.aria,
            "aria-label": T.aria,
            onMouseDown: function (event) { event.preventDefault(); },
            onClick: function (event) {
              event.preventDefault();
              onQuote(selection);
            }
          }, [quoteIcon(h), h("span", { key: "t" }, T.quote)])
        ]);
      }

      /* ---------- 插槽 occupant：锚点 + 浮层的真正主人 ---------- */
      function SelectionAskSlot(props) {
        var anchorRef = React.useRef(null);
        var [selection, setSelection] = React.useState(null);
        var [flash, setFlash] = React.useState(null);
        var inputActions = props ? props.inputActions : null;
        var useInput = props ? props.useInput : null;
        // 草稿通过会话标准属性读；拿不到就当空草稿（引用仍会写进去，只是不追加）。
        var draft = useInput ? useInput(function (state) { return state.draft; }) : "";

        React.useEffect(function () {
          var frame = 0;
          function flush() {
            frame = 0;
            var next = readSelection();
            setSelection(next);
          }
          function schedule() {
            if (frame) return;
            frame = window.requestAnimationFrame(flush);
          }
          function onPointerDown(event) {
            var target = event.target;
            // 点浮层自己不算"点到别处"（否则按下就消失了，click 永远收不到）。
            if (target && target.closest && target.closest("[" + OWN_ATTR + "]")) return;
            setSelection(null);
          }
          function onKeyDown(event) {
            if (event.key === "Escape") setSelection(null);
          }
          document.addEventListener("selectionchange", schedule);
          document.addEventListener("mousedown", onPointerDown, true);
          document.addEventListener("touchstart", onPointerDown, true);
          document.addEventListener("keydown", onKeyDown, true);
          window.addEventListener("resize", schedule);
          window.addEventListener("scroll", schedule, true);
          return function () {
            if (frame) window.cancelAnimationFrame(frame);
            document.removeEventListener("selectionchange", schedule);
            document.removeEventListener("mousedown", onPointerDown, true);
            document.removeEventListener("touchstart", onPointerDown, true);
            document.removeEventListener("keydown", onKeyDown, true);
            window.removeEventListener("resize", schedule);
            window.removeEventListener("scroll", schedule, true);
          };
        }, []);

        var quote = React.useCallback(function (picked) {
          var editor = findEditor(anchorRef.current);
          var block = quoteMarkdown(picked.text);
          if (block === "") return;
          setSelection(null);
          if (!inputActions || typeof inputActions.setDraft !== "function") {
            console.error("[" + PACKAGE_ID + "] 插槽没有给出 inputActions.setDraft，无法写进输入框。");
            return;
          }
          try {
            inputActions.setDraft(composeDraft(draft, block));
          } catch (error) {
            console.error("[" + PACKAGE_ID + "] 写入草稿失败：", error);
            return;
          }
          // setDraft 之后光标位置由编辑器自己决定；这里把它推到末尾，
          // 让"引用完接着写问题"这个动作不需要再用鼠标点一下。
          window.requestAnimationFrame(function () { caretToEnd(editor); });
          setFlash(picked.truncated
            ? { text: T.truncated + "（" + picked.text.length + " 字）", anchor: picked.anchor }
            : { text: T.quoted, anchor: picked.anchor });
          window.setTimeout(function () { setFlash(null); }, FLASH_MS);
        }, [draft, inputActions, T]);

        var anchor = h("span", {
          key: "anchor",
          ref: anchorRef,
          "data-dsa": "anchor",
          style: { display: "none" }
        });

        var overlay = selection
          ? ReactDOM.createPortal(
            h(Toolbar, { selection: selection, onQuote: quote }),
            ensureHost()
          )
          : null;

        if (flash) {
          return h(React.Fragment, null, anchor, overlay, ReactDOM.createPortal(
            h(Toast, { text: flash.text, anchor: flash.anchor }),
            ensureHost()
          ));
        }
        return h(React.Fragment, null, anchor, overlay);
      }

      /* ---------- 注册 ---------- */
      ctx.effect(function () {
        if (!ctx.slots || typeof ctx.slots.inject !== "function") {
          console.error("[" + PACKAGE_ID + "] ctx.slots 不可用，插件不会挂载。");
          return function () {};
        }
        // `inject` 保证"插槽出现后才注册、插槽消失就撤掉"，并且每次贡献名单
        // 变化都会重新跑一遍 —— 这是插槽系统的既有约定，不是我们发明的。
        return ctx.slots.inject("conversation.input.right", function () {
          return ctx.slots.register({
            name: "conversation.input.right",
            id: PACKAGE_ID,
            order: 40,
            label: function () { return STRINGS[lang].quote; }
          }, SelectionAskSlot);
        });
      }, PACKAGE_ID + ": composer anchor");

      ctx.effect(function () {
        return function () {
          if (hostEl && hostEl.parentElement) hostEl.parentElement.removeChild(hostEl);
          hostEl = null;
        };
      }, PACKAGE_ID + ": portal host");
    };
  }

  /** 需要宿主保证的服务：插槽注册表。少了它注册不了 component。 */
  var inject = ["slots"];

  /**
   * 模块导出 —— 官方形状是「factory 的返回值 = 模块 exports」。
   * 不用全局变量当导出通道：模块系统会缓存已物化的模块，走全局会在 HMR
   * 重物化时拿到陈旧导出。
   */
  var __initialRequire = (typeof __esRequire === "function") ? __esRequire : null;
  module.exports = {
    apply: createApply(__initialRequire),
    inject: inject,
    __internals: {
      quoteMarkdown: quoteMarkdown,
      composeDraft: composeDraft,
      isExcludedNode: isExcludedNode,
      hasOpenModal: hasOpenModal,
      clampPosition: clampPosition,
      pickLang: pickLang,
      STRINGS: STRINGS,
      createApply: createApply
    }
  };
})();


    if (module.exports && typeof module.exports.apply === 'function') return module.exports;
    throw new Error("dsh-selection-ask: bundle 未设置导出（require 或模块体有问题）");
  },
});
