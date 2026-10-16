# dsh-selection-ask · select-to-quote

[简体中文](README.md) | **English**

> A **select-to-quote** plugin for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
> web GUI. Select a passage in the conversation, annotate it in place, and it lands in the
> composer as a **numbered quote chip** — while the original text keeps a **highlight** and its
> **number**. Delete the chip and both go away with it.

**Version V0.1**

<!-- Screenshots: one of the in-place bar right after selecting, one of the highlight and
     number left on the original text. -->

---

## What it does

Reading a long answer, you constantly want to point at **one specific sentence**:
"Why is it written this way?" / "Expand on the third point." Without this plugin that means
select → `Ctrl+C` → click the composer → `Ctrl+V` → then start typing — and what you paste is
shapeless raw text, so the model cannot tell which words are yours and which are quoted.

With it:

- **Quote in one action** — select anything (an assistant answer, something you wrote, tool
  output, a code block); a small in-place bar appears next to the caret. Type a note, or just
  press Enter.
- **Every quote has an identity** — a number (`Selection 1`, `2`, `3`, …), a matching
  **highlight** and **number badge** on the original text, and a hover preview showing the
  quoted passage again.
- **The chip drives the highlight** — the chip in the composer is the single source of truth:
  delete it and the highlight and badge disappear together. No orphan annotations.
- **Inserted at the composer caret** — new quotes land where your caret is; consecutive quotes
  line up one after another and **never overwrite** what you already wrote.
- **One annotation, one number** — quoting the same passage again reuses its number.
- **A longer selection absorbs a shorter quote** — if you first quote a short passage and then
  quote a longer one that contains it, no extra chip appears; the existing quote is updated to
  the longer text.
- **Write, then send when you want** — `Enter` writes into the composer (keep editing);
  `Ctrl`/`Cmd + Enter` writes it **and sends immediately**.
- **Follows the theme** — colors come from the host's design tokens, light and dark alike.

The composer holds a numbered chip; the model still receives a clean Markdown blockquote:

```markdown
> A one-line contrast: pushing down is the "recurse", unwinding after hitting the
> base case is the "return" — only both together is recursion.

(your question goes here — the caret is already here)
```

---

## Usage

1. **Select a passage** in the page;
2. a small in-place bar appears next to the caret — type a note, or don't;
3. `Enter` writes it into the composer / `Ctrl` (`Cmd` on macOS) `+ Enter` writes it **and sends
   it immediately**.

| Action | Result |
|---|---|
| Select body text | The in-place bar appears; the tint on that passage **does not disappear** |
| `Enter` in the bar | Writes into the composer, **does not send** — you can keep editing |
| `Ctrl/Cmd + Enter` in the bar | Writes into the composer **and sends at once** |
| Commit with a note | The composer gets `[chip] your note` |
| Hover a chip | The quoted passage pops up |
| **Delete the chip in the composer** | The highlight **and** the badge on the original text go away |
| Click elsewhere / `Esc` | The bar closes; the composer is untouched |
| Select text **inside the composer** | No bar — that is editing, not quoting |
| Quote several passages in a row | Inserted at the caret, appended, never overwritten |
| Selection longer than 8000 characters | Truncated, with a "Selection truncated" notice |

**Numbering**: globally increasing for the page's lifetime (`Selection 1`, `2`, `3`, …).
Quoting the same passage again **reuses its number** — one annotation should not get two badges.

---

## Install

⚠️ First, a correction (many plugin docs get this wrong): **the DSH CLI rejects
`--profile desktop` outright** —

```
$ dsh plugin --profile desktop add github:Eos010/dsh-selection-ask
error: profile "desktop" is managed exclusively by the Electron application
```

The desktop profile is managed exclusively by the Electron app. So pick the one you actually use:

### Desktop app (Electron)

Install from inside DSH. Or do it manually in two steps:

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

(To install from a local working copy, replace `github:…` with `file:<your working copy path>`.)

**Both routes need one DSH restart**, then refresh the page (`Ctrl+F5`) — the bundle list is
read only at startup.

To uninstall, do the reverse: drop the line from `dsh.profile.bundles`, delete the directory
under `node_modules`, restart.

---

## Notes and limitations

- Highlights need Chromium 105+ (both the DSH desktop app and `dsh web` are Chromium; verified
  working).
- In a very long transcript, the part **scrolled out of view is not highlighted**; it comes back
  when you scroll back.
- **The "ask aside" panel is still being finished**: its button is in place, but it cannot send
  a question yet — don't rely on it.
- After updating the plugin or changing configuration, **refresh the page** (`Ctrl+F5`).
- The plugin does not go online and reads no files or credentials. If you use "ask aside", it
  calls **your own configured** model — meaning it spends your quota.

---

## Development

Node ≥ 22 only; zero runtime dependencies.

```bash
node build.mjs                # sources + styles → lib/client.js (committed; installing needs no build)
node test/bundle.test.mjs     # artifact wiring, slot registration, styles
node test/selection.test.mjs  # blockquote shape, draft merging, lifecycle, numbering
```

---

## License

MIT. See [LICENSE](LICENSE).
