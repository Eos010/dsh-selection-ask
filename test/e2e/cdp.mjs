/**
 * 极简 CDP 客户端 —— 零依赖，用 Node 自带的 WebSocket 说 Chrome DevTools 协议。
 *
 * 为什么自己写：这个仓库对外是"零运行时依赖"，测试也不该把 puppeteer 拖进来。
 * 我们只需要四件事：在页面里跑 JS、派发真实鼠标事件、截图、读控制台。
 *
 * 用法：
 *   const cdp = await connect({ port: 9223, urlPrefix: "http://127.0.0.1:3099" });
 *   await cdp.evaluate("1 + 1");
 *   await cdp.close();
 */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 连上某个端口上 Chrome 的目标页。
 *
 * @param {{port: number, urlPrefix?: string, timeoutMs?: number}} options
 * @returns {Promise<object>} 带 evaluate / send / screenshot / click / drag / close 的句柄
 */
export async function connect(options) {
  const port = options.port ?? 9223;
  const deadline = Date.now() + (options.timeoutMs ?? 15000);

  let target = null;
  while (Date.now() < deadline) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      target = list.find((item) => item.type === "page"
        && (!options.urlPrefix || String(item.url).startsWith(options.urlPrefix)));
      if (target) break;
    } catch {
      /* Chrome 还没起来 */
    }
    await sleep(300);
  }
  if (!target) throw new Error(`CDP: 在 ${port} 上找不到匹配的页面目标`);

  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", () => reject(new Error("CDP: WebSocket 连接失败")), { once: true });
  });

  let nextId = 1;
  const pending = new Map();
  const consoleLines = [];
  const pageErrors = [];

  socket.addEventListener("message", (event) => {
    let payload;
    try {
      payload = JSON.parse(event.data);
    } catch {
      return;
    }
    if (payload.id !== undefined && pending.has(payload.id)) {
      const { resolve, reject } = pending.get(payload.id);
      pending.delete(payload.id);
      if (payload.error) reject(new Error(`CDP ${payload.error.message}`));
      else resolve(payload.result);
      return;
    }
    if (payload.method === "Runtime.consoleAPICalled") {
      const text = (payload.params.args ?? [])
        .map((arg) => (arg.value !== undefined ? String(arg.value) : arg.description ?? arg.type))
        .join(" ");
      consoleLines.push({ level: payload.params.type, text });
    }
    if (payload.method === "Runtime.exceptionThrown") {
      const details = payload.params.exceptionDetails;
      pageErrors.push(details.exception?.description ?? details.text ?? "unknown");
    }
  });

  function send(method, params = {}) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error(`CDP 超时：${method}`));
        }
      }, 20000);
    });
  }

  await send("Runtime.enable");
  await send("Page.enable");

  /** 在页面里求值；异常会带着页面里的堆栈抛回来，不吞。 */
  async function evaluate(expression) {
    const result = await send("Runtime.evaluate", {
      expression: `(async () => { ${expression} })()`,
      awaitPromise: true,
      returnByValue: true
    });
    if (result.exceptionDetails) {
      throw new Error(`页面求值失败：${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`);
    }
    return result.result.value;
  }

  /** 真实鼠标按下-抬起（会走完整的事件序列，包括 click）。 */
  async function clickAt(x, y) {
    const common = { x, y, button: "left", clickCount: 1, buttons: 1 };
    await send("Input.dispatchMouseEvent", { type: "mousePressed", ...common });
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", ...common, buttons: 0 });
  }

  /** 真实拖拽选择：按下 → 分步移动 → 抬起，段落级选区才稳。 */
  async function dragSelect(from, to) {
    await send("Input.dispatchMouseEvent", { type: "mousePressed", x: from.x, y: from.y, button: "left", clickCount: 1, buttons: 1 });
    const steps = 8;
    for (let index = 1; index <= steps; index += 1) {
      await send("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: Math.round(from.x + ((to.x - from.x) * index) / steps),
        y: Math.round(from.y + ((to.y - from.y) * index) / steps),
        button: "left",
        buttons: 1
      });
    }
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: to.x, y: to.y, button: "left", clickCount: 1, buttons: 0 });
  }

  const images = [];
  async function screenshot(name) {
    const shot = await send("Page.captureScreenshot", { format: "png" });
    images.push({ name, base64: shot.data });
    return shot.data;
  }

  return {
    send,
    evaluate,
    clickAt,
    dragSelect,
    screenshot,
    images,
    consoleLines,
    pageErrors,
    sleep,
    close: () => socket.close()
  };
}
