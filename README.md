# dsh-selection-ask · 划词提问

**简体中文** | [English](README.en.md)

> 给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）网页版用的**划词引用**插件：
> 在对话里**选中任意一段文字**，光标旁浮出一个小条，点一下 ——
> 这段话就以引用块的形状落进输入框，光标停在后面，你接着写问题。

![选中文字后浮出的小条](docs/images/toolbar-light.png)

![引用落进输入框](docs/images/quoted-light.png)

深色宿主下同一套控件（配色走宿主 design token，插件不自己判主题）：

![深色主题](docs/images/toolbar-dark.png)

---

## 它解决什么

读 AI 的长回答时，你经常想指着其中**某一句话**追问：

> "这里为什么这么写？" / "展开讲讲第三点" / "这句翻译成中文是什么？"

没有这个插件，你得手动选中 → Ctrl+C → 点输入框 → Ctrl+V → 再打字，
而且粘进去的是一段**没有形状**的裸文本，模型分不清哪句是你说的、哪句是你引的。

有了它，引用是一步动作，而且**结构是明确的**：

```markdown
> 一句话对照：上面那串"往下压"是递，撞到出口后"往回收"是归——两个动作合起来才叫递归。

（这里接着写你的问题，光标已经在这了）
```

引用块是 markdown 原生语法，模型一眼能分清"这是你引的"和"这是你问的"。
**连续引用多段也可以** —— 每段各成一块，中间只隔一个空行。

---

## 安装

```bash
# 从 GitHub 装（仓库自带构建好的 lib/client.js，装完即可用，不需要自己构建）
dsh plugin --profile desktop add github:Eos010/dsh-selection-ask

# 从本地工作副本装（改完源码用这条）
dsh plugin --profile desktop add file:D:\Work\dsh-selection-ask
```

> `--profile` 后面填你实际在用的 profile 名（桌面版是 `desktop`，命令行 `dsh web` 是 `web`）。

**装完要重启一次 DSH**，然后刷新网页（`Ctrl+F5`）。

为什么必须重启这一次：`dsh plugin add` 会把本包登记进 profile 的 `dsh.profile.bundles`，
而那个清单**只在启动时读一次**。重启之后就进入热更新状态了 —— 改 `lib/client.js` 会在
约 500ms 内自动换进正在运行的页面，不用再重启、也不用刷新（见下面「开发」一节）。

卸载：

```bash
dsh plugin --profile desktop remove dsh-selection-ask
```

（若 profile 的 `package.json` 里 `dsh.profile.bundles` 还留着 `dsh-selection-ask` 那一行，一并删掉，再重启。）

---

## 用法

1. 在网页里**选中一段文字** —— AI 的回答、你自己发过的话、工具输出、代码块、文件预览，哪都行；
2. 光标旁浮出小条，点 **「引用到对话」**；
3. 那段话变成引用块落进输入框，**光标已经在引用块后面**，直接写问题就行。

浮层上的交互细节：

| 动作 | 结果 |
|---|---|
| 点别处 / 按 `Esc` | 浮层消失（不动输入框） |
| 在**输入框里**选中文字 | **不出**浮层 —— 那是在编辑，不是在引用 |
| 选中的内容超过 8000 字 | 截断，并提示「内容过长，已截断」 |
| 连点两次不同段落 | 两块引用追加，不会互相覆盖 |

---

## 边界（说清楚，免得踩空）

- **不管侧边对话**。这个版本只做"把选中的文本引用进输入框"。
  "在侧边对话中提问"（选中一段 → 在一个独立面板里就地问，不打断主对话）
  是另一件事，需要宿主半边去调模型 —— 见下面「路线」。
- **不碰你的输入框之外的东西**。它只调用 DSH 自己公开的 `inputActions.setDraft()`，
  所以草稿的撤销历史、附件、命令模式全都照旧。
- **不做摘要、不改写**。引用进去的就是你选中的原文，一个字不多一个字不少
  （只统一换行符、去掉末尾空行）。
- **不联网**。没有遥测、没有外部请求，一个字节都不发出去。

---

## 怎么实现的

### 两半结构

```
index.mjs          宿主半边：一个空函数 apply() {}
lib/client.js      浏览器半边：全部功能（构建产物，已提交）
client.js          浏览器半边的源码
selection-ask.css  全部样式
build.mjs          client.js + CSS → lib/client.js
```

宿主半边是**故意的空实现**。这一点值得解释：DSH 的"插件"是宿主 Cordis 树上的一个 entry，
客户端半边是通过 `package.json` 里的 `dsh.client` 声明被宿主扫到、再作为浏览器 bundle 发出去的 ——
那条链路的前提是这个包**已经作为一个 entry 存在于插件树里**。所以纯 UI 插件也必须有一个
node 半边，哪怕它是空的（DSH 官方的 `dsh-client-ui-reference` 也是 `function apply() {}`）。

因为宿主半边什么都不做，所以它 `inject` 里**一个服务都不声明**。这是刻意的：
声明一个拿不到的服务会让 fiber 停在 PENDING，启动器的 `assertEntriesActivated` 会因此
**丢掉整棵插件树** —— 一个插件的笔误能让 DSH 起不来。少声明一个，就少一条把宿主搞挂的路。

### 为什么挂在 `conversation.input.right` 这个插槽上

要把字写进输入框，只有一条正路：DSH 公开的 `inputActions.setDraft()`。
它不会发给任意插件 —— 它作为**会话作用域插槽的标准属性**，只发给插槽组件。

所以本插件在输入框工具行里占一格（`conversation.input.right`）。那一格本身只画一个
`display:none` 的锚点，看不见也点不到；它存在的意义是两件事：

1. 拿到 `inputActions` 和 `useInput`（草稿读改）；
2. 用锚点**反查输入框编辑器** —— 从锚点往上走，第一个包含 `contenteditable` 的祖先
   就是输入框卡片。**不写死任何宿主类名**，宿主改样式表也不会让它失效。

### 为什么浮层走 portal

浮层不能就地渲染在插槽里：工具行那一层可能有 `overflow` / `transform` / flex 约束，
就地渲染一个 `position: fixed` 元素会被这些约束吃掉，看起来"贴"在工具行上而不是选区旁。
所以真正的浮层用 `ReactDOM.createPortal` 挂到 `document.body` 下的宿主 div 上，
DOM 真在 body 上，定位与选区一一对应。

> ⚠️ 这里有一个**踩过的坑**，写在 `selection-ask.css` 的注释里：
> portal 宿主设了 `pointer-events: none`（让那一层对页面透明），而 `pointer-events`
> 是**继承属性** —— 浮层不把 `auto` 设回来，它自己也会变成"点击穿透"。
> 症状极具欺骗性：浮层**画得出来、位置也对**，但鼠标事件全落到下方正文上，
> 于是"点到别处就收起"先把浮层收掉，click 永远到不了按钮，
> 表现为**点了没反应、浮层自己消失**。这个 bug 只有真浏览器里点一下才抓得到。

### 什么时候**不**出浮层

- 选区落在可编辑区（含输入框自己）、`input` / `textarea` / `select` 里 —— 那是在编辑；
- 选区落在我们自己画的浮层里 —— 避免自引用套娃；
- **页面上有模态对话框开着** —— 模态框走浏览器的 top layer，盖在所有 z-index 之上，
  浮层无论 z-index 写多大都会被压住。让它出现就只是"看得见、点不着"，比不出现更糟。
  （这条是 2026-10-11 端到端验收时被应用的「内测声明」首启弹窗逼出来的。）

---

## 开发

只需要 Node ≥ 22。运行时零依赖 —— React / react-dom 从 DSH 的**平台模块表**里取
（`require("react")`），不打包、不重复引入第二份 React。

```bash
node build.mjs                       # client.js + selection-ask.css → lib/client.js
node test/bundle.test.mjs            # 产物接线：loader 声明、插槽注册、样式落点、失败不抛
node test/selection.test.mjs         # 纯逻辑：引用块形状、草稿拼接、浮层落位、排除规则
```

`lib/client.js` **是提交进仓库的构建产物**：装插件的人不该被迫先跑一次构建。
`build.mjs` 同时是一道闸门 —— 它会把产物反过来校验一遍（占位符恰好出现一次、
内嵌 CSS 与 `.css` 文件逐字节一致、构建期间源码未被改写），任何"改了源码忘了重新构建"
都会当场报错。

### 端到端验收（真浏览器）

单元测试碰不到 DOM 与真实鼠标事件，所以另有一套 CDP 驱动的验收：它派发**真实**的
鼠标事件序列，读**真实**的 DOM 来判定。

```bash
# 1) 起一个独立的测试实例（不要拿你正在用的那个）
dsh web --port 3099 --no-open

# 2) 起一个开了远程调试的 Chrome，打开实例打印出来的那个带 token 的 URL
chrome --headless=new --remote-debugging-port=9223 \
       --user-data-dir=<临时目录> "http://127.0.0.1:3099/?token=…"

# 3) 跑验收（需要在页面上打开一个**有内容**的会话）
node test/e2e/selection-ask.e2e.mjs --cdp-port 9223 --app-url http://127.0.0.1:3099

# 顺带产出 README 用的截图
node test/e2e/selection-ask.e2e.mjs --cdp-port 9223 --app-url http://127.0.0.1:3099 \
     --shots docs/images --theme dark
```

它会检查 18 件事，包括几条只有真浏览器能验的：浮层中心点**命中自己**（没被别的层盖住）、
`pointer-events` **没有被继承成穿透**、引用块内容**等于选中的那段文字**、
连续两次引用是**追加**而不是覆盖。

### 免重启的开发装法

如果你在改这个插件本身，可以不重启 DSH：profile 的 `cordis.patch.yml` 是**被实时监视**的
（`patchReload: live`），把插件挂进去只要两步 ——

```powershell
# 1) 把包挂进 profile 的 node_modules（目录联接，改工作区源码就是改运行中的那份）
New-Item -ItemType Junction -Path "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-selection-ask" `
         -Target "D:\Work\dsh-selection-ask"

# 2) 往 profile 的 cordis.patch.yml 末尾追加：
#    - insert:
#        - id: selection-ask
#          name: dsh-selection-ask
```

改完 `client.js` 跑一次 `node build.mjs`，约 500ms 后浏览器里的插件就换成了新版本
（`dsh-client-hmr` 每 500ms 轮询 bundle 的 mtime/size）。

---

## 数据与隐私

- **不联网**：没有遥测、没有统计上报、不请求任何外部地址。
- **不读文件、不读凭据、不读会话内容**：它只做三件事 —— 读当前选区、
  调用宿主公开的 `inputActions.setDraft()`、往 `document.body` 挂一个浮层。
- 没有配置项，也就没有配置文件。

---

## 路线

- **下一步**：Trae 那个功能的另一半 —— **「在侧边对话中提问」**：选中一段文字，
  在右侧栏开一个独立小对话就地提问，答案不落进主对话。
  它需要一个宿主半边把问题转给 `ctx.llm.stream()` 并流式推回浏览器
  （浏览器端拿不到模型：DSH 只把 `llm/listProviders` 这类元数据暴露给前端，
  没有流式对话的 remote）。**注意它的能力边界**：那样的侧边对话只带
  "你选中的这段 + 你问的话"，没有工具、读不了文件、看不到主对话 ——
  它的价值就是"就地一问、不打断主线"。
- 引用块可带**来源标注**（摘自哪条消息 / 哪个文件第几行）。
- 快捷键（选中后直接按键引用，不经过浮层）。

---

## 许可

MIT。见 [LICENSE](LICENSE)。
