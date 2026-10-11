/**
 * dsh-selection-ask — 侧边提问面板（浏览器半边的一部分）
 *
 * 这个文件**不是**独立模块：它由 `build.mjs` 与 `client.js` 一起拼进同一个
 * loader 工厂函数体，所以 `createAskPanel` 对 `client.js` 直接可见，
 * 两半共享同一个作用域、同一份 React。
 *
 * 它做的事：在右侧栏开一个标签页，就着"用户选中的那段文本"独立问答。
 * **答案不会进主对话** —— 这正是它与"引用到对话"的分工：
 *   引用    = 把这段带进主线，你接着在主线上问；
 *   侧边提问 = 就地一问，看完就走，主线上下文一个 token 都不多。
 *
 * 会话状态放在**模块级的 Map** 里（按 tab id 存），不放在组件里：
 * 右侧栏切换/折叠会让 body 卸载，状态放组件里会被清空。
 */
function createAskPanel(deps) {
  "use strict";

  var React = deps.React;
  var h = deps.h;
  var T = deps.T;
  var quoteMarkdown = deps.quoteMarkdown;
  var ENDPOINT = deps.endpoint;
  var PACKAGE_ID = deps.packageId;

  /** 标签页类型的 kind —— `openTab` 用它点名，`register` 用它配对。 */
  var KIND = "selection-ask";

  /** tab id → 会话状态。模块级，跨组件卸载存活。 */
  var storeByTab = new Map();

  /** 造一个最小可订阅状态容器（不引第三方状态库）。 */
  function createStore(seed) {
    var state = seed;
    var listeners = new Set();
    return {
      get: function () { return state; },
      set: function (patch) {
        state = Object.assign({}, state, typeof patch === "function" ? patch(state) : patch);
        listeners.forEach(function (listener) { listener(); });
      },
      subscribe: function (listener) {
        listeners.add(listener);
        return function () { listeners.delete(listener); };
      }
    };
  }

  /** 取（或建）某个标签页的会话状态。 */
  function storeFor(tabId, initialQuote) {
    var existing = storeByTab.get(tabId);
    if (existing) return existing;
    var created = createStore({
      quote: initialQuote,
      turns: [],          // [{ role: 'user'|'assistant', text }]
      draft: "",
      busy: false,
      error: null,
      /** 引用区展开状态：长引用默认折起来，否则它会把整个面板占满。 */
      quoteOpen: false
    });
    storeByTab.set(tabId, created);
    return created;
  }

  /* ───────────────────────── 流式请求 ───────────────────────── */

  /**
   * 发一轮问题并把回答流式写回 store。
   *
   * 它跑在 store 上而不是组件里：用户切走标签页时请求继续跑，
   * 切回来还能看到正在长出来的答案。
   *
   * @param {object} store 会话状态
   * @param {string} lang 语言（决定系统提示词）
   * @param {AbortController} controller 用于「停止」
   */
  function runTurn(store, lang, controller) {
    var state = store.get();
    var outgoing = state.turns
      .filter(function (turn) { return turn.text.trim() !== ""; })
      .map(function (turn) { return { role: turn.role, text: turn.text }; });

    store.set({ busy: true, error: null });
    // 先放一个空的助手气泡，后面的 delta 往它身上追加 —— 视觉上就是"正在写"
    store.set(function (current) {
      return { turns: current.turns.concat([{ role: "assistant", text: "" }]) };
    });

    var appendDelta = function (text) {
      store.set(function (current) {
        var turns = current.turns.slice();
        var last = turns[turns.length - 1];
        if (!last || last.role !== "assistant") return {};
        turns[turns.length - 1] = { role: "assistant", text: last.text + text };
        return { turns: turns };
      });
    };

    fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lang: lang, messages: outgoing }),
      signal: controller.signal
    }).then(function (response) {
      if (!response.ok) {
        return response.json().catch(function () { return {}; }).then(function (payload) {
          throw new Error(payload && payload.error ? payload.error : "HTTP " + response.status);
        });
      }
      if (!response.body || typeof response.body.getReader !== "function") {
        throw new Error("streaming-unsupported");
      }
      var reader = response.body.getReader();
      var decoder = new TextDecoder();
      var buffer = "";

      var pump = function () {
        return reader.read().then(function (result) {
          if (result.done) return null;
          buffer += decoder.decode(result.value, { stream: true });
          // SSE 帧以空行分隔；最后一段可能不完整，留在 buffer 里等下一块
          var frames = buffer.split("\n\n");
          buffer = frames.pop();
          for (var index = 0; index < frames.length; index += 1) {
            var line = frames[index].trim();
            if (line.indexOf("data:") !== 0) continue;
            var payload;
            try {
              payload = JSON.parse(line.slice(5).trim());
            } catch (error) {
              continue;
            }
            if (payload.type === "delta" && typeof payload.text === "string") appendDelta(payload.text);
            else if (payload.type === "error") store.set({ error: payload.message || payload.code || "stream-failed" });
          }
          return pump();
        });
      };
      return pump();
    }).catch(function (error) {
      if (error && error.name === "AbortError") return;   // 用户按了停止，不是错误
      store.set({ error: String(error && error.message ? error.message : error) });
    }).then(function () {
      store.set({ busy: false });
    });
  }

  /* ───────────────────────── 组件 ───────────────────────── */

  /** 面板主体。它通过 `useTabInfo()` 拿到自己这个标签页的记录与导航参数。 */
  function Panel(props) {
    var useTabInfo = props ? props.useTabInfo : null;
    var info = useTabInfo ? useTabInfo() : null;
    var tab = info ? info.tab : null;
    var tabId = tab ? tab.id : "detached";
    var params = tab && tab.navigation ? tab.navigation.params : null;
    var seeded = params && typeof params.text === "string" ? params.text : "";
    var revision = tab && tab.navigation ? tab.navigation.revision : 0;

    var store = storeFor(tabId, seeded);
    var state = React.useSyncExternalStore
      ? React.useSyncExternalStore(store.subscribe, store.get, store.get)
      : store.get();

    var controllerRef = React.useRef(null);
    var inputRef = React.useRef(null);
    var scrollRef = React.useRef(null);

    // 每一次"重新导航到这个标签页"（用户在别处又点了侧边提问）都换一段引用、
    // 并且**重开一轮对话** —— 旧问答属于旧引用，留着只会误导。
    React.useEffect(function () {
      if (seeded === "") return;
      if (store.get().quote === seeded) return;
      store.set({ quote: seeded, turns: [], draft: "", error: null, quoteOpen: false });
    }, [seeded, revision]);

    // 新内容进来就滚到底
    React.useEffect(function () {
      var node = scrollRef.current;
      if (node) node.scrollTop = node.scrollHeight;
    });

    // 组件卸载时**不**中断请求：状态在 store 里，切回来还要接着看
    var send = function () {
      var draft = store.get().draft.trim();
      if (draft === "" || store.get().busy) return;
      var quote = store.get().quote;
      // 第一轮把引用原文以引用块的形式带上；后续轮次只发问题（引用已在上下文里）
      var isFirst = store.get().turns.length === 0;
      var text = isFirst && quote !== ""
        ? quoteMarkdown(quote) + "\n\n" + draft
        : draft;
      store.set(function (current) {
        return { turns: current.turns.concat([{ role: "user", text: text }]), draft: "" };
      });
      var controller = new AbortController();
      controllerRef.current = controller;
      runTurn(store, deps.lang, controller);
    };

    var stop = function () {
      if (controllerRef.current) controllerRef.current.abort();
      controllerRef.current = null;
      store.set({ busy: false });
    };

    var onKeyDown = function (event) {
      if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
      event.preventDefault();
      send();
    };

    var quote = state.quote;
    var clip = quote.length > (state.quoteOpen ? 100000 : 260);
    var shownQuote = clip ? quote.slice(0, 260) + "…" : quote;

    var children = [];

    children.push(h("div", { className: "dsa-panel__quote", key: "quote" }, [
      h("div", { className: "dsa-panel__quoteHead", key: "head" }, [
        h("span", { key: "label" }, T.quoteLabel),
        h("button", {
          key: "toggle",
          type: "button",
          className: "dsa-link",
          onClick: function () { store.set({ quoteOpen: !state.quoteOpen }); }
        }, state.quoteOpen ? T.collapse : T.expand)
      ]),
      h("div", { className: "dsa-panel__quoteBody", key: "body" }, shownQuote)
    ]));

    var list = [];
    if (state.turns.length === 0) {
      list.push(h("div", { className: "dsa-panel__empty", key: "empty" }, T.empty));
    }
    state.turns.forEach(function (turn, index) {
      list.push(h("div", {
        key: "turn" + index,
        className: "dsa-panel__turn",
        "data-role": turn.role
      }, [
        h("div", { className: "dsa-panel__who", key: "who" }, turn.role === "user" ? T.you : T.assistant),
        h("div", { className: "dsa-panel__text", key: "text" }, turn.text === "" ? T.thinking : turn.text)
      ]));
    });
    children.push(h("div", { className: "dsa-panel__scroll", key: "scroll", ref: scrollRef }, list));

    if (state.error !== null) {
      children.push(h("div", { className: "dsa-panel__error", key: "error" }, T.failed + "：" + state.error));
    }

    children.push(h("div", { className: "dsa-panel__composer", key: "composer" }, [
      h("textarea", {
        key: "input",
        ref: inputRef,
        className: "dsa-panel__input",
        rows: 3,
        placeholder: T.placeholder,
        value: state.draft,
        disabled: state.busy,
        onChange: function (event) { store.set({ draft: event.target.value }); },
        onKeyDown: onKeyDown
      }),
      h("div", { className: "dsa-panel__actions", key: "actions" }, [
        h("button", {
          key: "clear",
          type: "button",
          className: "dsa-btn dsa-btn--ghost",
          disabled: state.busy || (state.turns.length === 0 && state.draft === ""),
          onClick: function () { store.set({ turns: [], draft: "", error: null }); }
        }, T.clear),
        state.busy
          ? h("button", {
            key: "stop",
            type: "button",
            className: "dsa-btn dsa-btn--primary",
            onClick: stop
          }, T.stop)
          : h("button", {
            key: "send",
            type: "button",
            className: "dsa-btn dsa-btn--primary",
            disabled: state.draft.trim() === "",
            onClick: send
          }, T.send)
      ])
    ]));

    return h("div", { className: "dsa-panel", "data-dsa": "panel", "data-busy": state.busy ? "1" : "0" }, children);
  }

  return {
    KIND: KIND,
    Panel: Panel,
    /** 测试用：清掉所有会话状态。 */
    __reset: function () { storeByTab.clear(); }
  };
}
