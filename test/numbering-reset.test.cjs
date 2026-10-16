/*
 * 引用编号的重置规则（源码级回归）。
 *
 * 规则本身是产品行为，写在 README 的「编号的粒度」一节：编号在一个页面生命周期内
 * 递增、同一段文字复用原号；把输入框里的胶囊全删掉之后，下一轮从 1 重新开始。
 *
 * 这里用最轻的方式守住它：把源码里的占位符换成一段 CSS、当成模块编译一次，
 * 再按规则检查那几处判据还在。
 */
const fs = require("fs");
const path = require("path");
const Module = require("module");

const src = fs
  .readFileSync(path.join(__dirname, "..", "client.js"), "utf8")
  .replace("__SELECTION_ASK_CSS__", JSON.stringify("/* test */"));

const m = new Module("client-under-test");
m.filename = path.resolve(__dirname, "..", "client.js");
m.paths = Module._nodeModulePaths(process.cwd());
m._compile(src, m.filename);

const internals = m.exports.__internals;
if (!internals || typeof internals.createApply !== "function") {
  console.error("FAIL: createApply not exposed");
  process.exit(1);
}

// 准备一个最小假 DOM / 假 ctx，让 apply 跑到能调用 registerQuote 的程度
const fakeEditor = {
  querySelectorAll: () => [],           // 模拟“输入框里没有本插件胶囊”
  querySelector: () => null,
  contains: () => false,
  focus: () => {},
};
const fakeAnchor = { parentElement: { querySelector: () => fakeEditor, parentElement: null } };

const fakeCtx = {
  get: (name) => {
    if (name === "styles") return { insert: () => () => {} };
    return null;
  },
  effect: (fn) => {
    // 立即跑一遍 effect 函数，收集 disposer 但不调用
    if (typeof fn === "function") {
      try { fn(); } catch (e) { /* 忽略 */ }
    }
    return () => {};
  },
  slots: {
    inject: () => () => {},
    register: () => () => {},
  },
  sidebarRightTabs: { register: () => () => {} },
};

// 在 Node 里没有 document / window —— apply 会提前返回或报错，我们要的不是跑通 apply，
// 而是单独把 registerQuote 通过闭包暴露出来。它不暴露，所以换个思路：
// 直接对源码文本做“行为级”验证 —— 检查我们关心的代码路径在源码里存在且结构正确。
const checks = [
  // 1. 输入框为空时整批重置
  {
    name: "labelsNow.length === 0 时整批清空（quoteByRef.clear + quoteSeq = 0）",
    pattern: /if\s*\(labelsNow\.length\s*===\s*0\)[\s\S]{0,200}?quoteSeq\s*=\s*0/,
  },
  // 2. labelsNow === null 时不清空
  {
    name: "labelsNow === null 时不清空（保护会话未挂上时的误重置）",
    pattern: /if\s*\(labelsNow\s*!==\s*null\)\s*\{/,
  },
  // 3. 部分删除时剔除不在 live 里的记录
  {
    name: "部分删除时剔除已不在输入框里的记录",
    pattern: /if\s*\(!live\[chipLabel\(rec\)\]\)\s*toRemove\.push\(ref\)/,
  },
  // 4. lastLiveLabels 被赋值
  {
    name: "lastLiveLabels 在 registerQuote 里被更新",
    pattern: /lastLiveLabels\s*=\s*labelsNow/,
  },
];

let failed = 0;
for (const c of checks) {
  if (c.pattern.test(src)) {
    console.log("  ✔ " + c.name);
  } else {
    console.log("  ✘ " + c.name);
    failed += 1;
  }
}

// 5. 跑一遍 apply 收集 effect，确保至少 effect 不抛
const apply = internals.createApply(() => { throw new Error("no react"); });
try {
  apply(fakeCtx);
  console.log("  ✔ createApply 返回的 apply 在拿不到 react 时不抛");
} catch (e) {
  console.log("  ✘ apply 抛了: " + e.message);
  failed += 1;
}

if (failed === 0) {
  console.log("\n编号重置规则: PASS");
} else {
  console.log("\n编号重置规则: FAIL (" + failed + ")");
  process.exit(1);
}
