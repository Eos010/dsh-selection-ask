/**
 * 纯逻辑测试 —— 引用块的形状、草稿拼接、浮层落位、排除规则。
 *
 * 这些都是"看起来不起眼、错了很难查"的地方：引用块多一条空 `>` 行，
 * 用户和模型看到的上下文就变了；浮层翻不翻边，决定了它在长回答旁边能不能用。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadBundle, el } from "./harness.mjs";

/**
 * ⚠️ 这里**只能**用 `bundle.dom`，不能另造一个 document，也不能改 `globalThis.document`。
 *
 * 产物是用 `new Function("window", "document", "navigator", src)` 跑起来的，
 * 模块体里的 `document` 是**加载那一刻注入的那个对象**的闭包引用。
 * 测试里另造一个 document 的话，断言会在一个没人用的对象上空跑 —— 而且会假绿
 * （2026-10-11 实际踩到：`hasOpenModal` 的三个用例全绿，其实一个都没生效）。
 */
const bundle = loadBundle();
const { module, dom } = bundle;
const { quoteMarkdown, composeDraft, clampPosition, pickLang, isExcludedNode, hasOpenModal, STRINGS } = module.__internals;

/* ───────────────────────── 引用块 ───────────────────────── */

test("单行 → 单条引用", () => {
  assert.equal(quoteMarkdown("你好"), "> 你好");
});

test("多行 → 每行一条引用，顺序不变", () => {
  assert.equal(quoteMarkdown("第一行\n第二行\n第三行"), "> 第一行\n> 第二行\n> 第三行");
});

test("空行 → 裸 `>`（带尾空格的 `> ` 会被某些渲染器吃掉，段落结构就没了）", () => {
  assert.equal(quoteMarkdown("上\n\n下"), "> 上\n>\n> 下");
});

test("CRLF / CR 都归一成 LF —— 否则 Windows 上复制来的文本会多出一堆空引用行", () => {
  assert.equal(quoteMarkdown("a\r\nb\rc"), "> a\n> b\n> c");
});

test("末尾换行先去掉，不多出一条空引用行", () => {
  assert.equal(quoteMarkdown("结尾\n\n\n"), "> 结尾");
  assert.equal(quoteMarkdown("结尾\r\n"), "> 结尾");
});

test("空 / null / undefined → 空字符串（调用方据此跳过）", () => {
  assert.equal(quoteMarkdown(""), "");
  assert.equal(quoteMarkdown(null), "");
  assert.equal(quoteMarkdown(undefined), "");
});

test("缩进与代码块原样保留（引用只加前缀，不动内容）", () => {
  assert.equal(quoteMarkdown("  def f():\n    return 1"), ">   def f():\n>     return 1");
});

/* ───────────────────────── 草稿拼接 ───────────────────────── */

test("空草稿 → 直接放引用块，之后留一个空行等提问", () => {
  assert.equal(composeDraft("", "> 引用"), "> 引用\n\n");
});

test("已有草稿 → 空一行再接引用（不能紧贴在上一句后面）", () => {
  assert.equal(composeDraft("我的问题呢", "> 引用"), "我的问题呢\n\n> 引用\n\n");
});

test("已有草稿的尾随空白先清掉，避免越引越多的空行", () => {
  assert.equal(composeDraft("我的问题呢\n\n\n  ", "> 引用"), "我的问题呢\n\n> 引用\n\n");
});

test("连续引用两次 → 两块引用之间只隔一个空行", () => {
  const once = composeDraft("", "> 第一段");
  const twice = composeDraft(once, "> 第二段");
  assert.equal(twice, "> 第一段\n\n> 第二段\n\n");
});

test("空引用块不改动草稿（只把尾随空白清掉）", () => {
  assert.equal(composeDraft("原文  ", ""), "原文");
});

/* ───────────────────────── 浮层落位 ───────────────────────── */

const VIEWPORT = { width: 1280, height: 800 };
const SIZE = { width: 160, height: 34 };

test("空间充足 → 摆在选区上方、水平居中", () => {
  const anchor = { left: 600, top: 400, width: 100, height: 20, bottom: 420 };
  assert.deepEqual(clampPosition(anchor, SIZE, VIEWPORT), { left: 570, top: 358 });
});

test("上方放不下 → 翻到选区下方", () => {
  const anchor = { left: 600, top: 4, width: 100, height: 20, bottom: 24 };
  assert.deepEqual(clampPosition(anchor, SIZE, VIEWPORT), { left: 570, top: 32 });
});

test("左右出界 → 夹进视口，不越边", () => {
  const left = clampPosition({ left: -50, top: 400, width: 10, height: 20, bottom: 420 }, SIZE, VIEWPORT);
  assert.equal(left.left, 8);
  const right = clampPosition({ left: 1275, top: 400, width: 10, height: 20, bottom: 420 }, SIZE, VIEWPORT);
  assert.equal(right.left, VIEWPORT.width - SIZE.width - 8);
});

test("上下都放不下（很矮的视口）→ 贴住底边而不是飘出去", () => {
  const viewport = { width: 800, height: 120 };
  const anchor = { left: 400, top: 40, width: 100, height: 80, bottom: 120 };
  const pos = clampPosition(anchor, SIZE, viewport);
  assert.ok(pos.top >= 8, "不能跑到视口上边之外");
  assert.ok(pos.top + SIZE.height <= viewport.height - 8, "不能跑到视口下边之外");
});

test("prefer='below'（「已引用」提示）→ 落在选中行下方，不遮住刚引用的那句话", () => {
  const anchor = { left: 600, top: 400, width: 100, height: 20, bottom: 420 };
  assert.deepEqual(clampPosition(anchor, SIZE, VIEWPORT, "below"), { left: 570, top: 428 });
});

test("prefer='below' 但下方放不下 → 翻回上方，且不盖住锚点", () => {
  const anchor = { left: 600, top: 760, width: 100, height: 20, bottom: 780 };
  const pos = clampPosition(anchor, SIZE, VIEWPORT, "below");
  assert.ok(pos.top + SIZE.height <= anchor.top, `应落在锚点上方，实际 top=${pos.top}`);
  assert.ok(pos.top >= 8);
});

test("prefer='below' 且上下都放不下 → 仍然夹在视口内", () => {
  const viewport = { width: 800, height: 100 };
  const anchor = { left: 400, top: 10, width: 100, height: 80, bottom: 90 };
  const pos = clampPosition(anchor, SIZE, viewport, "below");
  assert.ok(pos.top >= 8);
  assert.ok(pos.top + SIZE.height <= viewport.height - 8);
});

/* ───────────────────────── 语言 ───────────────────────── */

test("中文系语言 → zh；其余 → en；取不到 → en", () => {
  // ⚠️ Node 22 自己也有 `globalThis.navigator`（值取自系统语言），
  //    所以"Node 里没有 navigator"是错的假设 —— 每个用例都显式喂一个。
  assert.equal(loadBundle({ navigator: { language: "zh-CN" } }).module.__internals.pickLang(), "zh");
  assert.equal(loadBundle({ navigator: { language: "zh" } }).module.__internals.pickLang(), "zh");
  assert.equal(loadBundle({ navigator: { language: "ZH-Hans" } }).module.__internals.pickLang(), "zh");
  assert.equal(loadBundle({ navigator: { language: "en-US" } }).module.__internals.pickLang(), "en");
  assert.equal(loadBundle({ navigator: { language: "fr" } }).module.__internals.pickLang(), "en");
  assert.equal(loadBundle({ navigator: {} }).module.__internals.pickLang(), "en");
  assert.equal(loadBundle({ navigator: { languages: ["zh-TW"] } }).module.__internals.pickLang(), "zh");
});

test("两套文案的键必须完全一致（漏一个键就会在另一种语言下显示 undefined）", () => {
  assert.deepEqual(Object.keys(STRINGS.zh).sort(), Object.keys(STRINGS.en).sort());
});

/* ───────────────────────── 排除规则 ───────────────────────── */
/* ───────────────────────── 排除规则 ───────────────────────── */

/** 把若干元素串成 parentElement 链，返回最里面那个。 */
function chain(...nodes) {
  for (let index = 0; index < nodes.length - 1; index += 1) {
    nodes[index].parentElement = nodes[index + 1];
  }
  return nodes[0];
}

/** 每次用例前清掉上一次留在桩上的查询行为。 */
function resetDom() {
  dom.querySelector = () => null;
}

test("输入框（contenteditable）里选中不算引用 —— 那是在编辑", () => {
  resetDom();
  const editable = el("div", { contenteditable: "true" });
  assert.equal(isExcludedNode(chain(el("span"), editable, dom.body)), true);
  // `contenteditable=""` 与 "true" 等价
  assert.equal(isExcludedNode(chain(el("span"), el("div", { contenteditable: "" }), dom.body)), true);
  // `contenteditable="false"` 不是可编辑区
  assert.equal(isExcludedNode(chain(el("span"), el("div", { contenteditable: "false" }), dom.body)), false);
});

test("原生表单控件里选中不算引用", () => {
  resetDom();
  assert.equal(isExcludedNode(chain(el("input"), dom.body)), true);
  assert.equal(isExcludedNode(chain(el("textarea"), dom.body)), true);
  assert.equal(isExcludedNode(chain(el("select"), dom.body)), true);
});

test("我们自己画的浮层不算引用（避免自引用套娃）", () => {
  resetDom();
  const own = el("div", { "data-selection-ask": "" });
  assert.equal(isExcludedNode(chain(el("span"), own, dom.body)), true);
});

test("正文里选中算引用；走到 body 就停", () => {
  resetDom();
  assert.equal(isExcludedNode(chain(el("span"), el("p"), el("div"), dom.body)), false);
  // 直接就是 body 的情况也不该继续往上走（body.parentElement 是 null，走上去会拿到 undefined）
  assert.equal(isExcludedNode(dom.body), false);
});

test("文本节点（nodeType 3）走 parentElement 判定，不是直接放行", () => {
  resetDom();
  const editable = el("div", { contenteditable: "true" });
  const text = { nodeType: 3, parentElement: chain(el("span"), editable, dom.body) };
  assert.equal(isExcludedNode(text), true);
});

/* ───────────────────────── 模态框 ───────────────────────── */

test("没有模态框 → 正常出浮层", () => {
  resetDom();
  assert.equal(hasOpenModal(), false);
});

test("有模态框 → 不出浮层（top layer 会把它盖住：看得见点不着）", () => {
  dom.querySelector = (selector) => (selector.includes("aria-modal") ? el("div", { "aria-modal": "true" }) : null);
  assert.equal(hasOpenModal(), true);
  resetDom();
});

test("document.querySelector 抛异常时按「没有模态框」处理，不连累浮层", () => {
  dom.querySelector = () => {
    throw new Error("boom");
  };
  assert.equal(hasOpenModal(), false);
  resetDom();
});
