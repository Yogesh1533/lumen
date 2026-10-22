# Lumen roadmap and handoff

Written so a fresh coding session can continue the project without the earlier conversation.
Repo: `Yogesh1533/lumen` (private). Local checkout: `~/lumen`. The user's own copy runs on port **3100**; tests use **3101**.

## 1. Status

Steps 1 to 7 are built, tested and merged (PRs #1 to #7):
attachments and vision, artifacts, projects, thinking and branching and auto titles, styles and memory,
MCP tools with approval, command palette and shortcuts and dictation and web tools and installable app.

Step 8 (quick wins) is built, tested and committed on branch `step-8-quickwins` (not merged yet):
token usage and a usage dialog, read aloud, find in conversation, Markdown export, chat tabs,
try another model and side-by-side compare, and a troubleshooting dialog with a diagnostic report.

**Next: steps 9 to 15 below.** The user asked for all of them to be run autonomously (build, test, merge, repeat).

## 2. Orientation

| File | Role |
|---|---|
| `server.js` | Zero-framework Node API: chats/projects/settings storage, request **guard**, Ollama proxy, MCP routes |
| `mcp.js` | MCP client manager (stdio + Streamable HTTP) on `@modelcontextprotocol/sdk` |
| `webtools.js` | Built-in `fetch_page` / `web_search` with SSRF protection |
| `public/app.js` | The whole single-page UI (vanilla JS, no build step) |
| `public/features/quickwins.js` | Step-8 UI (usage, read aloud, find, export, tabs, compare, troubleshooting); a classic script loaded after `app.js`, sharing its global scope |
| `public/index.html`, `style.css` | Markup and styles |
| `bin/lumen-app.js` | Opens Lumen in a Chrome/Edge app window |
| `tests/` | Browser tests driven over CDP (see section 6) |
| `data/` | Runtime data (git-ignored): `chats.json`, `projects.json`, `settings.json` |

Run: `npm start` (port 3100) or `npm run app`. Node 22+. Ollama at `http://127.0.0.1:11434` (`OLLAMA_BASE_URL`).

### Conventions
- Keep the frontend dependency-free vanilla JS. npm packages are fine on the server (user approved).
- One branch per step (`step-N-short-name`) from `origin/main`, one PR per step, tests passing, then merge (the user pre-authorised merging these PRs).
  Commit trailer: `Co-Authored-By: Claude <noreply@anthropic.com>` (use the attribution your harness specifies).
- Every step ships tests in `tests/stepN-*.js` with real assertions, updates `tests/run.sh`, README, and this file.
- Report honestly: what was tested, what was not (e.g. real speech recognition cannot run headless), bugs found and fixed.
- Anything that launches programs, touches files, or sends data off the machine needs an approval or consent step.

### Security invariants (do not weaken)
1. Server listens on `127.0.0.1` only. The `guard()` in `server.js` rejects cross-site requests (`Origin` mismatch, `Sec-Fetch-Site: cross-site`),
   non-JSON POST/PUT bodies and non-local `Host` headers. Any new endpoint stays behind it.
2. Tool calls need approval (Allow once / Always allow / Deny) unless the user chose Always allow for that exact tool.
3. Artifact previews stay in a sandboxed iframe with an opaque origin (`sandbox="allow-scripts allow-forms"`, never `allow-same-origin`).
4. `fetch_page` blocks private/loopback/link-local addresses at connect time (DNS-rebinding safe).
5. Secrets (API keys, MCP env) must never be returned to the browser once stored.
6. Memory is never used or saved in Temporary chats.

### Gotchas already learned
- Ollama silently drops the *start* of an over-long prompt (the system prompt). `settings()` raises `num_ctx` automatically (4k to 32k).
- Reasoning models stream `message.thinking`; pass `think:false` for fast deterministic tests and titles.
- `gemma4` sometimes answers with an **empty** `thinking` even when the request says `think:true` — with a "answer in one short sentence" prompt
  that happened in about half the runs (checked straight against `curl http://127.0.0.1:11434/api/chat`, so it is the model, not Lumen).
  Tests that need a reasoning block should use a "explain step by step" prompt.
- Ollama streams `message.tool_calls`; tool names are namespaced `server__tool` (<= 64 chars).
- Chrome puts sandboxed iframes in a separate process that headless CDP cannot drive; tests launch Chrome with
  `--disable-features=IsolateSandboxedIframes` to click inside artifacts. The sandbox attribute is what is verified.
- Tests must override `window.confirm`; the app uses native `confirm`/`prompt` in places.
- A leftover headless Chrome from a crashed test run keeps the CDP debug port **and its old profile**, so the next run silently drives the stale
  page (it failed step 4 that way: the old profile had thinking switched off). `tests/lib/cdplib.js` now stops whatever listens on the debug port
  before starting a fresh browser, and kills the browser when the test process exits.
- This repo may be worked on from a git worktree. Do not run git in a different checkout than the session is bound to.

## 3. Models

- Local: `gemma4:latest`, `gemma4:12b` (capabilities reported by Ollama: completion, vision, audio, tools, thinking).
- Cloud: **`minimax-m3.1-flash:cloud`** is installed in the user's Ollama. It is served through Ollama's cloud, so **prompts leave the machine**.
  Verified through Lumen: it lists in the model picker, answers text, and answered image + PDF + text-file questions correctly.
  Not yet probed: tool calling and thinking behaviour (run `curl localhost:11434/api/show -d '{"model":"minimax-m3.1-flash:cloud"}'`
  and test through Lumen; Step 14 adds explicit cloud labelling and consent).
- Secondhand (unverified): MiniMax's own API is reported as OpenAI-compatible at `https://api.minimax.io/v1` with model
  `MiniMax-M3.1-Flash-Preview`; OpenRouter lists `minimax/minimax-m3.1-flash:free`; CometAPI uses `minimax-m3.1-flash-preview`. Verify before relying on any of these.
- The user wants the *build session itself* to run on this model: `cd ~/lumen && ollama launch claude --model minimax-m3.1-flash:cloud`.

## 4. Claude Desktop reference (what was extracted, and how)

Source: the installed app (3.1623.1). Method: REA static analysis of `app.asar` (integrity policy `record-and-continue`, because the macOS signature
re-signs a native binary; nothing was executed), the shipped English UI strings (`Contents/Resources/en-US.json`, 861 strings), and the app's data folder
names/structure (never secret values). REA summary: 14 windows, 54 contextBridge APIs, 4 utility processes, ~1,500 IPC operations; a trace for the seed
`quickEntry` resolved (response too large to display). Coverage is partial (semantic graph truncated); the bundle is mostly a shell around the claude.ai web app,
so chat-side features (projects, artifacts, styles, memory) are *not* in it.

Desktop-only features found, and what Lumen does about them:

| Feature | Evidence | Plan |
|---|---|---|
| Quick Entry hotkey, push-to-talk dictation, tray, notifications, open-with, deep links | strings | Step 13 |
| Side Chat, Split View, chat tabs, reopen closed, next/previous chat | strings | Steps 8, 11 |
| Import MCP servers from `claude_desktop_config.json`; per-tool toggles; MCP log viewer; reload | config file, `mcp-user-tool-toggles.json`, strings | Step 9 |
| Desktop Extensions (`manifest.json` v0.3: `server.type`, `entry_point`, `mcp_config`, `user_config`, tools) | installed Filesystem extension, 14 tools | Step 9 |
| Skills (SKILL.md packs, 30 MB limit), plugins | strings | Step 10 |
| Cowork/Code: trusted folders, file edits, shell, permission modes, Changes (diff), Terminal, worktrees, scheduled tasks, "needs your input" | strings, `git-shadow`, `git-worktrees.json`, preference keys (`*ScheduledTasksEnabled`, `coworkBrowserToolsEnabled`, `coworkWebSearchEnabled`) | Step 12 |
| Usage panel and history | `plan-usage-history.json` | Step 8 (local tokens and speed) |
| Artifact window, Design/Prototypes, "artifact wants to open link" permission | strings | Step 15 |
| Per-host web approval ("Always allow reads on {host}") | strings | Step 12/15 |
| Third-party inference/providers, secure storage via system keyring | strings | Step 14 |
| Settings, troubleshooting, diagnostic report, reset app data, data folder | strings | Step 8 |

Local facts useful for Step 9 (read-only, never modify Claude's files; tests must use fixtures, not these paths):
- Config: `~/Library/Application Support/Claude/claude_desktop_config.json` (keys: `mcpServers`, `preferences`, `coworkUserFilesPath`). On this machine `mcpServers` is empty.
- Extensions: `~/Library/Application Support/Claude/Claude Extensions/<id>/manifest.json`; the installed Filesystem extension declares `server.type: node`,
  `entry_point: dist/index.js`, `user_config.allowed_directories {type: directory, required, multiple}` and 14 tools.

Out of scope (decided): remote control from a phone (needs a real login system), computer use, BLE hardware buddy, a Cowork-style VM sandbox,
enterprise/MDM policy, Claude-account usage limits, cloud sessions.

## 5. Build plan (steps 8 to 15)

For every step: branch, build, add `tests/stepN-*.js`, run `tests/run.sh`, update docs, PR, merge, short summary.

### Step 8: quick wins
- **Usage:** keep Ollama's final-chunk stats (`prompt_eval_count`, `eval_count`, `eval_duration`) on each assistant message; show tokens/s in the status line;
  Usage dialog (per model and day, from `GET /api/usage` aggregating chats). Mark cloud models.
- **Read aloud:** `speechSynthesis` button on assistant messages (strip markdown), stop control, voice picker, optional auto-read.
- **Find in conversation:** Ctrl/Cmd+F opens a find bar with match count, next/previous, highlight; Esc closes.
- **Export:** per-chat Markdown download (optionally with thinking and tool calls), Copy as Markdown, print stylesheet for PDF.
- **Chat tabs:** tab strip, reopen closed tab (Ctrl/Cmd+Shift+T), next/previous tab, "continue last chat" preference; persist open tabs.
- **Retry with another model / Compare:** regenerate menu with a model chooser (uses the existing fork mechanism); Compare dialog streaming two models side by side with "Keep this one".
- **Troubleshooting:** Settings > Troubleshooting with server log view, diagnostic report (versions, Ollama reachability, model list, no chat content), data folder path.
- Tests: usage numbers stored; `speechSynthesis` mocked; find counts; export content; tab behaviours; model-switch regenerate creates a fork with a different model.

**Done** on branch `step-8-quickwins` (tests: `tests/step8-quickwins.js` — 83 assertions — plus `tests/lib/harness-checks.js` — 8 assertions; `tests/run.sh 8`).
Handoff notes:
- The step-8 UI lives in `public/features/quickwins.js`, a classic script loaded after `app.js`; it uses the new `hooks` object in `app.js`
  (`onRender`, `onMsgAction`, `onOpenChat`, `onNewChat`, `onReply`) so `app.js` stays untouched. Later steps can add their own `public/features/*.js` the same way.
- `app.js` now stores the final Ollama chunk counters on each assistant message (`message.stats`) plus `message.model` and `message.t`; `PUT /api/chats/:id`
  copies the whole `messages` array, so those fields are saved without a schema change. `GET /api/usage` aggregates them per model and per local day.
- `generate(fork, model)` takes an optional model, so "try another model" reuses the existing fork mechanism and the old answer stays as another version.
- New API routes (`/api/usage`, `/api/logs`, `/api/diagnostics`) sit inside `api()` and are therefore behind `guard()`. The diagnostic report and the log view
  contain no chat content (asserted in the tests).
- Preferences (auto-read, voice, continue-last-chat, open tabs) live in `localStorage` via `pref()`; the server `settings` schema is untouched.
- Not covered by the tests: real speech (the tests mock `speechSynthesis`), the print-to-PDF result (only the print stylesheet is asserted),
  and the real clipboard in browsers that block it (the test grants the permission).

Fix round 1 (same branch, second commit):
- The CDP harness (`tests/lib/cdplib.js`) frees a debug port by looking at the command line of every listener: only browsers that carry the harness
  profile `chrome-prof-<port>` are stopped (SIGTERM, then SIGKILL after a grace period), and the port is waited on until it is free. A process that
  belongs to somebody else is never killed — the run stops with a clear error instead. `lsof` is called without a shell, and Ctrl+C now stops the
  browser too (the `exit` hook does not fire on a signal). The checks live in `tests/lib/harness-checks.js`.
- "Continue last chat" now opens the most recently **updated** chat. `GET /api/chats` sorts pinned chats first, so `list[0]` was the pinned one.
- The answer that follows a tool call now stays on the model the user picked and inside the branch it belongs to: `generate()` threads the fork spec
  and the model into the follow-up (`generate(fork, useModel)`), and only the call that opens a branch may finish or undo it.
- The troubleshooting assertions were widened: a second chat with a marker of its own must not show up in the diagnostic report or in the log, and no
  part of any stored message may appear in either of them.
- The stderr of an MCP server never reaches the server log any more. `mcp.js` keeps it apart from the error message; the log only shows the status
  ("MCP <name>: error — details in Settings > Tools"), the stderr itself stays in the Tools dialog.
- The model chooser and the compare dialog do not open when Ollama reports no models — they say so instead of starting with an empty list.

### Step 9: import from Claude Desktop
- Detect the Claude config path per OS (macOS above; Windows `%APPDATA%\Claude`; Linux `~/.config/Claude`). Read-only parse of `mcpServers` (`command`, `args[]`, `env{}`).
  Show a **review dialog** (commands visible, env values masked); the user adds each explicitly with the existing trust confirmation. Never auto-add. Skip duplicates.
- **Extensions (.mcpb/.dxt):** unzip (use `fflate` or `adm-zip`) into `data/extensions/<id>`, validate `manifest.json` (v0.3), render a form from `user_config`
  (types `directory`, `file`, `string`, `number`, `boolean`; `multiple`; `required`; sensitive fields masked), substitute `${__dirname}`, `${HOME}`, `${user_config.key}`
  (array values expand into multiple args), run through the existing stdio MCP client. Also list already-installed Claude extensions for import (copy by reference, never edit them).
- **Per-tool toggles:** checkbox per tool in the Tools dialog; disabled tools are not sent to the model. Store in Lumen's settings (do not read Claude's toggles file).
- **MCP logs and reload:** per-server stderr ring buffer at `GET /api/mcp/:id/logs`, a log viewer, and "Reload all".
- Tests: fixture config + fixture `.mcpb` built in the test (zip with a tiny node MCP server); toggles remove a tool from the `tools` payload; placeholder substitution; path traversal in zip entries rejected; zip size limit.

### Step 10: Skills
- A skill is a folder with `SKILL.md` (YAML frontmatter `name`, `description`) plus optional files, stored in `data/skills/<name>/`. 30 MB limit.
- UI: Skills dialog (list, enable/disable, create/edit `SKILL.md`, upload zip or files, delete) with two starter skills.
- Model integration: enabled skills' names and one-line descriptions go into the system prompt; built-in tools `use_skill(name)` (returns the SKILL.md body and file list) and
  `read_skill_file(name, path)`. `use_skill` auto-approved by default (read-only, local) but configurable.
- Tests: listing in prompt; real model calls `use_skill`; traversal blocked in `read_skill_file`; zip upload; size limit; disable hides it.

### Step 11: Side Chat and Split View
- **Side Chat:** right panel with its own thread seeded with a snapshot of the main conversation ("answer briefly; this is a side question"); never modifies the main chat;
  "Insert into chat" button; shortcut.
- **Split View:** second pane is an `<iframe src="/?embed=1&chat=ID">` of Lumen itself (same origin, separate JS state, shared server data). Add an `embed` mode (no sidebar, compact header)
  and cross-pane refresh over `BroadcastChannel`. This avoids refactoring the global state in `app.js`. Side Chat can reuse the same embed mechanism.
- Tests: two panes stream independently; side chat leaves main messages unchanged; insert works; embed mode layout; sidebar refresh across panes.

### Step 12: workspace agent (Cowork/Code-lite)
Highest risk step. There is **no VM sandbox**, so keep it conservative.
- **Trusted folders:** settings list; add by absolute path (browsers cannot pick folders); validate: exists, is a directory, `realpath` resolved, not a protected location
  (`/`, home root, `~/Library`, `~/.ssh`, `~/.config`, system dirs, other users' homes), not a network path. Optional per-project folder.
- **Built-in "Workspace" tools** (virtual MCP server like Web): `fs_list`, `fs_tree`, `fs_read`, `fs_search`, `fs_write`, `fs_edit` (old/new string), `shell`.
  Every path is resolved with `realpath` and must stay inside a trusted folder (block `..`, symlinks out, absolute paths elsewhere).
- **Permission modes per chat:** `ask` (reads inside trusted folders auto, writes and shell need approval) and `auto-edit` (file edits auto, shell asks). **No bypass mode.**
  Approval cards show a diff for edits and the exact command for shell.
- **Changes pane:** before the first write to a file in a session, snapshot the original under `data/changes/<chat>/`; show unified diffs (use the `diff` package) with per-file and
  Revert all.
- **Terminal pane:** log of shell tool output (streamed), kill button, no interactive pty.
- **Shell safety:** `sh -c` with `cwd` inside the trusted folder; scrubbed environment (drop `*KEY*`, `*TOKEN*`, `*SECRET*`, `ANTHROPIC_*`, etc.); 120 s timeout; 100 KB output cap;
  kill the whole process group on stop; still always requires approval in both modes. Warn in the UI that this is not a sandbox.
- **Needs your input:** badge on sidebar chats waiting for approval, and a browser Notification when the tab is hidden.
- **Scheduled tasks (minimal):** daily/interval prompt that runs headless while the server is up; may only use tools already set to Always allow; result lands in a chat; notification.
- Tests (use a temp folder): containment (`../`, symlink escape, absolute outside) all blocked; edit approval shows a diff; revert restores bytes; shell approval; env scrub;
  output truncation; timeout kill; protected folder rejected; real-model task (create a file, read it back); schedule fires.

### Step 13: native shell (Electron)
- `desktop/main.js`: start the server in-process, `BrowserWindow` on `http://127.0.0.1:PORT` with `contextIsolation`, `sandbox`, no node integration, minimal preload,
  navigation locked to the local origin. Single-instance lock; app menu with the shortcuts.
- **Tray** with "runs in background" (close to tray). **Quick Entry:** global shortcut opens a small always-on-top window that sends the text to a new chat in the main window.
  **Dictation hotkey:** toggle (Electron has no global key-up). Native notifications ("needs approval", "reply finished" while unfocused). Open-with / drop-on-dock attaches files.
  `lumen://` deep links. Launch-at-login preference.
- Packaging: `npm run desktop` for dev; `electron-builder` config for an unsigned macOS app (note Gatekeeper). Allow the guard to accept the Electron origin.
- Tests: Electron launched with `--remote-debugging-port` and driven through CDP (the REA MCP's `capture_electron_scenario` can also be used): window loads, single-instance, IPC for Quick Entry
  via a test-only hook. **Needs manual verification:** global hotkeys, tray, notifications, login item.

### Step 14: providers, cloud model labelling, secrets
- **Cloud model awareness:** mark Ollama cloud models (name ends `:cloud`, or `/api/tags` shows `remote_host`) with a cloud badge; one-time consent
  ("prompts are processed by Ollama's cloud"); per-project **Local only** switch that blocks cloud models; optional default-model preference (the user wants `minimax-m3.1-flash:cloud` available).
- **OpenAI-compatible providers:** `{name, baseUrl, apiKey, models[]}` with presets (MiniMax API, OpenRouter, LM Studio at `http://localhost:1234/v1`, llama.cpp server). Server proxies `/chat/completions`
  streaming and translates to the NDJSON shape the client already uses (`message.content`, `message.thinking` from `reasoning_content`, `tool_calls` from streamed deltas
  with JSON-string arguments, images as `image_url` data URIs). Model ids are namespaced `provider:model`. The client stays unchanged.
- **Secrets vault:** macOS Keychain via `security`, Linux `secret-tool` when available, otherwise an encrypted file with a random key in `data/.key` (mode 600, with a visible warning).
  Move the Brave key, provider keys and MCP env values flagged secret into it. The API never returns secrets.
- Tests: fake OpenAI-compatible streaming server (content, reasoning, tool-call deltas) end to end including the tool loop; secrets absent from `settings.json`; consent dialog; local-only project
  blocks cloud models; Keychain tests use a throwaway service name and clean up.

### Step 15: research and artifacts
- **Research mode** (composer toggle, needs web tools): the model plans, then loops `web_search` / `fetch_page` within a budget (default 8 searches, 15 page fetches, 6 minutes) after **one up-front consent**
  for that run; progress panel (queries, pages read), Stop; final report with numbered citations and a source list, opened as a Markdown artifact.
- **AI-powered artifacts:** sandbox stays opaque-origin; `window.lumen.ask(prompt)` and `window.lumen.storage` via a `postMessage` bridge to the parent, with per-artifact consent,
  rate and size limits and a visible indicator. Link opening from an artifact asks first.
- **Artifact library and pop-out:** page listing artifacts across chats (search, open, download); pop-out route served with `Content-Security-Policy: sandbox allow-scripts` so it keeps an opaque origin.
- Tests: bridge round trip and limits; sandbox probes still blocked; library; CSP header on the pop-out; research run against the fake SearXNG with real `example.com` pages.

## 6. Testing

`tests/run.sh [steps...]` starts a throwaway server (port 3101, temp data dir) and `tests/fake-searxng.js`, then runs `tests/stepN-*.js` against Chrome over CDP (`tests/lib/cdplib.js`).
Needs Chrome (or `CHROME=...`), Node 22+, and Ollama with a vision + tools + thinking model. Tests use the first model Lumen lists, which can be a **cloud** model; pin a local one with
`LUMEN_TEST_MODEL=gemma4:latest`. `tests/mcp-test-server.js` (stdio) and `tests/mcp-http-server.js` (Streamable HTTP) are tiny MCP servers for tool tests.

Not covered by automated tests (say so in reports): real speech recognition, real global hotkeys/tray/notifications, launching `npm run app` as a visible window, a real Brave API key.

## 7. Start prompt for a new session

> Read `docs/ROADMAP.md` and `README.md`. Continue the Lumen roadmap from step 8 through step 15, one branch and PR per step: build it, add tests under `tests/`, run `tests/run.sh`, merge,
> and move to the next. Keep every security invariant in section 2. Only stop if something serious needs my attention, and finish with a brief report of what happened and what is left.
