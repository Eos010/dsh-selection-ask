/**
 * dsh-selection-ask — 宿主半边
 *
 * 它只干一件事：把「侧边提问」面板发来的问题转给 DSH 已经配好的模型，
 * 再把回答**流式**吐回浏览器。
 *
 * 为什么这件事必须由宿主做：浏览器端调不了模型。DSH 只把
 * `llm/listProviders`、`llm/discoverModels` 这类**元数据** remote 暴露给前端，
 * 没有流式对话的 remote（见 `@deepseek-ai/dsh-llm/lib/typert.remote-client.d.ts`）。
 *
 * ⚠️ 三条硬约束：
 *  1. **`apply` 不许抛** —— 同步抛错会让这个 entry 加载失败，整个插件（包括
 *     已经能用的划词引用）一起消失。
 *  2. **`inject` 只声明确定存在的服务**。声明一个拿不到的服务，fiber 会停在
 *     PENDING，启动器会因此丢掉整棵插件树。所以这里只声明 `webServer`，
 *     `llm` / `agentDefaultModel` 一律**用的时候再 `ctx.get()`**。
 *  3. **不 import DSH 内部包**。第三方插件目录解析不到 `@deepseek-ai/*`
 *     （实测 MODULE_NOT_FOUND），所以 message 对象手搓 —— 幸运的是 brand
 *     只是编译期标记（`brandString` 是恒等函数），运行时就是普通对象。
 *
 * 隐私：本插件不读凭据、不落盘、不发起外部请求；它只调用 DSH 自己配置好的
 * 模型路由，模型调用与主对话走的是同一条路。
 */
import { randomUUID } from "node:crypto";

const PACKAGE_ID = "dsh-selection-ask";
const ENDPOINT = "/plugins/dsh-selection-ask/ask";

/** 请求体上限：引用一段长文 + 若干轮问答，128KB 足够，再多就拒。 */
const MAX_BODY_BYTES = 128 * 1024;
/** 一次请求最多带多少轮消息（一问一答算两轮）。 */
const MAX_MESSAGES = 24;
/** 单条消息上限，防止把整篇文档灌进来。 */
const MAX_TEXT_CHARS = 16000;
/** 一次回答的总时长上限；到点就断开并告知，而不是挂死在那里。 */
const TIMEOUT_MS = 180_000;

const SYSTEM = {
  zh: "你在 DeepSeek Harness 网页版的「侧边提问」面板里回答用户的问题。"
    + "用户会引用一段他正在读的文本，然后就这段文本提问。"
    + "只回答被问到的东西：不要客套、不要复述引用的原文、不要重复问题。"
    + "如果引用内容不足以回答，直接说缺什么。",
  en: "You answer questions in the \"Ask aside\" panel of the DeepSeek Harness web GUI. "
    + "The user quotes a passage they are reading and asks about it. "
    + "Answer only what is asked: no pleasantries, do not restate the quoted passage, do not repeat the question. "
    + "If the quote is not enough to answer, say exactly what is missing."
};

/** 宿主侧需要的服务：只有挂路由用的 webServer。 */
export const inject = ["webServer"];

/* ───────────────────────── 小工具（全部 fail-open） ───────────────────────── */

/** 读请求体；超限返回 null（而不是把大 body 收完再拒）。 */
function readBody(request) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        finish(null);
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => finish(Buffer.concat(chunks).toString("utf8")));
    request.on("error", () => finish(null));
  });
}

/**
 * 手搓一个 DSH 自己的 message 对象。
 *
 * 形状照抄 `@deepseek-ai/dsh-llm` 的 `createUserMessage` / `createAssistantMessage`：
 * 运行时 field 就是 `{ id, role, content, source }`，`id` 只是普通字符串
 * （`brandString` 是恒等函数），`content` 是 `[{ type: 'text', text }]`。
 *
 * @param {'user'|'assistant'} role
 * @param {string} text
 * @param {{provider: string, model: string}} route 助手消息要带上来源，用户消息不用
 */
function buildMessage(role, text, route) {
  if (role === "assistant") {
    return {
      id: randomUUID(),
      role: "assistant",
      content: [{ type: "text", text }],
      source: { kind: "model", provider: route.provider, model: route.model }
    };
  }
  return {
    id: randomUUID(),
    role: "user",
    content: [{ type: "text", text }],
    // `kind: 'plugin'` 是诚实的：这条消息由插件转交，不是用户在 DSH 里敲的。
    source: { kind: "plugin", plugin: PACKAGE_ID }
  };
}

/**
 * 这个请求是不是"我们自己页面"发出来的。
 *
 * ⚠️ 为什么必须有这道门：DSH 的 cookie 鉴权只保护**没被命名路由接管的**请求。
 * 一旦插件注册了 `exact` 路由（本插件这个端点就是），请求就不再经过那道鉴权 ——
 * 也就是说，**任何人只要能连到本机端口就能调它**。而"能连到 127.0.0.1"这件事
 * 在浏览器里是默认成立的：用户随便打开一个恶意网页，那个页面就能 POST 过来，
 * 用用户的 API 额度跑模型。所以这里自己把关，两条：
 *
 *  1. **Host 必须是 IP 字面量或 localhost** —— 挡 DNS rebinding
 *     （攻击者把自己的域名解析到 127.0.0.1，此时 Host 是域名、Origin 也"同源"，
 *      只比对 Origin 是挡不住的）。局域网 IP 访问是允许的。
 *  2. **带了 Origin 就必须与 Host 同源** —— 挡普通跨站请求。
 *     非浏览器客户端（curl、我们的验收脚本）不带 Origin，放行。
 *
 * @param {import('node:http').IncomingMessage} request
 * @returns {boolean}
 */
function isTrustedCaller(request) {
  const headers = request.headers || {};
  const host = typeof headers.host === "string" ? headers.host : "";
  const hostname = host.replace(/:\d+$/, "").replace(/^\[|\]$/g, "").toLowerCase();
  const isIpLiteral = /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname);
  const isLocalName = hostname === "localhost" || hostname === "::1";
  if (hostname !== "" && !isIpLiteral && !isLocalName) return false;

  const origin = typeof headers.origin === "string" ? headers.origin : "";
  if (origin !== "") {
    try {
      if (new URL(origin).host !== host) return false;
    } catch {
      return false;
    }
  }
  return true;
}

/** 校验并规整客户端发来的消息数组；不合法返回 null。 */
function normalizeMessages(raw) {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_MESSAGES) return null;
  const out = [];
  for (const item of raw) {
    if (item === null || typeof item !== "object") return null;
    const role = item.role === "assistant" ? "assistant" : item.role === "user" ? "user" : null;
    if (role === null) return null;
    const text = typeof item.text === "string" ? item.text : null;
    if (text === null || text.trim() === "" || text.length > MAX_TEXT_CHARS) return null;
    // 第一条必须是用户消息，否则模型会收到一个没有来由的助手开场
    if (out.length === 0 && role !== "user") return null;
    out.push({ role, text });
  }
  return out;
}

/**
 * 解析这次调用走哪条模型路由。
 *
 * 顺序：用户当前的默认模型选择（GUI 里那个模型选择器写的就是它）→
 * 第一个已注册的 provider（`listProviders` 不带模型表，所以要再走一次
 * 目录解析）。
 *
 * @returns {{provider: string, model: string, reasoningEffort?: string}|null}
 */
async function resolveRoute(ctx) {
  try {
    const selection = ctx.get("agentDefaultModel");
    if (selection && typeof selection.currentSelection === "function") {
      const picked = selection.currentSelection();
      if (picked && typeof picked.provider === "string" && typeof picked.model === "string") {
        return {
          provider: picked.provider,
          model: picked.model,
          ...(typeof picked.reasoningEffort === "string" ? { reasoningEffort: picked.reasoningEffort } : {})
        };
      }
    }
  } catch {
    /* 没配就用下面的兜底 */
  }
  try {
    const llm = ctx.get("llm");
    if (!llm) return null;
    const providers = llm.listProviders();
    const first = Array.isArray(providers) ? providers[0] : null;
    if (!first || typeof first.id !== "string") return null;
    // provider 信息不含模型表，用目录解析问一次这个 route 有哪些模型
    if (typeof llm.resolveModel === "function") {
      const resolved = await llm.resolveModel(first.id, undefined);
      const model = resolved && typeof resolved.id === "string" ? resolved.id : null;
      if (model !== null) return { provider: first.id, model };
    }
    return null;
  } catch {
    return null;
  }
}

/* ───────────────────────── 端点 ───────────────────────── */

/**
 * 宿主插件体。
 * @param {object} ctx - 宿主 Cordis 上下文
 */
export function apply(ctx) {
  ctx.effect(() => ctx.webServer.register({
    kind: "exact",
    path: ENDPOINT,
    handler: async (request, response) => {
      const json = (status, payload) => {
        try {
          response.writeHead(status, {
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff"
          });
          response.end(JSON.stringify(payload));
        } catch {
          /* 头已经发出去了 */
        }
      };

      if (request.method !== "POST") {
        json(405, { error: "method-not-allowed" });
        return;
      }

      if (!isTrustedCaller(request)) {
        json(403, { error: "untrusted-caller" });
        return;
      }

      const raw = await readBody(request);
      if (raw === null) {
        json(413, { error: "body-too-large" });
        return;
      }

      let body;
      try {
        body = JSON.parse(raw);
      } catch {
        json(400, { error: "invalid-json" });
        return;
      }

      const messages = normalizeMessages(body && body.messages);
      if (messages === null) {
        json(400, { error: "invalid-messages" });
        return;
      }

      const llm = ctx.get("llm");
      if (!llm || typeof llm.stream !== "function") {
        json(503, { error: "llm-unavailable" });
        return;
      }

      const route = await resolveRoute(ctx);
      if (route === null) {
        json(503, { error: "no-model-route" });
        return;
      }

      const lang = body && body.lang === "en" ? "en" : "zh";
      const wire = messages.map((item) => buildMessage(item.role, item.text, route));

      /* ── 从这里开始是 SSE ── */
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
      const cleanup = () => {
        clearTimeout(timer);
        controller.abort();
      };
      request.on("close", cleanup);
      request.on("error", cleanup);

      try {
        response.writeHead(200, {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-store, no-transform",
          Connection: "keep-alive",
          "X-Content-Type-Options": "nosniff",
          // 反向代理层别缓冲，否则"流式"会变成"一次性"
          "X-Accel-Buffering": "no"
        });
      } catch {
        cleanup();
        return;
      }

      const send = (payload) => {
        try {
          response.write(`data: ${JSON.stringify(payload)}\n\n`);
        } catch {
          /* 客户端断了 */
        }
      };

      send({ type: "start", provider: route.provider, model: route.model });

      try {
        for await (const chunk of llm.stream({
          provider: route.provider,
          model: route.model,
          ...(route.reasoningEffort === undefined ? {} : { reasoningEffort: route.reasoningEffort }),
          messages: wire,
          system: SYSTEM[lang]
        })) {
          if (controller.signal.aborted) break;
          if (chunk && chunk.type === "text-delta" && typeof chunk.text === "string") {
            send({ type: "delta", text: chunk.text });
          } else if (chunk && chunk.type === "finish") {
            // ⚠️ finish 帧的字段是 `reason`（不是 `kind`）——见 dsh-llm 的 BlockAssembler：
            //    `case "finish": this._finish = chunk.reason`。
            const reason = chunk.reason;
            send({
              type: "done",
              finish: reason && reason.kind !== undefined ? String(reason.kind) : "unknown",
              failure: reason && reason.failure && reason.failure.code !== undefined
                ? String(reason.failure.code)
                : null
            });
          }
        }
      } catch (error) {
        // 失败必须**明说**：面板上要能看见，而不是转圈到天荒地老
        send({
          type: "error",
          code: error && error.code ? String(error.code) : "stream-failed",
          message: String(error && error.message ? error.message : error)
        });
      } finally {
        cleanup();
        try {
          response.end();
        } catch {
          /* 已经结束 */
        }
      }
    }
  }), `${PACKAGE_ID}: ask endpoint`);
}

/** 端点路径导出给测试用；运行期不需要。 */
export const ENDPOINT_PATH = ENDPOINT;
