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
  /** 宿主半边提供的流式问答端点（见 index.mjs）。 */
  var ASK_ENDPOINT = "/plugins/dsh-selection-ask/ask";
  /**
   * 注册进输入框触发器管道的「引用源」名字。
   *
   * 它是胶囊与模型文本之间的路由键：胶囊里存的 `ref` 靠它找回我的 codec，
   * 发送时由 codec 把编号展开成引用块原文。
   */
  var REF_SOURCE = "selection";
  /**
   * 样式。占位符由 `build.mjs` 换成 `selection-ask.css` 的正文（JSON 字符串字面量）——
   * **不要手改这一行**：改样式改 `selection-ask.css`，然后 `node build.mjs`。
   */
  var CSS = __SELECTION_ASK_CSS__;
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
      aria: "把选中的文本引用到输入框",
      /** 胶囊上显示的编号前缀 —— 对应参考图的「选中文本 1」。 */
      chipPrefix: "选中文本",
      /** 就地输入栏的占位文案（参考图的「输入你的评论…」）。 */
      annotate: "输入你的批注，或直接引用…",
      commit: "引用",
      commitAria: "把这段和批注一起加进输入框",
      askAriaSide: "在右侧栏就这段内容单独提问",
      ask: "侧边提问",
      askAria: "在右侧栏开一个独立对话，就这段内容提问",      askFailed: "侧边栏不可用，无法开侧边对话",
      sideTitle: "侧边提问",
      quoteLabel: "引用的原文",
      expand: "展开",
      collapse: "收起",
      placeholder: "就这段内容提问…（Enter 发送，Shift+Enter 换行）",
      send: "发送",
      stop: "停止",
      clear: "清空",
      thinking: "思考中…",
      assistant: "回答",
      you: "你",
      empty: "选中一段文字、点「侧边提问」，答案会出现在这里，不会进主对话。",
      failed: "出错了"
    },
    en: {
      quote: "Add to conversation",
      quoted: "Added",
      truncated: "Selection truncated",
      unavailable: "Composer unavailable",
      aria: "Quote the selected text into the composer",
      chipPrefix: "Selection",
      annotate: "Add a note, or just quote…",
      commit: "Quote",
      commitAria: "Add this passage and your note to the composer",
      askAriaSide: "Ask about this passage in a separate side conversation",
      ask: "Ask aside",
      askAria: "Open a separate side conversation about this passage",
      askFailed: "Sidebar unavailable — cannot open the side conversation",
      sideTitle: "Ask aside",
      quoteLabel: "Quoted passage",
      expand: "Expand",
      collapse: "Collapse",
      placeholder: "Ask about this passage… (Enter to send, Shift+Enter for a newline)",
      send: "Send",
      stop: "Stop",
      clear: "Clear",
      thinking: "Thinking…",
      assistant: "Answer",
      you: "You",
      empty: "Select a passage and click \"Ask aside\" — the answer shows up here and never enters the main conversation.",
      failed: "Something went wrong"
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
   * 从"登记处里的全部引用"里挑出**这一帧该画标注的**那些。
   *
   * 唯一事实源是**输入框里的胶囊**：
   *
   * ```
   * 胶囊在    →  高亮在、编号在
   * 胶囊没了  →  高亮走、编号走
   * ```
   *
   * 为什么要有这一步：登记处、胶囊、原文标注原本是**三处各自活着的状态**，
   * 在输入框里把胶囊删掉，另外两处根本不知道 —— 表现就是"删了引用，
   * 原文的高亮和编号还赖着不走"（2026-10-11 他实测报的）。
   *
   * @param {Array<{n:number, text:string, ref:string}>} records 登记处里的全部记录
   * @param {string[]|null} labels 输入框里现存的胶囊 label；**null ＝ 拿不到输入框**
   * @param {(record:object) => string} labelOf 记录 → 胶囊 label
   * @returns {Array<object>} 命中的记录，保持登记顺序
   */
  function liveQuoteRecords(records, labels, labelOf) {
    var all = Array.isArray(records) ? records : [];
    // 拿不到输入框（插槽还没挂上、会话还没开）时按"一条都没删"处理：
    // 宁可多画几笔，也不要因为读不到宿主的 DOM 就把用户已经标注好的高亮全抹掉。
    if (!Array.isArray(labels)) return all.slice();
    var live = Object.create(null);
    for (var index = 0; index < labels.length; index += 1) live[String(labels[index])] = true;
    return all.filter(function (record) {
      return live[String(labelOf(record))] === true;
    });
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

  /** 焦点是不是在我们自己画的浮层里。 */
  function ownOverlayHasFocus() {
    var active = typeof document !== "undefined" ? document.activeElement : null;
    return !!(active && active.closest && active.closest("[" + OWN_ATTR + "]"));
  }

  /**
   * 读当前选区；不满足浮层条件时返回 null。
   *
   * `range` 也一并带出去：浮层一出现就会自动聚焦，而"聚焦一个 input"会让浏览器
   * **当场清掉文档选区** —— 那片蓝色看起来"凭空消失"。有了这个 Range，我们就能
   * 用自己的待定高亮把它接管过来（见 `PENDING_KEY`）。
   *
   * @returns {{text:string, truncated:boolean, anchor:object, range:Range}|null}
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
      // 活的 DOM Range（不是字符偏移）—— 待定高亮直接用它，浮层开着这一会儿够用。
      range: range,
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

  /** 侧边对话图标：一个方框右上角挑出一个气泡。 */
  function askIcon(h) {
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
      h("rect", { key: "a", x: 1.8, y: 2.6, width: 8.6, height: 9.6, rx: 1.6 }),
      h("path", { key: "b", d: "M13.2 5.6h1v6.4l-2.1-1.6" })
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

      /* ---------- 引用登记处：编号就是身份 ---------- */
      /**
       * 编号在**一个页面生命周期内全局递增**（选中文本 1、2、3…）——
       * 参考图里就是这个语义。
       *
       * 同一段文字被再次引用时**复用原来的编号**：同一处标注不该有两个号，
       * 否则原文上的高亮会出现两个圆标指着同一句话。
       */
      var quoteSeq = 0;
      var quoteByRef = new Map();
      var quoteByText = new Map();
      /** 胶囊在 DOM 上只有 label（title="选中文本 1"），没有 ref —— 靠它反查。 */
      var quoteByLabel = new Map();
      /**
       * 已经插进输入框的胶囊，在**剪贴板投影**里一共占了多少字符。
       *
       * 用来算下一个胶囊的插入点：`draft` 是剪贴板投影（胶囊在里面占位），
       * 而编辑坐标里它几乎不占位 —— 两者差的就是这个数（2026-10-11 实测）。
       */
      var chipClipTotal = 0;

      /** 给一段原文分配（或取回）它的编号记录。 */
      function registerQuote(text) {
        var existing = quoteByText.get(text);
        if (existing) return existing;
        quoteSeq += 1;
        var record = { n: quoteSeq, text: text, ref: "q" + quoteSeq };
        quoteByRef.set(record.ref, record);
        quoteByText.set(text, record);
        quoteByLabel.set(chipLabel(record), record);
        // 新引用一进来就重算标注（节流到每帧一次）
        scheduleHighlightSync();
        return record;
      }

      /** 胶囊上的字。 */
      function chipLabel(record) {
        return T.chipPrefix + " " + record.n;
      }

      /* ---------- 输入框的「引用源」：胶囊 ↔ 模型文本 ---------- */
      /**
       * 这里借的是 DSH 官方的**原子引用胶囊**机制（`@文件` 用的是同一套）：
       * 注册一个源，源里的 `codec.serialize(ref)` 决定**发送时这条引用展开成什么文本**。
       * 所以胶囊只是**显示形态**变了 —— 模型收到的仍然是 `> 引用原文`。
       *
       * 惰性注册：不在 `apply()` 里做，避免为它多声明一个 inject。
       */
      var referenceSourceReady = false;
      function ensureReferenceSource() {
        if (referenceSourceReady) return true;
        var triggers = null;
        try { triggers = ctx.get ? ctx.get("inputTriggers") : null; } catch (error) { triggers = null; }
        if (!triggers || typeof triggers.registerSource !== "function") return false;
        try {
          var dispose = triggers.registerSource({
            trigger: "@",
            name: REF_SOURCE,
            showGroupTitle: false,
            // 本插件不进 `@` 补全菜单：候选恒空，只是借这条管道插胶囊。
            candidates: function () { return []; },
            onPick: function () { return undefined; },
            codec: {
              clipboardText: function (ref) {
                var record = quoteByRef.get(ref);
                return record ? quoteMarkdown(record.text) : ref;
              },
              serialize: function (ref) {
                var record = quoteByRef.get(ref);
                return Promise.resolve(record ? quoteMarkdown(record.text) : "");
              }
            }
          });
          ctx.effect(function () { return dispose; }, PACKAGE_ID + ": reference source");
          referenceSourceReady = true;
          return true;
        } catch (error) {
          console.error("[" + PACKAGE_ID + "] 注册引用源失败，胶囊会退回纯文本：", error);
          return false;
        }
      }

      /**
       * 取会话作用域 —— 输入机的四个事件都挂在它上面。
       *
       * ⚠️ 这里有个坑（2026-10-11 实测踩到，症状是 `emit` 返回 undefined）：
       * 输入机的监听**不是**挂在 `sessions.scope(id)` 上，而是挂在
       * **会话绑定的 ctx** 上 —— `ui-conversation` 的 `shellFor(binding)` 里写的是
       * `const { sessionId, session, ctx: actx } = binding`。用错那个，事件发出去
       * 一个监听者都没有，而且**不会报错**，只会静默地"胶囊不出来"。
       *
       * 两个都返回，调用方按顺序试 —— 宿主版本换了也不会整个失灵。
       *
       * @returns {Array<{via: string, actx: object}>}
       */
      function sessionScopes(sessionId) {
        var found = [];
        var sessions = null;
        try { sessions = ctx.get ? ctx.get("sessions") : null; } catch (error) { sessions = null; }
        if (!sessions) return found;
        try {
          if (typeof sessions.binding === "function") {
            var binding = sessions.binding(sessionId);
            if (binding && binding.ctx && typeof binding.ctx.emit === "function") {
              found.push({ via: "binding.ctx", actx: binding.ctx });
            }
          }
        } catch (error) { /* 试下一个 */ }
        try {
          if (typeof sessions.scope === "function") {
            var scoped = sessions.scope(sessionId);
            if (scoped && typeof scoped.emit === "function" && !found.some(function (item) { return item.actx === scoped; })) {
              found.push({ via: "sessions.scope", actx: scoped });
            }
          }
        } catch (error) { /* 就那么几个候选 */ }
        return found;
      }

      /**
       * 往输入框插一个引用胶囊。
       *
       * @returns {string|null} **失败原因**（成功时 null）。故意返回原因而不是 false：
       *   兜底退回纯文本是"看得见的行为降级"，必须能在控制台说清为什么 ——
       *   否则这类问题只会表现成"胶囊有时候不出来"，无从查起。
       */
      function insertQuoteChip(record, sessionId, draft, draftRev, at) {
        if (!ensureReferenceSource()) return "no-reference-source";
        var candidates = sessionScopes(sessionId);
        if (candidates.length === 0) return "no-session-scope";
        // ⚠️ 插入点不止一个候选，**逐个试**（2026-10-11 实测）。
        //
        // 原因：`draft` 是**剪贴板投影**，里面已有的胶囊各占了它 `clipboardText`
        // 那么多字符；而 `insertText` / `insertReference` 的 span 要的是**编辑坐标**，
        // 胶囊在那里几乎不占位。所以草稿里一旦有胶囊，`draft.length` 就落到坐标
        // 空间之外 —— 表现是"第一次引用能出胶囊，第二次插不进去"。
        //
        // 与其猜哪套坐标，不如把候选都发一遍，**让 `bail` 的返回值挑出对的那个**。
        var base = typeof at === "number" ? at : draft.length;
        var spots = [];
        var trimmed = base - chipClipTotal;
        if (chipClipTotal > 0 && trimmed >= 0 && trimmed !== base) spots.push(trimmed);
        spots.push(base);
        /**
         * 兜底阶梯：**有胶囊时，追加位置一定落在 0 … 胶囊数+1 这个小范围里**。
         *
         * 为什么必须有这一层（2026-10-11 实测）：`chipClipTotal` 累加的是
         * `quoteMarkdown(text).length`（整段剪贴板文本），而 `InputState.draft`
         * 是宿主自己的投影，两者**对不上**。一旦对不上，`base - chipClipTotal`
         * 会变成负数被丢掉，于是候选里只剩 `base` —— 而 `base` 在"已经有胶囊"
         * 时**一定被拒**（实测 `not-accepted(binding.ctx@19=undefined)`）。
         * 结果：第二次引用静默失败，兜底又因为"草稿里已有胶囊"拒绝写入，
         * 用户看到的是**点了没反应**。
         *
         * 实测的接受情况（无输入文字）：0 个胶囊 → 只有 0 被接受；
         * 1 个胶囊 → 2；2 个胶囊 → 3。降序试 ⇒ 取到的是**最靠后的合法位置**，
         * 也就是用户要的"追加"。
         *
         * ⚠️ 只在**已经有胶囊**时才加这一层：没有胶囊时 `base` 就是真实的文本
         * 位置，拿小整数去试会把引用插到用户已经写好的问题**前面**去。
         */
        var chipLabels = liveChipLabels();
        if (chipLabels && chipLabels.length >= 1) {
          for (var back = chipLabels.length + 1; back >= 0; back -= 1) {
            if (spots.indexOf(back) < 0) spots.push(back);
          }
        }
        var tried = [];
        var tried = [];
        for (var index = 0; index < candidates.length; index += 1) {
          var candidate = candidates[index];
          // ⚠️ 必须用 `bail` 而不是 `emit`（2026-10-11 为此踩了一整轮）：
          //    cordis 的 `emit` 只是"把监听器跑一遍"，**没有返回值**；
          //    只有 `bail` 会"跑到第一个返回非空值的监听器为止，并把它返回"。
          //    拿 `emit` 的返回值判成败 ⇒ 明明插进去了却判成失败 ⇒ 兜底的 setDraft
          //    再把刚插好的胶囊整个替换掉。症状：胶囊**永远不出现**，只有纯文本，
          //    而且控制台会显示 `not-accepted(undefined)` 这种看起来像"没人监听"的假象。
          if (typeof candidate.actx.bail !== "function") {
            tried.push(candidate.via + "=no-bail");
            continue;
          }
          for (var spot = 0; spot < spots.length; spot += 1) {
            try {
              var accepted = candidate.actx.bail("slash/input-insert-reference", {
                reference: {
                  source: REF_SOURCE,
                  ref: record.ref,
                  label: chipLabel(record),
                  // ⚠️ DSH 只给三种 glyph（session / file / folder），没有"引用号"图标。
                  //    `session` 是那个对话气泡，是三种里最接近参考图的。
                  appearance: "session",
                  clipboardText: quoteMarkdown(record.text)
                },
                // 折叠 span：插在候选位置
                span: { start: spots[spot], end: spots[spot], draftRev: draftRev }
              });
              if (accepted === true) {
                // 记下这个胶囊在剪贴板投影里占的长度，给下一个胶囊算插入点用
                // （⚠️ 它只是**首选**候选：宿主投影与这里的算法并不总是对得上，
                //    所以下面还有一层"小整数阶梯"兜底，见 spots 的构造）
                chipClipTotal += quoteMarkdown(record.text).length;
                return null;
              }
              tried.push(candidate.via + "@" + spots[spot] + "=" + String(accepted));
            } catch (error) {
              tried.push(candidate.via + "@" + spots[spot] + " threw " + String(error && error.message ? error.message : error));
            }
          }
        }
        return "not-accepted(" + tried.join(", ") + ")";
      }

      /**
       * 往输入框插一段**纯文本**（批注走这条）。
       *
       * @returns {boolean} 被输入机接下才算成功（`bail` 返回 true）。
       */
      function insertNoteText(sessionId, text, at, draftRev) {
        var candidates = sessionScopes(sessionId);
        for (var index = 0; index < candidates.length; index += 1) {
          if (typeof candidates[index].actx.bail !== "function") continue;
          try {
            var accepted = candidates[index].actx.bail("slash/input-insert-text", {
              text: text,
              span: { start: at, end: at, draftRev: draftRev }
            });
            if (accepted === true) return true;
          } catch (error) {
            console.error("[" + PACKAGE_ID + "] 插入批注文本失败：", error);
            return false;
          }
        }
        return false;
      }
      /* ---------- 原文标注：高亮 + 编号（参考图1） ---------- */
      /**
       * 设计取向＝**稳定能用**，不是效果拉满。三条决定都是为这个：
       *
       *  1. **高亮用浏览器原生的 CSS Custom Highlight API**（`CSS.highlights`），
       *     **完全不碰 DOM** —— 不给 React 添任何麻烦，也就不会被下一次渲染冲掉。
       *     （插 `<mark>` 再靠 MutationObserver 重挂的做法，在流式输出的转录里
       *     会一直和 React 打架，那是"效果到位但不可靠"的典型。）
       *
       *  2. **锚点按"原文文字"找回来，不存字符偏移。** 转录是 React 按会话日志
       *     重渲染的，偏移一定会漂；存文字则每次都能重新锚定。
       *
       *  3. **找不到就什么都不做。** 转录做了虚拟化时滚出屏幕的消息不在 DOM 里，
       *     这时高亮与编号**暂时不出现**（滚回来就恢复）—— 这是设计边界，不是 bug；
       *     而且绝不允许因此抛错。
       *
       * 已知边界（不藏）：① 同一段文字在转录里出现多次时，取**第一处**；
       * ② 引用的原文必须落在**单个文本节点**内（跨元素的选区锚不到）。
       */
      var HIGHLIGHT_KEY = "dsh-selection-ask";
      /**
       * 待定高亮用的键：**刚选中、浮层还开着**的那一片。
       *
       * 与"已标注"分开是必须的：待定那一片是**活的 DOM Range**（不按文字找回），
       * 只在浮层开着时存在；而标注是按原文文字锚定的、长期存在。
       * 两者同族不同深浅，视觉上"换了个颜色"，不是"选区消失了"。
       */
      var PENDING_KEY = "dsh-selection-ask-pending";
      // ⚠️ 必须显式写 `window.CSS`：本文件顶部有一个同名变量存着样式表文本，
      //    裸写 CSS 会命中那个字符串（作用域遮蔽），于是永远判定"不支持"。
      var highlightSupported = typeof window !== "undefined" && !!window.CSS
        && !!window.CSS.highlights && typeof window.Highlight === "function";
      var badgeLayer = null;
      var badgeEntries = [];
      var syncScheduled = 0;
      /**
       * 插槽里那个隐形锚点 —— 用它反查输入框，再看输入框里**现在还有哪些胶囊**。
       * 由 `SelectionAskSlot` 的 ref 回调写进来（那里才知道自己的锚点在哪）。
       */
      var composerAnchor = null;
      /** 当前这一次"待定"的选区（浮层开着时非空）。 */
      var pendingRange = null;

      /**
       * 输入框里**现在**还有哪些胶囊。
       *
       * 这是"引用生命周期"的唯一事实源 —— 登记处记着"曾经引用过什么"，
       * 而这里回答"此刻还留着什么"。
       *
       * @returns {string[]|null} label 数组；**null ＝ 读不出来**（拿不到输入框，
       *   或者输入框里明明有胶囊却一个 label 都取不到 —— 那说明宿主换了结构，
       *   这时宁可退回"都画"也不要误删用户的高亮）
       */
      function liveChipLabels() {
        var editor = findEditor(composerAnchor);
        if (!editor || typeof editor.querySelectorAll !== "function") return null;
        var nodes = editor.querySelectorAll('[data-composer-chip="' + REF_SOURCE + '"]');
        var labels = [];
        for (var index = 0; index < nodes.length; index += 1) {
          // 与悬停预览取 label 的方式**逐字相同**（`title` 在胶囊内部的节点上，
          // 取不到时才退回胶囊自己）—— 两处判据不一致的话，会出现
          // "悬停能看原文、但高亮判定说这个胶囊不存在"这种自相矛盾的行为。
          var titled = nodes[index].querySelector ? nodes[index].querySelector("[title]") : null;
          var label = titled ? titled.getAttribute("title") : nodes[index].getAttribute("title");
          if (label) labels.push(label);
        }
        if (nodes.length > 0 && labels.length === 0) return null;
        return labels;
      }

      /** 登记处 → 记录数组（保持登记顺序）。 */
      function allQuoteRecords() {
        var records = [];
        quoteByRef.forEach(function (record) { records.push(record); });
        return records;
      }

      /** 换一片"待定"选区（null ＝ 撤销待定）。与标注共用同一个调度器，不新增定时器。 */
      function setPendingRange(range) {
        pendingRange = range || null;
        scheduleHighlightSync();
      }

      /** 编号牌那一层：挂在已有的 portal 宿主里，跟浮层共用同一个层级。 */
      function ensureBadgeLayer() {
        if (badgeLayer && badgeLayer.isConnected) return badgeLayer;
        badgeLayer = document.createElement("div");
        badgeLayer.setAttribute(OWN_ATTR, "");
        badgeLayer.setAttribute("data-dsa", "badges");
        badgeLayer.style.cssText = "position:fixed;left:0;top:0;width:0;height:0;pointer-events:none;";
        ensureHost().appendChild(badgeLayer);
        return badgeLayer;
      }

      /**
       * 在页面里按**文字**找回一段原文的 Range。
       *
       * 排除两类地方：我们自己画的浮层（不然会锚到编号牌自己），
       * 以及输入框（那里的是胶囊的 label，不是原文）。
       *
       * @returns {Range|null}
       */
      function findQuoteRange(needle) {
        if (!needle) return null;
        var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
          acceptNode: function (node) {
            var value = node.nodeValue;
            if (!value || value.indexOf(needle) < 0) return NodeFilter.FILTER_REJECT;
            var parent = node.parentElement;
            if (!parent) return NodeFilter.FILTER_REJECT;
            if (parent.closest("[" + OWN_ATTR + "]")) return NodeFilter.FILTER_REJECT;
            if (parent.closest('[contenteditable="true"],[contenteditable=""]')) return NodeFilter.FILTER_REJECT;
            return NodeFilter.FILTER_ACCEPT;
          }
        });
        var node = walker.nextNode();
        if (!node) return null;
        var at = node.nodeValue.indexOf(needle);
        if (at < 0) return null;
        try {
          var range = document.createRange();
          range.setStart(node, at);
          range.setEnd(node, at + needle.length);
          return range;
        } catch (error) {
          return null;
        }
      }

      /** 把编号牌摆到各自 Range 的右上角。 */
      function placeBadges() {
        var layer = ensureBadgeLayer();
        while (layer.firstChild) layer.removeChild(layer.firstChild);
        for (var index = 0; index < badgeEntries.length; index += 1) {
          var entry = badgeEntries[index];
          var rect = null;
          try {
            rect = entry.range.getBoundingClientRect();
          } catch (error) {
            continue;
          }
          if (!rect || (rect.width === 0 && rect.height === 0)) continue;   // 不在视口里／已分离
          var badge = document.createElement("span");
          badge.className = "dsa-badge";
          badge.setAttribute("data-dsa", "badge");
          badge.textContent = String(entry.n);
          badge.style.left = Math.round(rect.right - 5) + "px";
          badge.style.top = Math.round(rect.top - 7) + "px";
          layer.appendChild(badge);
        }
      }

      /**
       * 重算高亮与编号牌。任何异常都吞掉 —— 标注失败绝不允许影响插件本体。
       *
       * 两件事，判据各归各的：
       *  1. **标注** —— 只画"输入框里现存的胶囊"对应的原文（`liveChipLabels()`）。
       *     胶囊被删掉之后一条都不画，连那次全页 TreeWalker 都省掉；
       *  2. **待定** —— 浮层开着时，用更浅的同族色把刚选中的那片接管过来。
       *     （浏览器原生选区在浮层自动聚焦的那一刻就被清掉了，不接管就是"消失"。）
       */
      function syncHighlights() {
        if (!highlightSupported) return;
        try {
          var records = liveQuoteRecords(allQuoteRecords(), liveChipLabels(), chipLabel);
          var highlight = new Highlight();
          badgeEntries = [];
          for (var index = 0; index < records.length; index += 1) {
            var range = findQuoteRange(records[index].text);
            if (!range) continue;
            highlight.add(range);
            badgeEntries.push({ n: records[index].n, range: range });
          }
          window.CSS.highlights.set(HIGHLIGHT_KEY, highlight);
          placeBadges();
        } catch (error) {
          /* 标注是锦上添花，坏了不能连累引用本身 */
        }
        // 待定高亮**单独兜异常**：它画不出来，也绝不能让上面那层标注跟着一起没了。
        try {
          if (pendingRange) {
            var pending = new Highlight();
            pending.add(pendingRange);
            window.CSS.highlights.set(PENDING_KEY, pending);
          } else {
            window.CSS.highlights.delete(PENDING_KEY);
          }
        } catch (error) {
          /* 待定高亮是临时态，坏了就只是"刚选中那片没变色" */
        }
      }

      /** 节流到每帧一次：流式输出时转录一直在变，不节流会每帧跑好几遍。 */
      function scheduleHighlightSync() {
        if (!highlightSupported || syncScheduled) return;
        syncScheduled = window.requestAnimationFrame(function () {
          syncScheduled = 0;
          syncHighlights();
        });
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

      /* ---------- 悬停胶囊显示原文（参考图3） ---------- */
      /**
       * 胶囊是 DSH 自己渲染的（Lexical 的 decorator 节点），**改不了它内部结构**，
       * 但可以在它上面挂监听，再用**我自己的浮层**显示原文。
       *
       * 命中方式：胶囊在 DOM 上带 `data-composer-chip="<引用源名>"`，里面的 `title`
       * 就是 label（"选中文本 1"）—— 拿它反查登记处取原文。
       * **不写死任何宿主类名**，宿主改样式表也不会让这条失效。
       */
      function ChipTip(props) {
        var tip = props.tip;
        var ref = React.useRef(null);
        var posState = React.useState(null);
        var pos = posState[0];
        var setPos = posState[1];

        React.useLayoutEffect(function () {
          var el = ref.current;
          if (!el) return;
          var rect = el.getBoundingClientRect();
          setPos(clampPosition(tip.anchor, {
            width: rect.width,
            height: rect.height
          }, {
            width: window.innerWidth,
            height: window.innerHeight
          }));
        }, [tip]);

        return h("div", {
          ref: ref,
          className: "dsa-chiptip",
          "data-dsa": "chiptip",
          role: "tooltip",
          style: pos
            ? { left: pos.left + "px", top: pos.top + "px" }
            : { left: "0px", top: "0px", visibility: "hidden" }
        }, [
          h("div", { className: "dsa-chiptip__label", key: "label" }, tip.label),
          h("div", { className: "dsa-chiptip__text", key: "text" }, tip.text)
        ]);
      }
      /* ---------- 浮层：一条就地输入栏（参考图4） ---------- */
      /**
       * 浮层从"两个按钮"变成"**一个输入框 + 两个动作**"：
       *
       *   选中一段文字 → 光标旁直接出现输入栏 → 就地写批注 → 回车
       *   → `[💬 选中文本 N] 你的批注` 一起落进主输入框（你可以接着改再发）。
       *
       * 不写批注直接回车也可以（那就只引用）。
       */
      function Toolbar(props) {
        var selection = props.selection;
        var onCommit = props.onCommit;
        var onAsk = props.onAsk;
        var ref = React.useRef(null);
        var inputRef = React.useRef(null);
        var posState = React.useState(null);
        var pos = posState[0];
        var setPos = posState[1];
        var noteState = React.useState("");
        var note = noteState[0];
        var setNote = noteState[1];

        // 量一次再落位：浮层宽度取决于文案（中英文长度差很多），
        // 写死宽度会在另一种语言下偏出选区。
        React.useLayoutEffect(function () {
          var el = ref.current;
          if (!el || !selection) return;
          var rect = el.getBoundingClientRect();
          setPos(clampPosition(selection.anchor, {
            width: rect.width,
            height: rect.height
          }, {
            width: window.innerWidth,
            height: window.innerHeight
          }));
        }, [selection]);

        // 出现即聚焦：选中 → 直接打字，不该还要再点一下。
        // ⚠️ 但**键盘选出来的选区不抢焦点** —— 否则按着 Shift+方向键选字时，
        //    浮层一出现就把焦点抢走，选字当场中断（与拖拽被打断是同一类事故）。
        React.useEffect(function () {
          var node = inputRef.current;
          if (!node || !selection || selection.autofocus === false) return undefined;
          var frame = window.requestAnimationFrame(function () {
            try { node.focus({ preventScroll: true }); } catch (error) { /* 聚焦失败不影响 */ }
          });
          return function () { window.cancelAnimationFrame(frame); };
        }, [selection]);

        if (!selection) return null;

        var commit = function (sendNow) {
          onCommit(selection, note.trim(), sendNow === true);
        };
        var onKeyDown = function (event) {
          if (event.key === "Escape") return;                       // 交给全局 Esc 收起
          if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
          event.preventDefault();
          // Ctrl / Cmd + Enter = 写进输入框并**立刻发出去**（普通 Enter 只写不发）
          commit(event.ctrlKey || event.metaKey);
        };

        return h("div", {
          ref: ref,
          className: "dsa-root",
          role: "toolbar",
          "data-dsa": "toolbar",
          style: pos
            ? { left: pos.left + "px", top: pos.top + "px" }
            : { left: "0px", top: "0px", visibility: "hidden" },
          // 关键：不 preventDefault 的话，按下浮层会先把选区清掉，
          // 等 click 触发时选区已经没了（拿不到文本）。
          onMouseDown: function (event) { event.preventDefault(); }
        }, [
          h("input", {
            key: "note",
            ref: inputRef,
            type: "text",
            className: "dsa-note",
            "data-dsa": "note",
            placeholder: T.annotate,
            value: note,
            onChange: function (event) { setNote(event.target.value); },
            onKeyDown: onKeyDown,
            // 输入框自己要能接收鼠标：父级的 preventDefault 对它是多余的
            onMouseDown: function (event) { event.stopPropagation(); }
          }),
          h("button", {
            key: "commit",
            type: "button",
            className: "dsa-btn dsa-btn--icon",
            "data-dsa": "quote",
            title: T.commitAria,
            "aria-label": T.commitAria,
            onMouseDown: function (event) { event.preventDefault(); },
            onClick: commit
          }, [quoteIcon(h), h("span", { key: "t" }, T.commit)]),
          h("span", { key: "sep", className: "dsa-sep", "aria-hidden": "true" }),
          h("button", {
            key: "ask",
            type: "button",
            className: "dsa-btn dsa-btn--icon",
            "data-dsa": "ask",
            title: T.askAriaSide,
            "aria-label": T.askAriaSide,
            onMouseDown: function (event) { event.preventDefault(); },
            onClick: function (event) {
              event.preventDefault();
              onAsk(selection, note.trim());
            }
          }, [askIcon(h), h("span", { key: "t" }, T.ask)])
        ]);
      }

      /* ---------- 插槽 occupant：锚点 + 浮层的真正主人 ---------- */
      function SelectionAskSlot(props) {
        var anchorRef = React.useRef(null);
        var [selection, setSelection] = React.useState(null);
        var [flash, setFlash] = React.useState(null);
        /** 悬停胶囊时浮出的原文预览（图3）。 */
        var chipTipState = React.useState(null);
        var chipTip = chipTipState[0];
        var setChipTip = chipTipState[1];
        var inputActions = props ? props.inputActions : null;
        var useInput = props ? props.useInput : null;
        var sessionId = props ? props.sessionId : undefined;
        // 草稿通过会话标准属性读；拿不到就当空草稿（引用仍会写进去，只是不追加）。
        var draft = useInput ? useInput(function (state) { return state.draft; }) : "";
        // 修订号：插胶囊 / 插文本的 span 都要拿它做 CAS 校验，拿到旧值会被拒。
        var draftRev = useInput ? useInput(function (state) { return state.draftRev; }) : 0;
        /**
         * 最新一版的草稿与修订号，**每次渲染都刷新**。
         * 给"等胶囊落位"的那个 rAF 轮询用：它不能依赖闭包里的旧值。
         */
        var latestRef = React.useRef({ draft: "", draftRev: 0 });
        latestRef.current = { draft: draft, draftRev: draftRev };

        /**
         * 收起浮层 —— **必须连待定高亮一起撤销**。
         *
         * 这两件事在语义上是同一件："这次引用结束了"。分开写迟早会漏掉一处，
         * 漏掉的那处表现成"浮层没了，但那片浅色高亮还赖在原文上"。
         */
        var closeSelection = React.useCallback(function () {
          setSelection(null);
          setPendingRange(null);
        }, []);

        React.useEffect(function () {
          var frame = 0;
          /** 主键是否还按着 —— 按着就是"正在拖"，这时绝不能出浮层（见 flush）。 */
          var pointerDown = false;
          /** 这次选区是不是键盘选出来的（是的话浮层不抢焦点）。 */
          var viaKeyboard = false;
          function flush() {
            frame = 0;
            // ⚠️⚠️ **拖拽还没结束就绝不出浮层**（2026-10-11 他实测报的严重问题）。
            //
            // 症状：鼠标按住往下拖，**选不中字** —— 一拖就断。
            //
            // 根因：选区一变成非空就触发 selectionchange，浮层立刻弹出来并**自动聚焦**
            // 输入栏；而"聚焦一个 input"会让浏览器当场结束这次拖拽、清掉选区。
            // 真人拖拽要几百毫秒、会触发几十次 selectionchange，必然中招。
            //
            // 之前的端到端验收抓不到：CDP 的拖拽是一瞬间派发完的，浮层还来不及插进去。
            // **真人手速比测试慢，慢就会被自己的浮层打断。**
            //
            // 判据：主键还按着 = 正在拖 = 什么都不做，等 mouseup 再算。
            if (pointerDown) return;
            var next = readSelection();
            if (next) {
              // 鼠标拖出来的选区才自动聚焦；键盘选出来的不抢焦点，
              // 否则按着 Shift+方向键选字时也会被自己的浮层打断。
              next.autofocus = !viaKeyboard;
              setSelection(next);
              // 松手那一刻，那片蓝色由**我们自己的待定高亮**接管 ——
              // 浮层接下来会自动聚焦输入栏、把浏览器原生选区清掉，
              // 有了这一层，视觉上就是"换了个颜色"，不是"选区凭空消失"。
              setPendingRange(next.range);
              return;
            }
            // ⚠️ 空选区**不一定**该收起浮层。
            //
            // 就地输入栏出现时会自动聚焦，而"聚焦一个 input"会让浏览器把文档选区
            // 清掉 —— 于是 selectionchange 立刻回报"没有选区了"，浮层在出现的同
            // 一帧把自己收掉。实测症状：拖选之后浮层根本不出现。
            //
            // 判据：焦点在我们自己的 DOM 里时，就不许因为"没选区"而收起。
            // 点别处仍然收起（那是 mousedown 那条路，见 onPointerDown）。
            if (ownOverlayHasFocus()) return;
            closeSelection();
          }
          function schedule() {
            if (frame) return;
            frame = window.requestAnimationFrame(flush);
          }
          function onPointerDown(event) {
            if (event.button === 0) pointerDown = true;
            var target = event.target;
            // 点浮层自己不算"点到别处"（否则按下就消失了，click 永远收不到）。
            if (target && target.closest && target.closest("[" + OWN_ATTR + "]")) return;
            closeSelection();
          }
          function onPointerUp(event) {
            if (event.button !== 0) return;
            pointerDown = false;
            viaKeyboard = false;   // 鼠标一动手，上一次"键盘选区"的印记就作废
            schedule();            // 拖完了才真正去读选区、决定出不出浮层
          }
          function onKeyDown(event) {
            if (event.key === "Escape") { closeSelection(); return; }
            viaKeyboard = true;
          }
          /**
           * 悬停胶囊 → 浮出原文。
           *
           * 用**事件委托**挂在 document 上，而不是挂在胶囊节点上：
           * 胶囊是 Lexical 的 decorator 节点，编辑器每次重渲染都会重建它，
           * 挂在节点上的监听会跟着掉。
           */
          function chipOf(target) {
            return target && target.closest
              ? target.closest('[data-composer-chip="' + REF_SOURCE + '"]')
              : null;
          }
          function onChipOver(event) {
            var chip = chipOf(event.target);
            if (!chip) return;
            var titled = chip.querySelector("[title]");
            var label = titled ? titled.getAttribute("title") : chip.getAttribute("title");
            var record = label ? quoteByLabel.get(label) : null;
            if (!record) return;
            var rect = chip.getBoundingClientRect();
            setChipTip({
              label: label,
              text: record.text,
              anchor: { left: rect.left, top: rect.top, width: rect.width, height: rect.height, bottom: rect.bottom }
            });
          }
          function onChipOut(event) {
            if (chipOf(event.target)) setChipTip(null);
          }
          document.addEventListener("mouseover", onChipOver, true);
          document.addEventListener("mouseout", onChipOut, true);
          document.addEventListener("mouseup", onPointerUp, true);
          document.addEventListener("selectionchange", schedule);
          document.addEventListener("mousedown", onPointerDown, true);
          document.addEventListener("touchstart", onPointerDown, true);
          document.addEventListener("keydown", onKeyDown, true);
          window.addEventListener("resize", schedule);
          window.addEventListener("scroll", schedule, true);
          return function () {
            if (frame) window.cancelAnimationFrame(frame);
            document.removeEventListener("mouseover", onChipOver, true);
            document.removeEventListener("mouseout", onChipOut, true);
            document.removeEventListener("mouseup", onPointerUp, true);
            document.removeEventListener("selectionchange", schedule);
            document.removeEventListener("mousedown", onPointerDown, true);
            document.removeEventListener("touchstart", onPointerDown, true);
            document.removeEventListener("keydown", onKeyDown, true);
            window.removeEventListener("resize", schedule);
            window.removeEventListener("scroll", schedule, true);
          };
        }, []);

        /**
         * 提交一次引用：**胶囊进输入框，批注跟在胶囊后面**。
         *
         * 两条路径，顺序不能反：
         *  1. 主路径 —— 往输入框插一个原子胶囊（编号就是身份）。模型侧完全不变：
         *     胶囊在发送时由 codec 展开成 `> 原文`。
         *  2. 兜底 —— 胶囊插不进去（没有引用源 / 没有会话作用域 / 事件没人接）时，
         *     退回原来的纯文本引用块，功能不消失。
         *
         * ⚠️ 批注**不能**用 `setDraft` 追加：草稿是**全文替换**语义，
         *    调一次就会把刚插进去的胶囊整个抹掉。所以批注交给
         *    re-render 之后的 effect，用「插入文本」事件接在胶囊后面。
         */
        var commit = React.useCallback(function (picked, note, sendNow) {
          var block = quoteMarkdown(picked.text);
          if (block === "") return;
          closeSelection();
          var editor = findEditor(anchorRef.current);
          var record = registerQuote(picked.text);

          var flash = function (text) {
            setFlash({
              text: picked.truncated ? T.truncated + "（" + picked.text.length + " 字）" : text,
              anchor: picked.anchor
            });
            window.setTimeout(function () { setFlash(null); }, FLASH_MS);
            // 「直接发送」：Ctrl/Cmd+Enter 提交后立刻把这条发出去。
            // 放在 flash 的收尾里，是因为它**只在真的写进去了**的路径上被调用 ——
            // 兜底拒绝写入（草稿里已有胶囊）时不会误发一条空消息。
            if (sendNow === true) {
              window.requestAnimationFrame(function () {
                try {
                  if (inputActions && typeof inputActions.submit === "function") inputActions.submit();
                  else console.warn("[" + PACKAGE_ID + "] 拿不到 inputActions.submit，没能直接发送。");
                } catch (error) {
                  console.error("[" + PACKAGE_ID + "] 直接发送失败：", error);
                }
              });
            }
          };

          /** 降级必须**出声**：这是一次看得见的行为变化，不是内部细节。 */
          var fallback = function (reason) {
            console.warn("[" + PACKAGE_ID + "] 胶囊路径未生效（" + reason + "），退回纯文本引用。");
            if (!inputActions || typeof inputActions.setDraft !== "function") {
              console.error("[" + PACKAGE_ID + "] 插槽没有给出 inputActions.setDraft，无法写进输入框。");
              return;
            }
            // ⚠️ 草稿里已经有胶囊时**绝不能**调 setDraft。
            //
            // 它是**全文替换**语义：会把用户已经插好的那些胶囊一起抹掉。
            // 2026-10-11 实测踩到：连续引用第二次时胶囊插入失败，兜底一跑，
            // 第一个胶囊连带被删，看起来像"引用了两次只剩一次"。
            // 宁可这次不引用（并且大声说出来），也不能毁掉已有内容。
            var editorNow = findEditor(anchorRef.current);
            var existing = editorNow ? editorNow.querySelectorAll("[data-composer-chip]").length : 0;
            if (existing > 0) {
              console.error(
                "[" + PACKAGE_ID + "] 草稿里已有 " + existing + " 个胶囊，为避免抹掉它们，这次引用没有写入。"
                + "请手动复制这段原文，或先清空输入框再试。"
              );
              return;
            }
            try {
              inputActions.setDraft(composeDraft(draft, note === "" ? block : block + "\n\n" + note));
            } catch (error) {
              console.error("[" + PACKAGE_ID + "] 写入草稿失败：", error);
              return;
            }
            window.requestAnimationFrame(function () { caretToEnd(editor); });
            flash(T.quoted);
          };

          if (quoteMarkdown(picked.text) === block) { /* 保持 block 已被使用，免得被优化掉 */ }

          if (note === "") {
            // 只有引用：直接插胶囊
            var chipError = insertQuoteChip(record, sessionId, draft, draftRev);
            if (chipError === null) {
              window.requestAnimationFrame(function () { caretToEnd(editor); });
              flash(chipLabel(record));
            } else {
              fallback(chipError);
            }
            return;
          }

          // ⚠️「引用 + 批注」的顺序很讲究：**先写批注，再把胶囊插在批注起点**。
          //
          // 实测（2026-10-11）：胶囊一进输入框，`insert-text` 的坐标空间里就只剩
          // 位置 0 可用 —— 胶囊在**编辑坐标**里不占长度，而 `InputState.draft` 报的是
          // **剪贴板投影**（另一个投影，胶囊在里面展开成 clipboardText）。
          // 所以"先插胶囊、再往它后面补文本"永远补不到它后面（试过 9、6、0 三个
          // 候选插入点，只有 0 被接受，批注就落到了胶囊前面）。
          // 反过来做：批注先落（此时坐标是真实文本），胶囊再插在**批注起点**
          // ⇒ 渲染出来正是 `[胶囊] 批注`。
          var noteAt = draft.length;
          if (!insertNoteText(sessionId, " " + note + " ", noteAt, draftRev)) {
            fallback("note-text-rejected");
            return;
          }
          var tries = 0;
          var placeChip = function () {
            tries += 1;
            var now = latestRef.current;
            // 位置用 `noteAt`（批注起点，插胶囊前算出来的），不是 now.draft.length ——
            // 后者此刻已经把批注算进去了，会把胶囊插到批注后面去。
            var error = insertQuoteChip(record, sessionId, now.draft, now.draftRev, noteAt);
            if (error === null) {
              window.requestAnimationFrame(function () { caretToEnd(editor); });
              flash(chipLabel(record));
              return;
            }
            if (tries < 60) {
              window.requestAnimationFrame(placeChip);
              return;
            }
            fallback("chip-" + error);
          };
          window.requestAnimationFrame(placeChip);
        }, [draft, draftRev, sessionId, inputActions, T, closeSelection]);


        /**
         * 「侧边提问」：把这段文本交给右侧栏的独立对话。
         *
         * 它**不写输入框**、也不碰主对话 —— 这正是与「引用到对话」的分工。
         * 在就地输入栏里写了字的话，那段字成为侧边对话的**第一个问题**。
         */
        var ask = React.useCallback(function (picked, note) {
          closeSelection();
          openAsk(picked, note);
        }, [openAsk, closeSelection]);

        var anchor = h("span", {
          key: "anchor",
          // 用 ref 回调而不是 useRef：锚点挂上/卸下的**那一刻**就要把它交给
          // 高亮那一层（`composerAnchor`），否则第一次标注会算在"读不到输入框"上。
          ref: function (node) {
            anchorRef.current = node;
            composerAnchor = node;
          },
          "data-dsa": "anchor",
          style: { display: "none" }
        });

        var overlay = selection
          ? ReactDOM.createPortal(
            h(Toolbar, { selection: selection, onCommit: commit, onAsk: ask }),
            ensureHost()
          )
          : null;

        var portals = [];
        if (chipTip) portals.push(ReactDOM.createPortal(h(ChipTip, { tip: chipTip }), ensureHost()));
        if (flash) portals.push(ReactDOM.createPortal(h(Toast, { text: flash.text, anchor: flash.anchor }), ensureHost()));
        return h.apply(null, [React.Fragment, null, anchor, overlay].concat(portals));
      }

      /* ---------- 侧边提问：注册标签页类型与面板主体 ---------- */
      var panel = createAskPanel({
        React: React,
        h: h,
        T: T,
        lang: lang,
        quoteMarkdown: quoteMarkdown,
        endpoint: ASK_ENDPOINT,
        packageId: PACKAGE_ID
      });

      /** 取右侧栏控制器；拿不到就明说，不静默。 */
      function sidebarRightService() {
        try {
          return ctx.get ? ctx.get("sidebarRight") : null;
        } catch (error) {
          return null;
        }
      }

      /**
       * 打开（或聚焦）侧边对话标签页，并把这段文本作为这一轮的引用。
       *
       * 同一个 kind 在同一个 pane 里会**去重**：再次调用不会开第二个标签页，
       * 而是聚焦原来那个、把新引用通过 `navigation.params` 递进去
       * （面板据此重开一轮对话）。这正是我们要的语义。
       */
      function openAsk(picked, note) {
        var service = sidebarRightService();
        if (!service || typeof service.openTab !== "function") {
          console.error("[" + PACKAGE_ID + "] " + T.askFailed);
          return;
        }
        try {
          service.openTab(panel.KIND, {
            params: {
              text: picked.text,
              truncated: picked.truncated === true,
              // 就地输入栏里写的那句话，成为侧边对话的第一个问题
              question: typeof note === "string" ? note : ""
            }
          });
        } catch (error) {
          console.error("[" + PACKAGE_ID + "] 打开侧边对话失败：", error);
        }
      }

      ctx.effect(function () {
        if (!ctx.sidebarRightTabs || typeof ctx.sidebarRightTabs.register !== "function") {
          // 侧边栏插件不在这个组合里：划词引用照常工作，只是没有第二个按钮。
          console.warn("[" + PACKAGE_ID + "] sidebarRightTabs 不可用，侧边提问这一项不会出现。");
          return function () {};
        }
        return ctx.sidebarRightTabs.register({
          id: PACKAGE_ID,
          kind: panel.KIND,
          // 页面型标签页（没有 patterns）：由 kind 点名打开，不认领任何资源地址。
          title: function () { return T.sideTitle; }
        });
      }, PACKAGE_ID + ": sidebar tab type");

      ctx.effect(function () {
        if (!ctx.slots || typeof ctx.slots.inject !== "function") return function () {};
        return ctx.slots.inject("sidebar.right.pane.tab", function () {
          return ctx.slots.register({
            name: "sidebar.right.pane.tab",
            key: PACKAGE_ID
          }, panel.Panel);
        });
      }, PACKAGE_ID + ": sidebar tab body");

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

      /* ---------- 标注的驱动：转录一变就重算（节流到每帧一次） ---------- */
      ctx.effect(function () {
        if (!highlightSupported) {
          // 不支持就明说一次，然后整个功能静默缺席 —— 引用本身照常工作。
          console.warn("[" + PACKAGE_ID + "] 这个浏览器没有 CSS Custom Highlight API，原文高亮与编号不会出现。");
          return function () {};
        }
        var observer = new MutationObserver(scheduleHighlightSync);
        observer.observe(document.body, { childList: true, subtree: true, characterData: true });
        window.addEventListener("scroll", scheduleHighlightSync, true);
        window.addEventListener("resize", scheduleHighlightSync);
        scheduleHighlightSync();
        return function () {
          observer.disconnect();
          window.removeEventListener("scroll", scheduleHighlightSync, true);
          window.removeEventListener("resize", scheduleHighlightSync);
          if (syncScheduled) { window.cancelAnimationFrame(syncScheduled); syncScheduled = 0; }
          try { window.CSS.highlights.delete(HIGHLIGHT_KEY); } catch (error) { /* 已经没了 */ }
          try { window.CSS.highlights.delete(PENDING_KEY); } catch (error) { /* 已经没了 */ }
          badgeEntries = [];
          pendingRange = null;
          if (badgeLayer && badgeLayer.parentElement) badgeLayer.parentElement.removeChild(badgeLayer);
          badgeLayer = null;
        };
      }, PACKAGE_ID + ": transcript highlights");
    };
  }

  /**
   * 需要宿主保证的服务。
   *
   * 只声明**确定存在**的两个：插槽注册表（画那个隐形锚点）与右侧栏标签注册表
   * （挂侧边对话）。`sidebarRight` 控制器故意**不**写进 inject —— 它只在点击那一刻
   * 用一次，用 `ctx.get()` 惰性取；少声明一个服务，就少一条"服务没起来导致整棵
   * 插件树被丢掉"的路。
   */
  var inject = ["slots", "sidebarRightTabs"];

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
      liveQuoteRecords: liveQuoteRecords,
      isExcludedNode: isExcludedNode,
      hasOpenModal: hasOpenModal,
      clampPosition: clampPosition,
      pickLang: pickLang,
      STRINGS: STRINGS,
      createApply: createApply
    }
  };
})();





















