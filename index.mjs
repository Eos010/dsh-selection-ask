/**
 * dsh-selection-ask — 宿主半边
 *
 * 这个插件**没有宿主行为**：它整件事都发生在浏览器里。
 *
 * 那为什么还要有这个文件？因为「插件」是宿主 Cordis 树上的一个 entry，
 * 加载的是这个包的 `main`。客户端半边（`lib/client.js`）是通过 package.json
 * 里的 `dsh.client` 声明被宿主扫到、再作为浏览器 bundle 发出去的，
 * 那条链路的前提是这个包**已经作为一个 entry 存在于插件树里**。
 *
 * 官方自己的纯 UI 插件也是这么做的（见 `@deepseek-ai/dsh-client-ui-reference`
 * 的 node 半边：`function apply() {}`，一个空函数）。
 *
 * ⚠️ 两条硬约束，都来自真实事故形状：
 *  1. **`apply` 不许抛**。同步抛错会让这个 entry 加载失败。
 *  2. **不要声明拿不到的服务**。`inject` 里写一个从未被 provide 的服务，
 *     fiber 会停在 PENDING，启动器的 `assertEntriesActivated` 会因此
 *     **丢掉整棵插件树** —— 也就是说，一个插件的笔误能让 DSH 起不来。
 *     所以这里 `inject` 直接省略（本插件没有任何宿主侧依赖）。
 *
 * 这份克制是有意的：一个"把选中文本写进输入框"的插件，不该开端口、
 * 不该读文件、不该碰凭据。它需要什么，全都在浏览器里拿得到。
 */

/** 宿主插件体 —— 本插件在宿主侧没有行为。 */
export function apply() {}
