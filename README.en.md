# dsh-selection-ask

[简体中文](README.md) | **English**

> A **select-to-quote** plugin for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) web GUI.
> Select a passage in the conversation → annotate it in place → it lands in the composer as a
> **numbered quote chip**, while the original text keeps a **highlight and its number**.
> Delete the chip and both go away with it.

Right after selecting (that tint is the plugin's own highlight, not the browser's native selection):

![The in-place note bar](docs/images/pending-light.png)

After committing (highlight + number badge on the original text, chip in the composer):

![The annotation on the original text](docs/images/annotated-light.png)

The same controls on a dark host (colors come from the host's design tokens — the plugin
never guesses the theme):

![Dark theme](docs/images/annotated-dark.png)

---

## Why

Reading a long answer, you constantly want to point at **one specific sentence**:

> "Why is it written this way?" / "Expand on the third point."

Without this plugin that is: select → Ctrl+C → click the composer → Ctrl+V → then start
typing. And what you paste is shapeless raw text — the model cannot tell which words are
yours and which are quoted.

With it, quoting is one action and **every quote has an identity**: each one is numbered, the
original text carries a matching highlight and badge, and hovering the chip shows the quoted
passage again. The model still receives a plain Markdown blockquote:

```markdown
> A one-line contrast: pushing down is the "recurse", unwinding after hitting the
> base case is the "return" — only both together is recursion.

(your question goes here — the caret is already here)
```

---

## The lifecycle of one quote

**The single source of truth is the chip in the composer.** One state decides, so three
places can never disagree:

```
chip present    →   highlight on the original text, number badge present
chip deleted    →   highlight gone, badge gone
not committed   →   the selection is taken over by the plugin's highlight
                    (you never watch your own selection vanish)
```

That is why deleting a chip in the composer also removes the highlight and badge on the
original passage: they are not three independent records, they are three renderings of the
same fact.

---

## Usage

1. **Select a passage** — an assistant answer, something you wrote, tool output, a code
   block, anywhere;
2. a small in-place bar appears next to the caret (type a note, or don't);
3. `Enter` writes it into the composer / `Ctrl` (`Cmd` on macOS) `+ Enter` writes it **and
   sends it immediately**.

| Action | Result |
|---|---|
| Select body text | The in-place bar appears; the tint on that passage **does not disappear** (it switches to the plugin's highlight) |
| `Enter` in the bar | Writes into the composer, **does not send** — you can keep editing |
| `Ctrl/Cmd + Enter` in the bar | Writes into the composer **and sends at once** |
| Commit with a note | The composer gets `[chip] your note` (chip first) |
| Hover a chip | The quoted passage pops up |
| **Delete the chip in the composer** | The highlight **and** the badge on the original text go away |
| Click elsewhere / `Esc` | The bar closes; the composer is untouched |
| Select text **inside the composer** | No bar — that is editing, not quoting |
| Quote several passages in a row | Appended, never overwritten |
| Selection longer than 8000 characters | Truncated, with a "Selection truncated" notice |

**Numbering**: globally increasing for the page's lifetime (`Selection 1`, `2`, `3`, …).
Quoting the same passage again **reuses its number** — one annotation should not get two
badges.

---

## Known boundaries (stated, not hidden)

1. **When the same text appears several times in the transcript, the highlight takes the
   first occurrence.** Anchoring works by *finding the text again* (never by character
   offsets — the transcript is re-rendered by React and offsets always drift).
2. **A quoted passage must live inside a single text node** (a selection spanning elements
   cannot be anchored).
3. **When the transcript virtualizes, the part scrolled out of view is not highlighted**;
   it comes back when you scroll back. That is a boundary of this anchoring approach, not a
   bug.
4. **Highlights need the browser's CSS Custom Highlight API** (Chromium 105+; both the DSH
   desktop app and `dsh web` are Chromium, verified working). Without it the highlight and
   badge are **silently absent**, quoting itself keeps working, and one warning is logged.
5. **⚠ "Ask aside" is unfinished and sealed.** The button opens the right sidebar panel and
   carries the selected passage into it, **but the panel's Send button never receives real
   mouse clicks** (root cause identified: `pointerdown` is `preventDefault`ed inside the
   panel and the `click` is stopped before it bubbles to React's root container; the fix is
   written up in the project notes). So **it cannot send a question today** — don't rely on
   it.
6. **Hot reload is unreliable.** After rebuilding, **refresh the page** (`Ctrl+F5`) — HMR
   proved unstable on this machine (the page holds a stale combo `rev` and the bundle 404s).

---

## Install

⚠️ First, a correction (many plugin docs get this wrong): **the DSH CLI rejects
`--profile desktop` outright** —

```
$ dsh plugin --profile desktop add github:Eos010/dsh-selection-ask
error: profile "desktop" is managed exclusively by the Electron application
```

The desktop profile is managed exclusively by the Electron app. So pick the one you
actually use:

### Desktop app (Electron)

Install from inside DSH. Or do it manually in two steps (**this path is verified working**):

```powershell
# 1) put the repo into the profile's node_modules
git clone https://github.com/Eos010/dsh-selection-ask `
  "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-selection-ask"

# 2) add one line to the dsh.profile.bundles array in ~/.dsh/profiles/desktop/package.json:
#      "dsh-selection-ask"

# 3) restart DSH, then refresh the page (Ctrl+F5)
```

### CLI (`dsh web`)

```bash
npm i -g pnpm        # dsh plugin is a pnpm shim, pnpm must be on PATH
dsh plugin --profile web add github:Eos010/dsh-selection-ask
```

(To install from a local working copy, replace `github:…` with
`file:<your working copy path>`.)

**Both routes need one DSH restart**, then refresh the page (`Ctrl+F5`). The restart is
required because install registers the package in the profile's `dsh.profile.bundles`, and
that list is **read only at startup**.

To uninstall, do the reverse: drop the line from `dsh.profile.bundles`, delete the directory
under `node_modules`, restart.

---

## How it works

### Two halves

```
index.mjs          host half: one streaming Q&A endpoint (+ two safety gates)
client.js          browser half: all interaction (source)
ask-panel.js       browser half: the "ask aside" panel (source, concatenated into the same bundle)
selection-ask.css  all styles
build.mjs          ask-panel.js + client.js + CSS → lib/client.js (artifact is committed)
lib/client.js      the build artifact — this is what the host actually loads
```

The host half declares **no `inject` services at all**. That is deliberate: a DSH plugin is
an entry on the host's Cordis tree and the browser half is brought out by that entry, so even
a pure-UI plugin needs a node half — but **declaring a service you cannot get** leaves the
fiber in PENDING and the launcher's `assertEntriesActivated` then **drops the whole plugin
tree**. One less declaration is one less way to break the host.

### Why it hooks `conversation.input.right`

There is exactly one legitimate way to put text into the composer: DSH's public input
actions, and those are only handed to **session-scoped slot components**. So the plugin takes
one cell in the composer's tool row and renders nothing but a `display:none` anchor. That
anchor does three things: it obtains `inputActions` / `useInput`, it **reverse-looks-up the
composer editor** (walk up from the anchor to the first ancestor containing a
`contenteditable`), and it **counts how many chips are currently in the composer** — which is
the criterion for the lifecycle above. **No host class name is ever hard-coded.** The label
lookup is byte-for-byte identical to the one used by the hover preview; if the two criteria
drifted apart you would get "hover shows the passage, but the highlight logic says this chip
does not exist".

### The quote chip borrows DSH's own mechanism

DSH's composer is Lexical, and the atomic reference chip that `@file` / `@conversation`
insert is the same mechanism. The plugin registers its own reference source, whose
`codec.serialize(ref)` decides **what the quote expands to when sent** — so the chip is only
a different *visual form*; the model still receives `> the quoted text`.

Three hard-won facts (all recorded in full in the project notes):

- **`ctx.emit` has no return value — you must use `ctx.bail`.** The input machine's four
  events are declared `@mode bail`; judging success from `emit`'s return value means an
  insertion that *succeeded* is treated as failed, and the full-text-replacement fallback then
  wipes the chip you just inserted. The symptom is "the chip never appears".
- **`InputState.draft` is the clipboard projection, not edit coordinates.** A chip occupies
  almost nothing in edit coordinates and a whole passage in the projection. Using the length
  of one to index the other never lands where you want.
- **Never compute a single insertion offset — try candidates and let the return value pick.**
  The projection↔coordinate conversion **does not always line up**; when it doesn't, the only
  candidate is rejected and the second quote **fails silently** (the fallback then refuses to
  write because "a chip is already present", so the user just sees nothing happen). Hence a
  small-integer ladder (`chipCount+1 … 0`, descending) is appended whenever chips exist —
  measured: the append position always falls in that range.

### Highlights and numbering

- **Highlights use the browser's native CSS Custom Highlight API**
  (`CSS.highlights` + `Highlight`; measured colors: pending `rgb(212,212,213)`, annotated
  `rgb(193,193,194)` — the host brand token mixed at 18% / 26%). **Not one byte of DOM is
  touched**, so React re-renders cannot wash it away. (Inserting `<mark>` and re-attaching
  through a MutationObserver would fight React forever inside a streaming transcript.)
- **The number badge lives in our own overlay layer**, positioned from the Range rect and
  **never inserted into the prose**; if it cannot be placed, nothing happens and every
  exception is swallowed — **annotation must never take quoting down with it**.
- **The pending highlight is not optional.** The in-place bar autofocuses the moment it
  appears, and focusing an input makes the browser **drop the document selection on the
  spot** — so the native blue vanishes on mouse-up and it looks like "the selection
  disappeared". We therefore take that passage over with our own highlight: same family,
  one step lighter. Visually it **changes color** instead of disappearing. It uses a **live
  DOM Range** and only exists while the bar is open.

### When the bar does **not** appear

- The selection is inside an editable region (including the composer), or an
  `input` / `textarea` / `select` — that is editing;
- the selection is inside our own overlay — avoiding self-quoting;
- **a modal dialog is open** — modals live in the browser's top layer and cover every
  z-index, so showing the bar would only mean "visible but unclickable", which is worse than
  not showing it.

### While the primary button is held down, nothing happens (the drag lesson)

**Symptom**: you press and drag, and you simply cannot select text — it breaks immediately.
**Root cause**: the selection becomes non-empty, `selectionchange` fires, the bar pops up and
autofocuses its input — and focusing an input **ends the drag and clears the selection**.
**Why a fully green end-to-end suite never caught it**: `Input.dispatchMouseEvent` dispatches
a drag **in one instant**; the bar has no time to appear. **Real hands are slower than the
test, and being slow is what breaks it.** The fix is three parts: do nothing while the
primary button is down, never steal focus for keyboard-made selections, and never close the
bar for "empty selection" while focus is inside our own DOM. The instrument changed too: a
**24-step, one-frame-per-step slow drag** is now a permanent assertion.

---

## Development

Node ≥ 22 only. Zero runtime dependencies — React / react-dom come from DSH's **platform
module table** (`require("react")`), so no second copy gets bundled.

```bash
node build.mjs                       # sources + CSS → lib/client.js
node test/bundle.test.mjs            # 15 checks: artifact wiring, slot registration, styles, no throwing
node test/selection.test.mjs         # 36 checks: blockquote shape, draft merging, lifecycle, placement
```

`lib/client.js` **is a committed build artifact**: installing the plugin should not force
anyone to run a build first. `build.mjs` doubles as a gate — it validates the artifact in
reverse (the placeholder appears exactly once, the embedded CSS is byte-identical to the
`.css` file, sources did not change during the build), so "edited the source, forgot to
rebuild" fails loudly.

### End-to-end acceptance (real browser)

Unit tests cannot reach the DOM or real mouse events, so there is a second suite driven by
CDP: it dispatches **real** mouse event sequences and reads the **real** DOM and the **real
`CSS.highlights`** registry.

```bash
# 1) start a separate test instance (never the one you are using)
dsh web --port 3099 --no-open

# 2) start Chrome with remote debugging on the tokenized URL the instance printed
chrome --headless=new --remote-debugging-port=9223 \
       --user-data-dir=<temp dir> "http://127.0.0.1:3099/?token=…"

# 3) run the acceptance (the page must have a session with content)
node test/e2e/selection-ask.e2e.mjs --cdp-port 9223 --app-url http://127.0.0.1:3099

# also produces the README screenshots (run once per theme)
node test/e2e/selection-ask.e2e.mjs --cdp-port 9223 --app-url http://127.0.0.1:3099 \
     --shots docs/images --theme dark
```

**43 assertions**, several of which only a real browser can make:

- the bar's centre point **hits itself** via `elementFromPoint` (nothing covers it) and
  `pointer-events` **is not inherited into click-through**;
- the **24-step slow drag** shows no bar mid-drag and a non-zero selection, and the bar
  appears only after mouse-up;
- the **three real highlight states**: pending `size === 1` while selecting, 0 after commit
  with the annotation at 1, and **0 for both the annotation highlight and the badge once the
  chip is deleted**;
- **direct send**: after `Ctrl+Enter` the composer is empty and that message shows up in the
  transcript;
- **no uncaught exception during the whole run** — this one is the instrument's fuse: a
  `ReferenceError` thrown only inside an event callback leaves the page looking perfectly
  fine while one action is dead.

> ⚠️ **One E2E run does send a couple of very short real model requests** (to verify direct
> send and the "ask aside" path). It uses the model configured in your test instance — mind
> your quota.

### Installing into the running copy (no restart)

A profile's `cordis.patch.yml` is watched live (`patchReload: live`):

```powershell
# 1) link the package into the profile's node_modules (a junction: editing the working copy
#    edits the one that is running)
New-Item -ItemType Junction -Path "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-selection-ask" `
         -Target "<your working copy path>"

# 2) append to the profile's cordis.patch.yml:
#    - insert:
#        - id: selection-ask
#          name: dsh-selection-ask
```

After editing sources run `node build.mjs`, **then refresh the page** (`Ctrl+F5`).
(`dsh-client-hmr` polls the bundle's mtime/size every 500ms, but it proved unreliable here —
the page may hold a stale combo `rev` and the bundle 404s. **Refreshing is the reliable
path**, so no hot-reload promise is made.)

---

## Data and privacy

- **The browser half does not go online**: it reads no files, no credentials, no conversation
  content. It does three things — read the current selection, call the host's public input
  actions, and mount an overlay on `document.body`.
- **⚠ The host half exposes one HTTP endpoint**: `POST /plugins/dsh-selection-ask/ask`
  (used by "ask aside"). It forwards the question to **your configured** model and streams
  the answer back — meaning **it spends your quota**.
  DSH's cookie auth **only protects requests not claimed by a named route**, so the plugin
  adds two gates of its own: **Host must be an IP literal or localhost** (blocks DNS
  rebinding) and **any Origin present must be same-origin** (blocks cross-site). Measured:
  no Origin 200 / same-origin 200 / cross-site 403 / Host as a domain name 403.
- No configuration options, therefore no configuration file.

---

## Roadmap

- **Fix the Send button in the "ask aside" panel** (root cause identified — see boundary 5).
- Quotes could carry a **source label** (which message / which file and line).
- A shortcut to quote without going through the bar.
- The three highlight boundaries above are **not going to change**: "reliable and good
  enough" is what this anchoring approach was chosen for.

---

## License

MIT. See [LICENSE](LICENSE).
