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
check("浏览器里确实有了非折叠选区", !selected.collapsed && selected.text.length > 0, `选中「${selected.text}」`);

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
  const center = { x: toolbar.rect.x + Math.round(toolbar.rect.w / 2), y: toolbar.rect.y + Math.round(toolbar.rect.h / 2) };
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
      toast: toast ? toast.innerText.trim() : null,
      toastRect: toast ? (() => { const r = toast.getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }; })() : null,
      toastOverlapsComposer,
      toolbarGone
    };
  `);

  check("点完浮层收起", after.toolbarGone);
  check("输入框里出现了引用块", Array.isArray(after.quoteLines) && after.quoteLines.length >= 1, JSON.stringify(after.draft ?? "").slice(0, 120));
  check(
    "引用行内容 = 选中的那段文字",
    Array.isArray(after.quoteLines) && after.quoteLines.some((line) => line.includes(selected.text)),
    `选中「${selected.text}」→ 引用行 ${JSON.stringify(after.quoteLines)}`
  );
  check("给了「已引用」反馈", after.toast !== null, after.toast);
  check("提示不压在输入框上（贴的是刚才那次选区）", after.toastOverlapsComposer === false, `toast=${JSON.stringify(after.toastRect)}`);

  await shot("quoted");

  /* 6. 第二次引用：应当追加，不是覆盖 */
  await cdp.dragSelect(target.from, target.to);
  await sleep(400);
  const second = await cdp.evaluate(`
    const el = document.querySelector('[data-dsa="toolbar"]');
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
  `);
  if (second) {
    await cdp.clickAt(second.x, second.y);
    await sleep(500);
    const twice = await cdp.evaluate(`
      const editor = document.querySelector('[contenteditable="true"],[contenteditable=""]');
      if (!editor) return null;
      const blocks = [...editor.children];
      return blocks.length > 0 ? blocks.map((node) => node.textContent).join('\\n') : editor.innerText;
    `);
    // 数"引用块"：连续以 `>` 开头的行算一块
    const lines = typeof twice === "string" ? twice.split("\n") : [];
    let blocks = 0;
    let inside = false;
    for (const line of lines) {
      const isQuote = line.trim().startsWith(">");
      if (isQuote && !inside) blocks += 1;
      inside = isQuote;
    }
    check("连续引用两次 → 输入框里有两块独立引用（追加而不是覆盖）", blocks >= 2, `引用块数=${blocks}；草稿=${JSON.stringify(twice ?? "").slice(0, 160)}`);
  } else {
    check("第二次选中仍能出浮层", false, "浮层没再出现");
  }
}

/* 7. 侧边提问：选中 → 点「侧边提问」→ 右侧栏开出面板 → 面板里带着刚才那段引用 */
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

/* 8. 在面板里问一句：回答必须真的长出来，而且**不能进主对话** */
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

/* ───────────────────────────── 汇总 ───────────────────────────── */

const failed = results.filter((item) => !item.ok);
process.stdout.write(`\n${results.length - failed.length}/${results.length} 通过\n`);
if (cdp.pageErrors.length > 0) {
  process.stdout.write(`\n页面异常：\n${cdp.pageErrors.join("\n")}\n`);
}
await cdp.close();
process.exit(failed.length === 0 ? 0 : 1);

