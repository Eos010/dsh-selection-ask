/**
 * dsh-selection-ask —— 构建脚本
 *
 * 干两件事：
 *   1. 把 `client.js`（可读源码）包进宿主模块加载器要的工厂外壳；
 *   2. 把 `selection-ask.css` 作为 JSON 字符串字面量内嵌进产物
 *      （替换源码里的 `__SELECTION_ASK_CSS__` 占位符）。
 *
 * 产物 `lib/client.js` **是提交进仓库的** —— 宿主只发构建好的 bundle，
 * 装插件的人不该被迫先跑一次构建。所以这个脚本同时是一道闸门：它会把产物
 * 反过来校验一遍，任何"源码改了但忘了重新构建"都会当场报错。
 *
 * 三个断言都是吃过亏才加的：
 *   · 占位符必须**恰好出现一次** —— 出现两次时 `split/join` 会静默全换；
 *   · 内嵌 CSS 必须与 `.css` 文件**逐字节**一致 —— 否则产物和源码漂移，改样式没效果；
 *   · 读取源码与写出产物之间源码不得变动 —— 并行改文件时产物会是混合体。
 *
 * 用法：`node build.mjs`
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = (name) => join(dirname(fileURLToPath(import.meta.url)), name);

const PLACEHOLDER = "__SELECTION_ASK_CSS__";
/**
 * 源码文件，**按顺序**拼进同一个 loader 工厂函数体。
 *
 * 顺序即依赖：`ask-panel.js` 只声明 `createAskPanel`（不导出、不自执行），
 * `client.js` 在自己的 IIFE 里调用它。两者共享同一个函数作用域，
 * 所以不需要模块系统、也不需要打包器。
 */
const SOURCE_FILES = ["ask-panel.js", "client.js"];
const CSS_FILE = "selection-ask.css";
const OUT_FILE = "lib/client.js";

const sha = (text) => createHash("sha256").update(text, "utf8").digest("hex").slice(0, 12);
/** 统一换行：CSS 原文会被整段嵌进产物，不归一的话同一份源码在 Windows 上产出不同字节。 */
const toLf = (text) => text.replace(/\r\n/g, "\n");

const step = (message) => process.stdout.write(`  ${message}\n`);
function die(message) {
  process.stderr.write(`\n✗ ${message}\n`);
  process.exit(1);
}
function assert(condition, message) {
  if (!condition) die(message);
}

process.stdout.write("\ndsh-selection-ask · build\n");

/* ── 1. 读入 ───────────────────────────────────────────────────── */

const pkg = JSON.parse(readFileSync(here("package.json"), "utf8"));
const sources = SOURCE_FILES.map((name) => ({ name, text: toLf(readFileSync(here(name), "utf8")) }));
const source = sources.map((item) => item.text).join("\n");
const css = toLf(readFileSync(here(CSS_FILE), "utf8"));
const before = {
  sources: Object.fromEntries(sources.map((item) => [item.name, sha(item.text)])),
  css: sha(css)
};

step(
  `读入 ${sources.map((item) => `${item.name} ${item.text.length}B`).join(" + ")} · ${CSS_FILE} ${css.length}B`
);

/* ── 2. 闸门：占位符 ───────────────────────────────────────────── */

const placeholderCount = source.split(PLACEHOLDER).length - 1;
assert(
  placeholderCount === 1,
  `${SOURCE_FILES.join(" + ")} 里 ${PLACEHOLDER} 共出现 ${placeholderCount} 次（必须恰好 1 次）—— ` +
    "0 次说明占位符被删了，多次会让替换静默生效在错误的位置。"
);
assert(
  !css.includes(PLACEHOLDER),
  `${CSS_FILE} 里含占位符本身；占位符只应出现在 client.js 的 var CSS = … 注入点。`
);

/* ── 3. 组装产物 ───────────────────────────────────────────────── */

// 逐文件注入：占位符只在 client.js 里，但断言按"整份源码恰好一次"做，所以这里
// 只在含占位符的那一份上替换，并对每一份都做一次"没有残留占位符"的复核。
const body = sources
  .map((item) => {
    const text = item.text.split(PLACEHOLDER).join(JSON.stringify(css));
    assert(!text.includes(PLACEHOLDER), `${item.name} 替换后仍残留占位符`);
    return `/* ── ${item.name} ── */\n${text}`;
  })
  .join("\n");

const banner = [
  "/* 由 build.mjs 生成，请勿直接编辑；改 ask-panel.js / client.js / selection-ask.css 后重新构建。 */",
  "window.__ModuleLoader__.load({",
  `  id: ${JSON.stringify(pkg.name)},`,
  "  factory: function (require) {",
  "    var module = { exports: {} };",
  // 必须在模块体之前：源码里用 `__esRequire` 取 react / react-dom。
  "    var __esRequire = require;",
  ""
].join("\n");

const footer = [
  "",
  "    if (module.exports && typeof module.exports.apply === 'function') return module.exports;",
  `    throw new Error(${JSON.stringify(pkg.name + ": bundle 未设置导出（require 或模块体有问题）")});`,
  "  },",
  "});",
  ""
].join("\n");

const output = banner + body + footer;

/* ── 4. 反向校验：把内嵌 CSS 抠出来逐字节比对 ─────────────────── */

const marker = "var CSS = ";
const markerAt = output.indexOf(marker);
assert(markerAt >= 0, `产物里找不到 \`${marker}\`（样式没有内嵌）`);
assert(
  output.indexOf(marker, markerAt + marker.length) < 0,
  `产物里出现多处 \`${marker}\`，无法确定内嵌的是哪一段`
);

// 从 marker 之后手工扫一个 JSON 字符串字面量（要能正确跳过转义引号）。
const quoteAt = output.indexOf('"', markerAt);
assert(quoteAt > markerAt, `\`${marker}\` 后面不是 JSON 字符串字面量`);

let end = -1;
for (let index = quoteAt + 1; index < output.length; index += 1) {
  const char = output[index];
  if (char === "\\") {
    index += 1;
    continue;
  }
  if (char === '"') {
    end = index;
    break;
  }
}
assert(end > 0, "内嵌 CSS 字符串字面量没有闭合");

const embedded = JSON.parse(output.slice(quoteAt, end + 1));
assert(
  embedded === css,
  `产物内嵌的 CSS 与 ${CSS_FILE} 不一致 —— 构建过程有 bug，或者文件在构建中被改写。`
);

/* ── 5. 写入 ───────────────────────────────────────────────────── */

mkdirSync(here("lib"), { recursive: true });
writeFileSync(here(OUT_FILE), output, "utf8");

/* ── 6. 漂移防线：构建期间源码不得变动 ─────────────────────────── */

const afterSources = Object.fromEntries(
  SOURCE_FILES.map((name) => [name, sha(toLf(readFileSync(here(name), "utf8")))])
);
const afterCss = sha(toLf(readFileSync(here(CSS_FILE), "utf8")));
assert(
  SOURCE_FILES.every((name) => afterSources[name] === before.sources[name]) && afterCss === before.css,
  "构建期间源码发生了变化（有别的进程在写这些文件）—— 产物可能是混合体，请重新构建。"
);

/* ── 7. 报告 ───────────────────────────────────────────────────── */

step(`写出 ${OUT_FILE} ${output.length}B`);
step(`内嵌 CSS 校验通过（${css.length}B，逐字节一致）`);
process.stdout.write(`✓ 构建完成  id=${pkg.name}\n\n`);
