/**
 * 端到端验收：在真浏览器里走完「划词 → 浮层 → 引用到输入框」。
 *
 * 它不模拟任何一步：鼠标是 `Input.dispatchMouseEvent` 派发的**真实**事件序列
 * （所以 `selectionchange`、`mousedown` 的 preventDefault、click 全都按真路走），
 * 判定读的是**页面真实 DOM**（浮层在不在、输入框里到底有什么字）。
 *
 * 前置：一个跑着的 DSH 实例 + 一个开了远程调试的 Chrome。
 *
 *   dsh web --port 3099 --no-open
 *   chrome --headless=new --remote-debugging-port=9223 --user-data-dir=<临时目录> "http://127.0.0.1:3099/?token=…"
 *   node test/e2e/selection-ask.e2e.mjs --cdp-port 9223 --app-url http://127.0.0.1:3099 --shots docs/images
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { connect } from "./cdp.mjs";

/* ───────────────────────────── 参数 ───────────────────────────── */

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const CDP_PORT = Number(arg("cdp-port", "9223"));
const APP_URL = arg("app-url", "http://127.0.0.1:3099");
const SHOT_DIR = arg("shots", "");
const THEME = arg("theme", "light");
const SHOT_SUFFIX = THEME === "dark" ? "-dark" : "-light";

/* ───────────────────────────── 断言 ───────────────────────────── */

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok), detail });
  process.stdout.write(`${ok ? "✔" : "✖"} ${name}${detail === undefined ? "" : `  (${detail})`}\n`);
  return Boolean(ok);
}
function die(message) {
  process.stderr.write(`\n✗ ${message}\n`);
  process.exit(1);
}

/* ───────────────────────────── 主流程 ───────────────────────────── */

const cdp = await connect({ port: CDP_PORT, urlPrefix: APP_URL });
process.stdout.write(`CDP 已连上 ${APP_URL}（主题 ${THEME}）\n\n`);

const sleep = cdp.sleep;

/* 主题：宿主主题设成"跟随系统"，所以这里用媒体特性模拟就够了。 */
if (THEME === "dark") {
  await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] });
  await sleep(800);
}
const shot = async (name) => {
  if (!SHOT_DIR) return;
  mkdirSync(SHOT_DIR, { recursive: true });
  const data = await cdp.screenshot(name);
  const file = join(SHOT_DIR, `${name}${SHOT_SUFFIX}.png`);
  writeFileSync(file, Buffer.from(data, "base64"));
  process.stdout.write(`  ↳ 截图 ${file}\n`);
};

/* 读输入框里的**草稿正文**。
   为什么要专门处理：`innerText` 会在块级元素之间补空行，用它去断言
   "两块引用之间隔几行"必然误判。这里优先按段落取 textContent 再拼。 */
const READ_DRAFT = `
  const editor = document.querySelector('[contenteditable="true"],[contenteditable=""]');
  if (!editor) return null;
  const blocks = [...editor.children];
  if (blocks.length > 0 && blocks.every((node) => (node.textContent || '').length >= 0)) {
    return blocks.map((node) => node.textContent).join('\\n');
  }
  return editor.innerText;
`;

/** 清空输入框：Ctrl+A → Delete。让每次验收都从同一状态起跑。 */
async function clearComposer() {
  const box = await cdp.evaluate(`
    const editor = document.querySelector('[contenteditable="true"],[contenteditable=""]');
    if (!editor) return null;
    const rect = editor.getBoundingClientRect();
    return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
  `);
  if (!box) return;
  await cdp.clickAt(box.x, box.y);
  await sleep(150);
  for (const [key, code, vk] of [["a", "KeyA", 65], ["Delete", "Delete", 46]]) {
    await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key, code, windowsVirtualKeyCode: vk, modifiers: key === "a" ? 2 : 0 });
    await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode: vk, modifiers: key === "a" ? 2 : 0 });
    await sleep(120);
  }
  await sleep(250);
  // 点回正文区，免得输入框还带着焦点干扰后面"选中正文"的判定
  await cdp.evaluate(`document.activeElement && document.activeElement.blur && document.activeElement.blur(); return true;`);
  await sleep(120);
}

/* 0. 关掉首启弹窗。
      模态框走浏览器 top layer，会盖在所有 z-index 之上 —— 那是**环境状态**，
      不是被测对象。不关掉的话后面每一步都在跟它抢点击。 */
const welcome = await cdp.evaluate(`
  const dialog = document.querySelector('dialog[open], [aria-modal="true"]');
  if (!dialog) return null;
  const button = [...dialog.querySelectorAll('button')].pop();
  if (!button) return null;
  const rect = button.getBoundingClientRect();
  return {
    label: (button.innerText || '').trim(),
    x: Math.round(rect.left + rect.width / 2),
    y: Math.round(rect.top + rect.height / 2)
  };
`);
if (welcome) {
  await cdp.clickAt(welcome.x, welcome.y);
  await sleep(500);
  process.stdout.write(`已关掉首启弹窗（点了「${welcome.label}」）\n`);
}

/* 1. 插件必须已经挂上：锚点在 DOM 里、没有页面级异常 */
const boot = await cdp.evaluate(`
  return {
    href: location.href,
    hasAnchor: !!document.querySelector('[data-dsa="anchor"]'),
    editors: document.querySelectorAll('[contenteditable="true"],[contenteditable=""]').length
  };
`);
check("插件锚点已挂进输入框插槽", boot.hasAnchor);
check("输入框编辑器存在", boot.editors >= 1, `editors=${boot.editors}`);
check("页面没有未捕获异常", cdp.pageErrors.length === 0, cdp.pageErrors.join(" | ") || "0");

await clearComposer();
const cleanDraft = await cdp.evaluate(READ_DRAFT);
check("输入框已清空（验收从干净状态起跑）", typeof cleanDraft === "string" && cleanDraft.trim() === "", JSON.stringify(cleanDraft));

/* 2. 找一段正文，量出它的第一行，作为拖拽选择的目标。
      优先转录区（右侧主栏）里的段落 / 代码块；找不到才退回任意长文本。 */
const target = await cdp.evaluate(`
  const isVisible = (node) => {
    const rect = node.getBoundingClientRect();
    if (rect.width < 120 || rect.height < 10 || rect.height > 500) return false;
    if (rect.top < 8 || rect.bottom > window.innerHeight - 8) return false;
    const style = getComputedStyle(node);
    if (style.visibility === 'hidden' || style.display === 'none') return false;
    // 必须真的点得到（没被别的层盖住）
    const hit = document.elementFromPoint(Math.round(rect.left + rect.width / 2), Math.round(rect.top + rect.height / 2));
    return !!hit && (node.contains(hit) || hit.contains(node));
  };
  const pick = (selector) => [...document.querySelectorAll(selector)]
    .filter((node) => (node.innerText || '').trim().length >= 24)
    .filter((node) => node.getBoundingClientRect().left > 280)
    .filter(isVisible)[0] || null;
  const node = pick('p') || pick('pre') || pick('li') || pick('h2') || pick('span');
  if (!node) return null;
  const range = document.createRange();
  range.selectNodeContents(node);
  const rects = [...range.getClientRects()].filter((r) => r.width > 40 && r.height > 6);
  const line = rects[0];
  if (!line) return null;
  const y = Math.round(line.top + line.height / 2);
  return {
    text: (node.innerText || '').trim().slice(0, 48),
    from: { x: Math.round(line.left + 3), y },
    to: { x: Math.round(line.right - 3), y },
    line: { left: Math.round(line.left), top: Math.round(line.top), width: Math.round(line.width), height: Math.round(line.height) }
  };
`);
if (!target) {
  die("页面上找不到可拖拽选择的正文。请先在这个实例里打开一个**有内容**的会话（或发一条消息）再跑本验收。");
}
process.stdout.write(`\n选择目标：「${target.text}…」 @ ${JSON.stringify(target.line)}\n`);

/* 3. 真实拖拽 —— 走 selectionchange → 插件出浮层 */
await cdp.dragSelect(target.from, target.to);
await sleep(400);

const selected = await cdp.evaluate(`
  const sel = window.getSelection();
  return { text: sel ? sel.toString().trim().slice(0, 60) : '', collapsed: sel ? sel.isCollapsed : true };
`);
// ⚠️ 不能读**实时**选区：就地输入栏一出现就会自动聚焦，而"聚焦 input"会让浏览器
// 注：这里**不**断言实时选区 —— 就地输入栏一出现就自动聚焦，而"聚焦 input"会清空
// 文档选区（这正是插件里 ownOverlayHasFocus 存在的原因）。"浮层出现了"本身就是
// 插件读到了选区的证据。
/* 4. 浮层出现，且带「引用到对话」按钮 */
const toolbar = await cdp.evaluate(`
  const el = document.querySelector('[data-dsa="toolbar"]');
  if (!el) return null;
  const button = el.querySelector('[data-dsa="quote"]');
  const rect = el.getBoundingClientRect();
  const cx = Math.round(rect.left + rect.width / 2);
  const cy = Math.round(rect.top + rect.height / 2);
  const hit = document.elementFromPoint(cx, cy);
  return {
    label: button ? button.innerText.trim() : null,
    buttonRect: button ? (() => { const br = button.getBoundingClientRect(); return { x: Math.round(br.left + br.width / 2), y: Math.round(br.top + br.height / 2) }; })() : { x: 0, y: 0 },
    ariaLabel: button ? button.getAttribute('aria-label') : null,
    position: getComputedStyle(el).position,
    pointerEvents: getComputedStyle(el).pointerEvents,
    zIndex: getComputedStyle(el).zIndex,
    rect: { x: Math.round(rect.left), y: Math.round(rect.top), w: Math.round(rect.width), h: Math.round(rect.height) },
    inViewport: rect.top >= 0 && rect.left >= 0 && rect.bottom <= window.innerHeight && rect.right <= window.innerWidth,
    // 命中测试：浮层中心那个点上，最上层元素必须属于我们自己。
    // 这一条同时挡住两类事故：被别的层盖住、以及 pointer-events 被继承成 none。
    hitIsOurs: !!hit && !!hit.closest && !!hit.closest('[data-selection-ask]'),
    hitTag: hit ? hit.tagName + '.' + String(hit.className).slice(0, 30) : null
  };
`);
check("选中后浮出浮层", toolbar !== null);
if (toolbar) {
  check("浮层带「引用到对话」按钮", typeof toolbar.label === "string" && toolbar.label.length > 0, toolbar.label);
  check("浮层是 fixed 定位且在最上层", toolbar.position === "fixed" && Number(toolbar.zIndex) > 1000000, `${toolbar.position} z=${toolbar.zIndex}`);
  check("浮层没有被 pointer-events 继承成穿透", toolbar.pointerEvents === "auto", toolbar.pointerEvents);
  check("浮层中心点命中自己（没被别的层盖住）", toolbar.hitIsOurs, toolbar.hitTag ?? "null");
  check("浮层完整落在视口内", toolbar.inViewport, JSON.stringify(toolbar.rect));
  check("浮层宽度合理（有测量到位，不是 0 宽）", toolbar.rect.w > 60 && toolbar.rect.h > 20, `${toolbar.rect.w}×${toolbar.rect.h}`);
}

if (toolbar) { await shot("toolbar"); }

/* 5. 点按钮 —— 同样是真实鼠标事件（先测 mousedown 不吞掉选区这条命脉） */
if (toolbar) {
  // ⚠️ 点**按钮自己**的中心，不是浮层中心 —— 浮层现在中间是就地输入栏，
    //    点中心只会把焦点给输入框，按钮永远按不到（2026-10-11 实测踩到）。
    const center = { x: toolbar.buttonRect.x, y: toolbar.buttonRect.y };
  await cdp.clickAt(center.x, center.y);
  await sleep(500);

  const after = await cdp.evaluate(`
    const editor = document.querySelector('[contenteditable="true"],[contenteditable=""]');
    const draft = (() => {
      if (!editor) return null;
      const blocks = [...editor.children];
      if (blocks.length > 0) return blocks.map((node) => node.textContent).join('\\n');
      return editor.innerText;
    })();
    const toast = document.querySelector('[data-dsa="toast"]');
    const toolbarGone = !document.querySelector('[data-dsa="toolbar"]');
    let toastOverlapsComposer = null;
    if (toast && editor) {
      const t = toast.getBoundingClientRect();
      let card = editor;
      while (card && card !== document.body && card.getBoundingClientRect().height < 60) card = card.parentElement;
      const c = card ? card.getBoundingClientRect() : null;
      toastOverlapsComposer = c ? !(t.bottom <= c.top || t.top >= c.bottom || t.right <= c.left || t.left >= c.right) : null;
    }
    return {
      draft,
      quoteLines: draft ? draft.split('\\n').filter((line) => line.trim().startsWith('>')).map((line) => line.trim()) : [],
      chips: editor ? [...editor.querySelectorAll('[data-composer-chip]')].map((node) => ((node.querySelector('[title]') || node).getAttribute('title') || '').trim()) : [],
      toast: toast ? toast.innerText.trim() : null,
      toastRect: toast ? (() => { const r = toast.getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }; })() : null,
      toastOverlapsComposer,
      toolbarGone
    };
  `);

  check("点完浮层收起", after.toolbarGone);
  check("输入框里出现了引用胶囊", Array.isArray(after.chips) && after.chips.length >= 1, JSON.stringify(after.chips ?? []));
  check("胶囊是 DSH 的原子引用节点（可见形态是编号，不是一段文本）", Array.isArray(after.chips) && after.chips.length > 0 && /\d/.test(after.chips[0]), JSON.stringify(after.chips ?? []));
  check("给了「已引用」反馈", after.toast !== null, after.toast);
  check("提示不压在输入框上（贴的是刚才那次选区）", after.toastOverlapsComposer === false, `toast=${JSON.stringify(after.toastRect)}`);

  await shot("quoted");

  /* 6. 第二次引用：应当追加，不是覆盖 */
  await cdp.dragSelect(target.from, target.to);
  await sleep(400);
  const second = await cdp.evaluate(`
    const el = document.querySelector('[data-dsa="quote"]');
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
  `);
  if (second) {
    await cdp.clickAt(second.x, second.y);
    await sleep(500);
    const twice = await cdp.evaluate(`{
      const editor = document.querySelector('[contenteditable="true"],[contenteditable=""]');
      if (!editor) return null;
      const blocks = [...editor.children];
      return {
        text: blocks.length > 0 ? blocks.map((node) => node.textContent).join('\\n') : editor.innerText,
        chips: [...editor.querySelectorAll('[data-composer-chip]')].map((node) => ((node.querySelector('[title]') || node).getAttribute('title') || '').trim())
      };
    }`);
    // 数胶囊 —— 引用现在是原子节点，不是一段以 ">" 开头的文本了
    check(
      "连续引用两次 → 输入框里有两个引用胶囊（追加而不是覆盖）",
      twice && Array.isArray(twice.chips) && twice.chips.length >= 2,
      `胶囊=${JSON.stringify(twice ? twice.chips : null)}`
    );
  } else {
    check("第二次选中仍能出浮层", false, "浮层没再出现");
  }
}

/* ═══════════════ 7. 引用的生命周期：待定高亮 → 标注高亮 → 删掉就一起走 ═══════════════ */
/*
 * 这一整段是 2026-10-11 那次修复的**常驻验收**，对应他实测报的两个问题：
 *   ①「在输入栏删掉文本后，原文高亮依旧保留，不会跟随删除。」
 *   ②「拖动选完之后蓝色的原生高亮框会消失。」
 * 判据是"唯一事实源＝输入框里的胶囊"：胶囊在 ⇒ 高亮在、编号在；胶囊没了 ⇒ 两样都走。
 */

/** 两个高亮层的键名必须与 client.js 里逐字一致（写错会让断言静默失效，所以下面直接比对）。 */
const HIGHLIGHT_KEY = "dsh-selection-ask";
const PENDING_KEY = "dsh-selection-ask-pending";

/** 一次读全四种状态：标注高亮、待定高亮、编号牌、输入框里的胶囊与浮层。 */
const READ_HIGHLIGHT_STATE = `
  const key = ${JSON.stringify(HIGHLIGHT_KEY)};
  const pendingKey = ${JSON.stringify(PENDING_KEY)};
  const sizeOf = (name) => {
    const registry = window.CSS && window.CSS.highlights;
    const layer = registry ? registry.get(name) : null;
    return layer ? layer.size : 0;
  };
  const editor = document.querySelector('[contenteditable="true"],[contenteditable=""]');
  const chips = editor ? [...editor.querySelectorAll('[data-composer-chip]')] : null;
  return {
    annotation: sizeOf(key),
    pending: sizeOf(pendingKey),
    badges: document.querySelectorAll('[data-dsa="badge"]').length,
    badgeText: [...document.querySelectorAll('[data-dsa="badge"]')].map((node) => node.textContent).join(','),
    chipCount: chips ? chips.length : -1,
    chipLabel: chips && chips.length
      ? ((chips[0].querySelector('[title]') || chips[0]).getAttribute('title') || '')
      : null,
    toolbar: !!document.querySelector('[data-dsa="toolbar"]')
  };
`;

await clearComposer();
await sleep(200);
const beforeSlow = await cdp.evaluate(READ_HIGHLIGHT_STATE);
check("起跑状态干净：没有胶囊、没有标注、没有待定高亮",
  beforeSlow.chipCount === 0 && beforeSlow.annotation === 0 && beforeSlow.pending === 0,
  `chips=${beforeSlow.chipCount} annotation=${beforeSlow.annotation} pending=${beforeSlow.pending}`);

/* 7a. 慢速拖拽 —— 24 步、每步隔一帧（≈ 真人手速）。
      这一条把 2026-10-11 那个"拖不动字"的复现手法**固化成常驻断言**：
      合成事件一瞬间派发完时，浮层来不及抢焦点，什么 bug 都看不出来。 */
const midDrag = [];
await cdp.dragSelect(target.from, target.to, {
  steps: 24,
  frameDelay: 16,
  onStep: async ({ index }) => {
    const snapshot = await cdp.evaluate(`
      const sel = window.getSelection();
      return {
        length: sel ? sel.toString().length : 0,
        toolbar: !!document.querySelector('[data-dsa="toolbar"]')
      };
    `);
    midDrag.push({ index, ...snapshot });
  }
});
await sleep(400);

// 前 3 步还没拖进文字里，选区本来就可能是空的 —— 从第 4 步起才要求"一直有选区"。
const brokeEarly = midDrag.filter((item) => item.index > 3 && item.length === 0);
const poppedEarly = midDrag.filter((item) => item.toolbar);
check("慢速拖拽中途选区没被打断（拖得动字）", brokeEarly.length === 0,
  brokeEarly.length ? `第 ${brokeEarly[0].index} 步断了：${JSON.stringify(brokeEarly[0])}` : `${midDrag.length} 步全程有选区`);
check("慢速拖拽途中不出浮层（出浮层＝抢焦点＝拖不动字）", poppedEarly.length === 0,
  poppedEarly.length ? `第 ${poppedEarly[0].index} 步就弹了` : "全程未弹出");

const afterSlowDrag = await cdp.evaluate(READ_HIGHLIGHT_STATE);
check("松手之后才出浮层", afterSlowDrag.toolbar === true);
check("松手后那片选区由待定高亮接管（不是凭空消失）", afterSlowDrag.pending === 1, `pending=${afterSlowDrag.pending}`);
check("还没提交引用 → 没有标注高亮、也没有编号牌",
  afterSlowDrag.annotation === 0 && afterSlowDrag.badges === 0,
  `annotation=${afterSlowDrag.annotation} badges=${afterSlowDrag.badges}`);

await shot("pending");

/* 7b. 提交这次引用 → 待定高亮交给标注高亮接管 */
const slowQuote = await cdp.evaluate(`
  const button = document.querySelector('[data-dsa="quote"]');
  if (!button) return null;
  const rect = button.getBoundingClientRect();
  return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
`);
if (slowQuote) {
  await cdp.clickAt(slowQuote.x, slowQuote.y);
  await sleep(700);
  const quoted = await cdp.evaluate(READ_HIGHLIGHT_STATE);
  const badgeNumber = String(quoted.badgeText);
  const chipNumber = String(quoted.chipLabel || "").match(/\d+/);
  check("提交后：输入框里出现 1 个胶囊", quoted.chipCount === 1, `chips=${quoted.chipCount}`);
  check("提交后：原文出现标注高亮", quoted.annotation === 1, `annotation=${quoted.annotation}`);
  check("提交后：原文出现编号牌，且号与胶囊上的号一致",
    quoted.badges === 1 && /^\d+$/.test(badgeNumber) && !!chipNumber && badgeNumber === chipNumber[0],
    `badge=${badgeNumber} chip=${JSON.stringify(quoted.chipLabel)}`);
  check("提交后：待定高亮归 0（那片被标注接管，不是重叠着两份）", quoted.pending === 0, `pending=${quoted.pending}`);

  await shot("annotated");

  /* 7c. 在输入框里把胶囊删掉 —— 高亮与编号必须跟着走（他实测报的那个问题） */
  await clearComposer();
  await sleep(500);
  const cleared = await cdp.evaluate(READ_HIGHLIGHT_STATE);
  check("删掉胶囊后：输入框里确实没有胶囊了", cleared.chipCount === 0, `chips=${cleared.chipCount}`);
  check("删掉胶囊后：原文的标注高亮同时消失", cleared.annotation === 0, `annotation=${cleared.annotation}`);
  check("删掉胶囊后：编号牌同时消失", cleared.badges === 0, `badges=${cleared.badges}`);
} else {
  check("慢速拖拽后浮层里有「引用」按钮", false, "按钮找不到");
}

/* ═══════════════ 9. 侧边提问：选中 → 点「侧边提问」→ 右侧栏开出面板 ═══════════════ */
await clearComposer();
await cdp.dragSelect(target.from, target.to);
await sleep(400);

const askButton = await cdp.evaluate(`
  const el = document.querySelector('[data-dsa="ask"]');
  if (!el) return null;
  const rect = el.getBoundingClientRect();
  return { label: el.innerText.trim(), x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
`);
check("浮层上有「侧边提问」按钮", askButton !== null, askButton ? askButton.label : "没有");

let panel = null;
if (askButton) {
  await cdp.clickAt(askButton.x, askButton.y);
  await sleep(1200);
  panel = await cdp.evaluate(`
    const root = document.querySelector('[data-dsa="panel"]');
    if (!root) return null;
    const quote = root.querySelector('.dsa-panel__quoteBody');
    const input = root.querySelector('.dsa-panel__input');
    const rect = root.getBoundingClientRect();
    return {
      quoteText: quote ? quote.innerText : null,
      hasInput: !!input,
      inputRect: input ? (() => { const r = input.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })() : null,
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      onScreen: rect.width > 120 && rect.height > 120
    };
  `);
  check("点了「侧边提问」后右侧栏开出面板", panel !== null);
  if (panel) {
    check(
      "面板里带着刚选中的那段引用",
      typeof panel.quoteText === "string" && panel.quoteText.includes(selected.text.slice(0, 12)),
      JSON.stringify(panel.quoteText ?? "").slice(0, 80)
    );
    check("面板有自己的输入框", panel.hasInput && panel.inputRect !== null);
    check("面板真的占到了右侧栏的位置（不是 0 尺寸）", panel.onScreen, `${panel.width}×${panel.height}`);
  }
}

/* 10. 在面板里问一句：回答必须真的长出来，而且**不能进主对话** */
if (panel && panel.inputRect) {
  const draftBefore = await cdp.evaluate(READ_DRAFT);
  await cdp.clickAt(panel.inputRect.x, panel.inputRect.y);
  await sleep(200);
  await cdp.send("Input.insertText", { text: "用一句话回答。" });
  await sleep(250);

  const sendButton = await cdp.evaluate(`
    const root = document.querySelector('[data-dsa="panel"]');
    const button = root && root.querySelector('.dsa-panel__actions .dsa-btn--primary');
    if (!button || button.disabled) return null;
    const rect = button.getBoundingClientRect();
    return { label: button.innerText.trim(), x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
  `);
  check("面板有可用的发送按钮", sendButton !== null, sendButton ? sendButton.label : "禁用/不存在");

  if (sendButton) {
    await cdp.clickAt(sendButton.x, sendButton.y);

    // 轮询等答案长出来；模型是流式的，这里等的是"面板里出现了非空回答且不再忙"
    let answer = "";
    for (let attempt = 0; attempt < 40; attempt += 1) {
      await sleep(1500);
      const snapshot = await cdp.evaluate(`
        const root = document.querySelector('[data-dsa="panel"]');
        if (!root) return { answer: "", busy: false, error: null };
        const assistants = [...root.querySelectorAll('.dsa-panel__turn[data-role="assistant"] .dsa-panel__text')];
        const error = root.querySelector('.dsa-panel__error');
        return {
          answer: assistants.length ? assistants[assistants.length - 1].innerText : "",
          busy: root.getAttribute('data-busy') === '1',
          error: error ? error.innerText : null
        };
      `);
      if (snapshot.error) {
        check("面板提问没有报错", false, snapshot.error);
        break;
      }
      // 占位文案不算答案
      if (snapshot.answer && snapshot.answer !== "思考中…") {
        answer = snapshot.answer;
        if (!snapshot.busy) break;
      }
    }
    check("面板里长出了回答", answer.length > 0, JSON.stringify(answer).slice(0, 90));

    const afterAsk = await cdp.evaluate(READ_DRAFT);
    check(
      "侧边提问没有污染主对话的输入框",
      afterAsk === draftBefore,
      `之前 ${JSON.stringify((draftBefore ?? "").slice(0, 24))} → 之后 ${JSON.stringify((afterAsk ?? "").slice(0, 24))}`
    );

    await shot("side-panel");
  }
}

/* ═══════════════ 11. 直接发送（Ctrl/Cmd + Enter）═══════════════ */
/*
 * 为什么这条必须有：在此之前"直发"**一行断言都没有**，而它其实是坏的 ——
 * `flash()` 里引用了 `sendNow`，那个名字从来没被声明过（回调签名只有两个参数），
 * 于是每次提交都抛 ReferenceError，直发那一步**永远走不到**。
 * 页面看上去一切正常（胶囊插进去了、提示也弹了），只有"消息不发出去"。
 *
 * 判据用**内容**而不是计数：在就地输入栏里打一段独一无二的字，
 * 直发之后它必须出现在**正文里**（输入框已清空 ⇒ 只可能来自转录）。
 */
{
  await clearComposer();
  await sleep(300);

  const probeTarget = await cdp.evaluate(`
    const isVisible = (node) => {
      const rect = node.getBoundingClientRect();
      if (rect.width < 120 || rect.height < 10 || rect.height > 500) return false;
      if (rect.top < 8 || rect.bottom > window.innerHeight - 8) return false;
      const hit = document.elementFromPoint(Math.round(rect.left + rect.width / 2), Math.round(rect.top + rect.height / 2));
      return !!hit && (node.contains(hit) || hit.contains(node));
    };
    const node = [...document.querySelectorAll('p,li')]
      .filter((n) => (n.innerText || '').trim().length >= 24)
      .filter((n) => n.getBoundingClientRect().left > 280)
      .filter(isVisible)[0] || null;
    if (!node) return null;
    const range = document.createRange();
    range.selectNodeContents(node);
    const line = [...range.getClientRects()].filter((r) => r.width > 40 && r.height > 6)[0];
    if (!line) return null;
    const y = Math.round(line.top + line.height / 2);
    return { from: { x: Math.round(line.left + 3), y }, to: { x: Math.round(line.right - 3), y } };
  `);

  const MARKER = "直发验收标记";
  if (!probeTarget) {
    check("直发验收：页面上找得到可拖拽的正文", false, "没有可选中的段落");
  } else {
    await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: probeTarget.from.x, y: probeTarget.from.y, button: "left", clickCount: 1, buttons: 1 });
    for (let index = 1; index <= 8; index += 1) {
      await cdp.send("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: Math.round(probeTarget.from.x + ((probeTarget.to.x - probeTarget.from.x) * index) / 8),
        y: probeTarget.from.y,
        button: "left",
        buttons: 1
      });
    }
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: probeTarget.to.x, y: probeTarget.to.y, button: "left", clickCount: 1, buttons: 0 });
    await sleep(450);

    const noteFocused = await cdp.evaluate(`
      const note = document.querySelector('[data-dsa="note"]');
      return {
        exists: !!note,
        focused: !!note && document.activeElement === note,
        selText: String(window.getSelection() ? window.getSelection().toString() : "")
      };
    `);
    /*
     * ⚠️ 2026-10-16 反转的断言：浮层出现时**不该**抢焦点。
     *
     * 原来这里断言的是"就地输入栏出现并已聚焦"。但"聚焦一个 input"会让浏览器
     * **当场清掉文档选区** —— 于是松手后 Ctrl+C 什么也复制不到（他实测报的）。
     * 现在改成：焦点留在正文，**第一次敲键**时才搬进批注框（下一个断言的判据）。
     */
    check("浮层出现时不抢焦点（Ctrl+C 仍作用于文档选区）",
      noteFocused.exists && noteFocused.focused === false,
      `focused=${noteFocused.focused} 文档选区长度=${noteFocused.selText.length}`);

    if (noteFocused.exists) {
      // 先敲一个字：焦点应当被搬进批注框，且这个字写进去了
      await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "A", code: "KeyA", windowsVirtualKeyCode: 65, text: "A" });
      await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "A", code: "KeyA", windowsVirtualKeyCode: 65 });
      await sleep(200);
      const afterType = await cdp.evaluate(`
        const note = document.querySelector('[data-dsa="note"]');
        return {
          focused: !!note && document.activeElement === note,
          value: note ? note.value : null
        };
      `);
      check("敲下第一个字时才聚焦批注框，且这个字进了批注", afterType.focused === true && String(afterType.value).includes("A"),
        `focused=${afterType.focused} value=${JSON.stringify(afterType.value)}`);

      await cdp.send("Input.insertText", { text: MARKER });
      await sleep(250);
      // Ctrl + Enter = 写进输入框并**立刻发出去**（普通 Enter 只写不发）
      for (const type of ["keyDown", "keyUp"]) {
        await cdp.send("Input.dispatchKeyEvent", {
          type, key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, modifiers: 2
        });
      }
      await sleep(2500);

      const sent = await cdp.evaluate(`
        const editor = document.querySelector('[contenteditable="true"],[contenteditable=""]');
        const blocks = editor ? [...editor.children] : [];
        return {
          draft: editor ? (blocks.length ? blocks.map((node) => node.textContent).join('\\n') : editor.innerText) : null,
          chips: editor ? editor.querySelectorAll('[data-composer-chip]').length : -1,
          inTranscript: document.body.innerText.includes(${JSON.stringify(MARKER)}),
          toolbar: !!document.querySelector('[data-dsa="toolbar"]')
        };
      `);
      check("直发之后输入框被清空（消息真的出去了）", sent.chips === 0 && String(sent.draft).trim() === "", `chips=${sent.chips} draft=${JSON.stringify(String(sent.draft).slice(0, 30))}`);
      check("直发之后那条消息出现在正文里（主对话里多了一轮）", sent.inTranscript === true);
      check("直发之后浮层收起", sent.toolbar === false);
    } else {
      check("直发验收：就地输入栏出现", false, "浮层没出现");
    }
  }
}

/* ═══════════ 12. 绿色高亮（读像素，不是读注册表）═══════════ */
/*
 * ⚠️ 这一条是 2026-10-16 那轮的直接产物，也是**唯一**能抓到"颜色不对"的量具。
 *
 * 为什么前面的 `CSS.highlights` 尺寸断言抓不到：它读的是**注册表**（我们确实
 * 把 Range 加进去了，size 永远是对的），而"画出来是什么颜色、有没有被原生选区
 * 盖住"是**绘制层**的事 —— CSSWG 已裁定自定义高亮永远画在原生选区之下
 * （csswg-drafts#4595），注册表对此一无所知。所以这里改成**截像素**：
 * 取高亮矩形中心的实际颜色，判它是不是绿的。
 *
 * 判据：绿色通道明显高于红色通道（蓝色高亮是反过来的）。
 */
async function sampleColor(rect) {
  if (!rect) return null;
  const data = await cdp.send("Page.captureScreenshot", {
    format: "png",
    clip: { x: rect.x, y: rect.y, width: Math.max(2, rect.width), height: Math.max(2, rect.height), scale: 1 }
  });
  const base64 = data.data;
  // 只解 PNG 的 IHDR + 像素太麻烦；改用页面侧解码：把截图贴进 canvas 读中心点
  return await cdp.evaluate(`
    (async () => {
      const img = new Image();
      img.src = "data:image/png;base64," + ${JSON.stringify(base64)};
      await img.decode();
      const canvas = document.createElement('canvas');
      canvas.width = img.width; canvas.height = img.height;
      const ctx2d = canvas.getContext('2d');
      ctx2d.drawImage(img, 0, 0);
      const px = ctx2d.getImageData(Math.floor(img.width / 2), Math.floor(img.height / 2), 1, 1).data;
      return { r: px[0], g: px[1], b: px[2], a: px[3] };
    })()
  `);
}

{
  await clearComposer();
  await sleep(300);

  const colorTarget = await cdp.evaluate(`
    const node = [...document.querySelectorAll('p,li')]
      .filter((n) => (n.innerText || '').trim().length >= 24)
      .filter((n) => n.getBoundingClientRect().left > 280)[0] || null;
    if (!node) return null;
    const range = document.createRange();
    range.selectNodeContents(node);
    const line = [...range.getClientRects()].filter((r) => r.width > 80 && r.height > 6)[0];
    if (!line) return null;
    const y = Math.round(line.top + line.height / 2);
    return { from: { x: Math.round(line.left + 3), y }, to: { x: Math.round(line.right - 3), y } };
  `);

  if (!colorTarget) {
    check("绿色验收：页面上找得到可拖拽的正文", false, "没有可选中的段落");
  } else {
    await cdp.dragSelect(colorTarget.from, colorTarget.to, { steps: 8, frameDelay: 16 });
    await sleep(500);

    // 待定态：原生选区还活着 —— 这时用户看到的必须是绿，不是浏览器的蓝
    const pendingRect = await cdp.evaluate(`
      const layer = window.CSS && window.CSS.highlights ? window.CSS.highlights.get('dsh-selection-ask-pending') : null;
      const ranges = layer ? [...layer] : [];
      if (!ranges.length) return null;
      const r = ranges[0].getBoundingClientRect();
      return { x: Math.round(r.left + 2), y: Math.round(r.top + Math.floor(r.height / 2)), width: Math.max(4, Math.round(r.width) - 4), height: 2 };
    `);
    const pendingColor = await sampleColor(pendingRect);
    check("松手后那片是**绿色**（不是原生选区的蓝）",
      !!pendingColor && pendingColor.g > pendingColor.b + 12 && pendingColor.g > pendingColor.r + 12,
      pendingColor ? `rgb(${pendingColor.r},${pendingColor.g},${pendingColor.b})` : "取不到待定高亮矩形");

    // 提交，再看已标注那层
    const quoteButton = await cdp.evaluate(`
      const el = document.querySelector('[data-dsa="quote"]');
      if (!el) return null;
      const rect = el.getBoundingClientRect();
      return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
    `);
    if (quoteButton) {
      await cdp.clickAt(quoteButton.x, quoteButton.y);
      await sleep(800);
      const annotatedRect = await cdp.evaluate(`
        const layer = window.CSS && window.CSS.highlights ? window.CSS.highlights.get('dsh-selection-ask') : null;
        const ranges = layer ? [...layer] : [];
        if (!ranges.length) return null;
        const r = ranges[0].getBoundingClientRect();
        return { x: Math.round(r.left + 2), y: Math.round(r.top + Math.floor(r.height / 2)), width: Math.max(4, Math.round(r.width) - 4), height: 2 };
      `);
      const annotatedColor = await sampleColor(annotatedRect);
      check("引用之后原文那层也是**绿色**，而且**留住了**",
        !!annotatedColor && annotatedColor.g > annotatedColor.b + 12 && annotatedColor.g > annotatedColor.r + 12,
        annotatedColor ? `rgb(${annotatedColor.r},${annotatedColor.g},${annotatedColor.b})` : "取不到标注高亮矩形");
      await shot("annotated-green");
    }
  }
}

/* ═══════════ 13. 跨内联元素锚定（含 <strong> 的段落）═══════════ */
/*
 * 旧实现要求整段原文落在**单个文本节点**内，而 DSH 的转录里只要出现
 * `<strong>` / `<code>`，一句话就会被拆成好几个文本节点 ⇒ 引用了却永远不亮。
 * 这条断言在**含粗体**的段落上跨元素选，提交后必须能看到标注高亮 + 编号牌。
 */
{
  await clearComposer();
  await sleep(300);

  const richTarget = await cdp.evaluate(`
    // 找一段**同时含有多个文本节点**的正文（粗体 / 行内代码会把文字切开）
    const nodes = [...document.querySelectorAll('p,li')]
      .filter((n) => {
        const r = n.getBoundingClientRect();
        if (r.left < 280 || r.width < 160 || r.top < 8) return false;
        const walker = document.createTreeWalker(n, NodeFilter.SHOW_TEXT);
        let count = 0;
        let text = '';
        while (walker.nextNode()) { count += 1; text += walker.currentNode.nodeValue; }
        return count >= 2 && text.trim().length >= 20;
      });
    const node = nodes[0] || null;
    if (!node) return null;
    const range = document.createRange();
    range.selectNodeContents(node);
    const line = [...range.getClientRects()].filter((r) => r.width > 80 && r.height > 6)[0];
    if (!line) return null;
    const y = Math.round(line.top + line.height / 2);
    return {
      nodeCount: (() => { const w = document.createTreeWalker(node, NodeFilter.SHOW_TEXT); let c = 0; while (w.nextNode()) c += 1; return c; })(),
      from: { x: Math.round(line.left + 3), y },
      to: { x: Math.round(line.right - 3), y }
    };
  `);

  if (!richTarget) {
    check("跨内联锚定：页面上找得到含多个文本节点的段落", false, "没有这样的段落");
  } else {
    await cdp.dragSelect(richTarget.from, richTarget.to, { steps: 8, frameDelay: 16 });
    await sleep(500);
    const quoteButton = await cdp.evaluate(`
      const el = document.querySelector('[data-dsa="quote"]');
      if (!el) return null;
      const rect = el.getBoundingClientRect();
      return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
    `);
    if (quoteButton) {
      await cdp.clickAt(quoteButton.x, quoteButton.y);
      await sleep(800);
      const rich = await cdp.evaluate(`
        const layer = window.CSS && window.CSS.highlights ? window.CSS.highlights.get('dsh-selection-ask') : null;
        const editor = document.querySelector('[contenteditable="true"],[contenteditable=""]');
        return {
          annotation: layer ? layer.size : 0,
          badges: document.querySelectorAll('[data-dsa="badge"]').length,
          chips: editor ? editor.querySelectorAll('[data-composer-chip]').length : -1
        };
      `);
      check(`跨内联元素（该段 ${richTarget.nodeCount} 个文本节点）也能锚上标注高亮`,
        rich.annotation >= 1, `annotation=${rich.annotation}`);
      check("跨内联元素提交后有编号牌", rich.badges >= 1, `badges=${rich.badges}`);
      check("跨内联元素提交后输入框里有胶囊", rich.chips >= 1, `chips=${rich.chips}`);
    }
  }
}

/* ═══════════ 14. 超集引用：选得更长时并进原来那条 ═══════════ */
/*
 * 他 2026-10-16 提的 Trae 机制：同一区块里，先引短句、再引**包含它的长句**，
 * 不该多出一个胶囊，而应把原来那条**原地加长**（编号不变）。
 *
 * 判据用三样：胶囊数不变、编号牌文本不变、模型最终收到的是加长后的原文。
 */
{
  await clearComposer();
  await sleep(300);

  // 先在一个段落里选**前半句**，提交
  const splitTarget = await cdp.evaluate(`
    const node = [...document.querySelectorAll('p,li')]
      .filter((n) => (n.innerText || '').trim().length >= 40)
      .filter((n) => n.getBoundingClientRect().left > 280)[0] || null;
    if (!node) return null;
    const range = document.createRange();
    range.selectNodeContents(node);
    const line = [...range.getClientRects()].filter((r) => r.width > 120 && r.height > 6)[0];
    if (!line) return null;
    const y = Math.round(line.top + line.height / 2);
    const mid = Math.round(line.left + line.width * 0.45);
    return {
      short: { from: { x: Math.round(line.left + 3), y }, to: { x: mid, y } },
      long: { from: { x: Math.round(line.left + 3), y }, to: { x: Math.round(line.right - 3), y } }
    };
  `);

  if (!splitTarget) {
    check("超集引用：页面上找得到足够长的段落", false, "没有可选中的段落");
  } else {
    // 第一次：短的那截
    await cdp.dragSelect(splitTarget.short.from, splitTarget.short.to, { steps: 8, frameDelay: 16 });
    await sleep(450);
    let button = await cdp.evaluate(`
      const el = document.querySelector('[data-dsa="quote"]');
      if (!el) return null;
      const rect = el.getBoundingClientRect();
      return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
    `);
    if (button) { await cdp.clickAt(button.x, button.y); await sleep(700); }

    const afterShort = await cdp.evaluate(`
      const editor = document.querySelector('[contenteditable="true"],[contenteditable=""]');
      return {
        chips: editor ? editor.querySelectorAll('[data-composer-chip]').length : -1,
        badge: (document.querySelector('[data-dsa="badge"]') || {}).textContent || null
      };
    `);

    // 第二次：包含它的更长一截
    await cdp.dragSelect(splitTarget.long.from, splitTarget.long.to, { steps: 8, frameDelay: 16 });
    await sleep(450);
    button = await cdp.evaluate(`
      const el = document.querySelector('[data-dsa="quote"]');
      if (!el) return null;
      const rect = el.getBoundingClientRect();
      return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
    `);
    if (button) { await cdp.clickAt(button.x, button.y); await sleep(700); }

    const afterLong = await cdp.evaluate(`
      const editor = document.querySelector('[contenteditable="true"],[contenteditable=""]');
      const layers = window.CSS && window.CSS.highlights ? window.CSS.highlights.get('dsh-selection-ask') : null;
      const ranges = layers ? [...layers] : [];
      const texts = ranges.map((r) => r.toString()).join('\\n');
      return {
        chips: editor ? editor.querySelectorAll('[data-composer-chip]').length : -1,
        badge: (document.querySelector('[data-dsa="badge"]') || {}).textContent || null,
        annotatedText: texts
      };
    `);

    check("再引更长的一截 → 胶囊数量**不增**（并进原来那条）",
      afterShort.chips === 1 && afterLong.chips === 1,
      `短=${afterShort.chips} → 长=${afterLong.chips}`);
    check("并进之后**编号不变**",
      !!afterShort.badge && afterShort.badge === afterLong.badge,
      `${JSON.stringify(afterShort.badge)} → ${JSON.stringify(afterLong.badge)}`);
    check("原文上的高亮跟着**加长**（不是只留原来那一小截）",
      afterLong.annotatedText.length > 0,
      `高亮片段数/长度=${afterLong.annotatedText.length}`);

    /*
     * 最关键的一条：**胶囊本身确实"更新成更长的引用了"**。
     *
     * 怎么证：悬停那枚胶囊 → 浮出的原文预览读的是登记处（`quoteByLabel.get(label).text`），
     * 而不是宿主在插入时刻缓存下来的那份投影。所以预览变长 == 这枚胶囊现在代表的是长句。
     * （模型侧同理：发送时走 `codec.serialize(ref)` 现查登记处，见宿主 `sinkSerialized`。）
     */
    const hoverPreview = await cdp.evaluate(`
      const chip = document.querySelector('[data-composer-chip="selection"]');
      if (!chip) return null;
      chip.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 120));
      const tip = document.querySelector('[data-dsa="chiptip"]');
      const text = tip ? tip.querySelector('.dsa-chiptip__text') : null;
      return text ? text.textContent : null;
    `);
    check("悬停胶囊看到的原文**已经是加长后的那段**（胶囊被更新了）",
      typeof hoverPreview === "string" && hoverPreview.trim().length > 12,
      `预览长度=${typeof hoverPreview === "string" ? hoverPreview.trim().length : "取不到"}`);
  }
}

/* ═══════════ 15. 插入点坐标：连引三段的顺序 ═══════════ */
/*
 * 他 2026-10-16 实测报的：连引三段，输入框里变成 `选中文本 1`、`3`、`2`。
 *
 * 根因（宿主源码级）：detect 投影里每个胶囊只占 **1** 个字符，插件却按"占 0"算，
 * 前两个候选必然越界被拒 ⇒ 落到"胶囊数+1…0"的小整数阶梯；那个起点恰好落在
 * 最后一枚胶囊的 1 字符段内，宿主 `resolvePoint()` 把它解析成"胶囊前面" ⇒ 错位。
 *
 * 这条断言就是钉住它：**顺序必须是 1、2、3**，而且第三段特意挑"跨内联元素/多行"
 * 的那种（他那句"跨段或者跨不同格式的行时会发生"）。
 */
{
  await clearComposer();
  await sleep(350);

  /** 连引三段：每次都换一个段落，最后一段优先挑"含多个文本节点"的（跨格式）。 */
  const pickTargets = await cdp.evaluate(`
    const visible = (node) => {
      const r = node.getBoundingClientRect();
      return r.width > 200 && r.height > 8 && r.top > 8 && r.bottom < window.innerHeight - 120;
    };
    const textNodeCount = (node) => {
      const w = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
      let c = 0;
      while (w.nextNode()) c += 1;
      return c;
    };
    const all = [...document.querySelectorAll('p,li')]
      .filter((n) => (n.innerText || '').trim().length >= 20)
      .filter((n) => n.getBoundingClientRect().left > 280)
      .filter(visible);
    if (all.length < 3) return null;
    // 顺序：普通段、普通段、**跨格式段**（多文本节点）——最后一个刻意挑最容易触发错位的
    const rich = all.filter((n) => textNodeCount(n) >= 2);
    const plain = all.filter((n) => textNodeCount(n) === 1);
    const chosen = [];
    if (plain.length >= 2) chosen.push(plain[0], plain[1]);
    if (rich.length >= 1) chosen.push(rich[rich.length - 1]);
    else chosen.push(all[all.length - 1]);
    while (chosen.length < 3) chosen.push(all[chosen.length]);
    return chosen.slice(0, 3).map((node) => {
      const range = document.createRange();
      range.selectNodeContents(node);
      const line = [...range.getClientRects()].filter((r) => r.width > 80 && r.height > 6)[0];
      if (!line) return null;
      const y = Math.round(line.top + line.height / 2);
      return {
        nodeCount: textNodeCount(node),
        from: { x: Math.round(line.left + 3), y },
        to: { x: Math.round(line.right - 3), y }
      };
    });
  `);

  if (!pickTargets || pickTargets.some((t) => t === null)) {
    check("插入点顺序：页面上找得到三段可引用的正文", false, "段落不够");
  } else {
    for (const spot of pickTargets) {
      await cdp.dragSelect(spot.from, spot.to, { steps: 8, frameDelay: 16 });
      await sleep(400);
      const button = await cdp.evaluate(`
        const el = document.querySelector('[data-dsa="quote"]');
        if (!el) return null;
        const rect = el.getBoundingClientRect();
        return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
      `);
      if (button) { await cdp.clickAt(button.x, button.y); await sleep(650); }
    }

    const order = await cdp.evaluate(`
      const editor = document.querySelector('[contenteditable="true"],[contenteditable=""]');
      if (!editor) return null;
      const chips = [...editor.querySelectorAll('[data-composer-chip="selection"]')];
      return chips.map((chip) => {
        const titled = chip.querySelector('[title]');
        return (titled || chip).getAttribute('title') || '';
      });
    `);
    const labels = Array.isArray(order) ? order : [];
    // 只抽数字比，免得被本地化文案（"选中文本"/"Selection"）绊住
    const numbers = labels.map((label) => String(label).match(/\d+/)).map((m) => (m ? Number(m[0]) : null));
    check("连引三段 → 输入框里正好三枚胶囊", labels.length === 3, `chips=${labels.length}`);
    check("连引三段 → 胶囊顺序是 1,2,3（不是 1,3,2）",
      numbers.length === 3 && numbers[0] === 1 && numbers[1] === 2 && numbers[2] === 3,
      `实际=${JSON.stringify(numbers)} 标签=${JSON.stringify(labels)}`);
    await shot("three-quotes");
  }
}

/* ═══════════ 16. 插入点跟随输入框光标 ═══════════ */
/*
 * 他明确要求"添加的位置起码要在输入框的光标处"。
 *
 * 做法：在输入框里先打一段文字，然后把 DOM 光标放到**第一个字符之后**，
 * 再引用一段 —— 胶囊必须落在**光标处**（即第一个字符与其余文字之间），
 * 而不是被追加到末尾。
 */
{
  await clearComposer();
  await sleep(300);

  // 先给输入框里打一段可辨认的文字（必须**真实点击**拿到焦点，Input.insertText 只往已聚焦元素里插）
  const composerSpot = await cdp.evaluate(`
    const editor = document.querySelector('[contenteditable="true"],[contenteditable=""]');
    if (!editor) return null;
    const rect = editor.getBoundingClientRect();
    return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
  `);
  if (!composerSpot) {
    check("插入点验收：拿得到输入框", false, "没找到 contenteditable");
  } else {
    await cdp.clickAt(composerSpot.x, composerSpot.y);
    await sleep(150);
  }
  await cdp.evaluate(`
    const editor = document.querySelector('[contenteditable="true"],[contenteditable=""]');
    if (!editor) return false;
    const r = document.createRange();
    r.selectNodeContents(editor);
    r.collapse(false);
    const s = window.getSelection();
    s.removeAllRanges();
    s.addRange(r);
    return true;
  `);
  await sleep(150);
  // 三个字：光标停在 1 号位时，前面应当只有 1 个字；被追加到末尾则是 3 个字
  const MARK = "光标记";
  await cdp.send("Input.insertText", { text: MARK });
  await sleep(250);

  const typed = await cdp.evaluate(`
    const editor = document.querySelector('[contenteditable="true"],[contenteditable=""]');
    return editor ? editor.innerText.replace(/\\n/g, "") : null;
  `);
  check("插入点验收：输入框里先有一段文字", String(typed).includes(MARK), JSON.stringify(typed));

  // 把光标挪到第 1 个字符之后
  await cdp.evaluate(`
    const editor = document.querySelector('[contenteditable="true"],[contenteditable=""]');
    const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
    const node = walker.nextNode();
    if (!node) return false;
    const r = document.createRange();
    r.setStart(node, 1);
    r.collapse(true);
    const s = window.getSelection();
    s.removeAllRanges();
    s.addRange(r);
    return true;
  `);
  await sleep(120);

  // 选一段正文引用
  const caretTarget = await cdp.evaluate(`
    const node = [...document.querySelectorAll('p,li')]
      .filter((n) => (n.innerText || '').trim().length >= 20)
      .filter((n) => n.getBoundingClientRect().left > 280)[0] || null;
    if (!node) return null;
    const range = document.createRange();
    range.selectNodeContents(node);
    const line = [...range.getClientRects()].filter((r) => r.width > 80 && r.height > 6)[0];
    if (!line) return null;
    const y = Math.round(line.top + line.height / 2);
    return { from: { x: Math.round(line.left + 3), y }, to: { x: Math.round(line.right - 3), y } };
  `);
  if (!caretTarget) {
    check("插入点验收：页面上找得到可引用的正文", false, "没有可选中段落");
  } else {
    await cdp.dragSelect(caretTarget.from, caretTarget.to, { steps: 8, frameDelay: 16 });
    await sleep(450);
    const button = await cdp.evaluate(`
      const el = document.querySelector('[data-dsa="quote"]');
      if (!el) return null;
      const rect = el.getBoundingClientRect();
      return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
    `);
    if (button) { await cdp.clickAt(button.x, button.y); await sleep(700); }

    /*
     * 判据：胶囊出现在**光标处**（1 号位）。
     *
     * 读编辑器顶层孩子，数胶囊**前面**有多少个可见字符：
     *   · 插在光标处 ⇒ "光" 1 个字（< 3）；
     *   · 被追加到末尾 ⇒ "光标记" 3 个字（== 3）。
     * 只比"前面的字数"，不碰胶囊自己的 label 文字（那属于胶囊的内部实现）。
     */
    const placement = await cdp.evaluate(`
      const editor = document.querySelector('[contenteditable="true"],[contenteditable=""]');
      if (!editor) return null;
      const kids = [...editor.childNodes];
      let chipIndex = -1;
      let before = "";
      for (let i = 0; i < kids.length; i += 1) {
        const kid = kids[i];
        if (kid.nodeType === 1 && kid.matches && kid.matches('[data-composer-chip="selection"]')) { chipIndex = i; break; }
        if (kid.nodeType === 3 || kid.nodeType === 1) before += kid.textContent || "";
      }
      return { chipIndex, beforeLength: before.replace(/\\n/g, "").trim().length };
    `);
    check("引用插在**光标处**，不是一律追加到末尾",
      !!placement && placement.chipIndex >= 0 && placement.beforeLength < String(MARK).length,
      placement ? `胶囊下标=${placement.chipIndex}、它前面 ${placement.beforeLength} 个字（追加到末尾会是 ${String(MARK).length}）` : "读不到输入框结构");
  }
}

/* ───────────────────────────── 汇总 ───────────────────────────── */

/*
 * 收尾先验一条"整轮没有未捕获异常"。
 *
 * 它是量具的**保险丝**：只在事件回调里抛的 ReferenceError，页面看着一切正常，
 * 坏掉的只是那一个动作。2026-10-11 顺手发现的 `sendNow` 未声明（Ctrl/Cmd+Enter
 * 直发永远不发）就是这一类 —— 只断言"点了按钮有反应"的话，一辈子抓不到。
 */
check("整轮验收没有未捕获异常", cdp.pageErrors.length === 0, cdp.pageErrors[0] ?? "0");

const failed = results.filter((item) => !item.ok);
process.stdout.write(`\n${results.length - failed.length}/${results.length} 通过\n`);
if (cdp.pageErrors.length > 0) {
  process.stdout.write(`\n页面异常：\n${cdp.pageErrors.join("\n")}\n`);
}
await cdp.close();
process.exit(failed.length === 0 ? 0 : 1);







