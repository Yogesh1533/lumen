# Lumen — implementation plan for roadmap steps 8 to 15

Spec: `docs/ROADMAP.md` (section 5 "Build plan (steps 8 to 15)" is binding; section 2 "Security invariants" is binding).
Each task = one branch `step-N-short-name` cut from `origin/main`, one PR, tests in `tests/stepN-*.js`, updated `tests/run.sh`, README and ROADMAP, then merge.

Global constraints for every task:
- Keep every security invariant in ROADMAP section 2 (guard on 127.0.0.1 + Origin/Sec-Fetch-Site/Host checks; tool approval; opaque-origin artifact sandbox; SSRF block; secrets never returned; memory never in Temporary chats).
- Frontend stays dependency-free vanilla JS. Server-side npm packages are allowed (user approved).
- Never auto-add an imported MCP server; never auto-approve a tool.
- Update `docs/ROADMAP.md` status + handoff notes and `README.md` in the same commit as the feature.
- Commit trailer: `Co-Authored-By: Claude Code <noreply@anthropic.com>`

### Task 1: Step 8 — quick wins

Files: `server.js`, `public/app.js`, `public/index.html`, `public/style.css`, `tests/step8-quickwins.js`, `tests/run.sh`, `README.md`, `docs/ROADMAP.md`

- Usage stats: server stores the final Ollama chunk's `prompt_eval_count`, `eval_count`, `eval_duration`, `total_duration` on each assistant message. Add `GET /api/usage` aggregating per model and per day from stored chats.
- Read aloud: `speechSynthesis` button per assistant message (markdown stripped), stop control, voice picker, optional auto-read preference.
- Find in conversation: Cmd/Ctrl+F opens an in-app find bar with match count, next/previous, highlight, Esc closes.
- Export: per-chat Markdown download (optional thinking and tool calls), Copy as Markdown, print stylesheet for PDF.
- Chat tabs: tab strip, reopen closed tab (Cmd/Ctrl+Shift+T), next/previous tab, "continue last chat" preference, persist open tabs.
- Retry with another model: regenerate menu with a model chooser that forks the reply with a different model. Compare dialog streaming two models side by side with "Keep this one".
- Troubleshooting: Settings > Troubleshooting with a server log view, a diagnostic report (versions, Ollama reachability, model list, no chat content) and the data folder path.

Tests (`tests/step8-quickwins.js`): usage numbers stored on a message and aggregated by `GET /api/usage`; `speechSynthesis` mocked and called with the right text; find bar counts matches and moves between them; exported Markdown contains the chat content; tab open/switch/close/reopen/next/prev; model-switch regenerate creates a fork with a different model.

Expected: `tests/run.sh 8` prints "ALL PASSED" and exits 0.

### Task 2: Step 9 — import from Claude Desktop

Files: `server.js`, `public/app.js`, `public/index.html`, `public/style.css`, `tests/step9-claude-import.js`, `tests/run.sh`, `README.md`, `docs/ROADMAP.md`

- Detect the Claude config path per OS (macOS `~/Library/Application Support/Claude/claude_desktop_config.json`, Windows `%APPDATA%\Claude`, Linux `~/.config/Claude`). Read-only parse of `mcpServers` (`command`, `args[]`, `env{}`).
- Review dialog showing commands and masked env values; the user adds each server explicitly with the existing trust confirmation. Never auto-add. Skip duplicates.
- Extensions (`.mcpb`/`.dxt`): unzip into `data/extensions/<id>`, validate `manifest.json` (v0.3), render a form from `user_config` (types `directory`, `file`, `string`, `number`, `boolean`; `multiple`; `required`; sensitive fields masked), substitute `${__dirname}`, `${HOME}`, `${user_config.key}` (array values expand into multiple args), run through the existing stdio MCP client. List already-installed Claude extensions for import (copy by reference, never edit them).
- Per-tool toggles: a checkbox per tool in the Tools dialog; disabled tools are not sent to the model. Stored in Lumen's own settings (never read Claude's toggle file).
- MCP logs and reload: per-server stderr ring buffer at `GET /api/mcp/:id/logs`, a log viewer in the UI, and "Reload all".

Tests (`tests/step9-claude-import.js`): fixture config + a fixture `.mcpb` built in the test (zip with a tiny node MCP server); toggles remove a tool from the `tools` payload; placeholder substitution; path traversal in zip entries rejected; zip size limit.

Expected: `tests/run.sh 9` prints "ALL PASSED" and exits 0.

### Task 3: Step 10 — Skills

Files: `server.js`, `public/app.js`, `public/index.html`, `public/style.css`, `tests/step10-skills.js`, `tests/run.sh`, `README.md`, `docs/ROADMAP.md`

- A skill is a folder with `SKILL.md` (YAML frontmatter `name`, `description`) plus optional files, stored in `data/skills/<name>/`. 30 MB limit.
- UI: a Skills dialog (list, enable/disable, create/edit `SKILL.md`, upload a zip or files, delete) with two starter skills.
- Model integration: enabled skills' names and one-line descriptions go into the system prompt; built-in tools `use_skill(name)` (returns the `SKILL.md` body and file list) and `read_skill_file(name, path)`. `use_skill` is auto-approved by default (read-only, local) but configurable.
- Traversal in `read_skill_file` is blocked; the skill name is validated.

Tests (`tests/step10-skills.js`): enabled skills appear in the system prompt; a real model call uses `use_skill`; traversal blocked in `read_skill_file`; zip upload; size limit; disabling hides it.

Expected: `tests/run.sh 10` prints "ALL PASSED" and exits 0.

### Task 4: Step 11 — Side Chat and Split View

Files: `public/app.js`, `public/index.html`, `public/style.css`, `public/app-embed.js` (or equivalent), `tests/step11-side-split.js`, `tests/run.sh`, `README.md`, `docs/ROADMAP.md`

- Side Chat: a right panel with its own thread seeded from a snapshot of the main conversation ("answer briefly; this is a side question"); it never modifies the main chat; "Insert into chat" button; shortcut.
- Split View: the second pane is an `<iframe src="/?embed=1&chat=ID">` of Lumen itself (same origin, separate JS state, shared server data). Add an `embed` mode (no sidebar, compact header) and cross-pane refresh over `BroadcastChannel`. Side Chat can reuse the same embed mechanism.

Tests (`tests/step11-side-split.js`): two panes stream independently; the side chat leaves main messages unchanged; insert works; embed mode layout; sidebar refresh across panes.

Expected: `tests/run.sh 11` prints "ALL PASSED" and exits 0.

### Task 5: Step 12 — workspace agent (Cowork/Code-lite)

Highest risk step. There is no VM sandbox, so keep it conservative.
Files: `server.js` (new `workspace.js`), `public/app.js`, `public/index.html`, `public/style.css`, `tests/step12-workspace.js`, `tests/run.sh`, `README.md`, `docs/ROADMAP.md`

- Trusted folders: a settings list; add by absolute path (browsers cannot pick folders). Validate: exists, is a directory, `realpath` resolved, not a protected location (`/`, home root, `~/Library`, `~/.ssh`, `~/.config`, system dirs, other users' homes), not a network path. Optional per-project folder.
- Built-in "Workspace" tools (a virtual MCP server like Web): `fs_list`, `fs_tree`, `fs_read`, `fs_search`, `fs_write`, `fs_edit` (old/new string), `shell`. Every path is resolved with `realpath` and must stay inside a trusted folder (block `..`, symlinks out, absolute paths elsewhere).
- Permission modes per chat: `ask` (reads inside trusted folders auto, writes and shell need approval) and `auto-edit` (file edits auto, shell asks). No bypass mode. Approval cards show a diff for edits and the exact command for shell.
- Changes pane: before the first write to a file in a session, snapshot the original under `data/changes/<chat>/`; show unified diffs with per-file revert and Revert all.
- Terminal pane: a log of shell tool output (streamed), a kill button, no interactive pty.
- Shell safety: `sh -c` with `cwd` inside the trusted folder; scrubbed environment (drop `*KEY*`, `*TOKEN*`, `*SECRET*`, `ANTHROPIC_*`); 120 s timeout; 100 KB output cap; kill the whole process group on stop; always requires approval in both modes. The UI warns that this is not a sandbox.
- Needs your input: a badge on sidebar chats waiting for approval, and a browser Notification when the tab is hidden.
- Scheduled tasks (minimal): a daily/interval prompt that runs headless while the server is up; it may only use tools already set to Always allow; the result lands in a chat with a notification.

Tests (`tests/step12-workspace.js`, using a temp folder): containment (`../`, symlink escape, absolute outside) all blocked; edit approval shows a diff; revert restores bytes; shell approval; env scrub; output truncation; timeout kill; protected folder rejected; a real-model task creates a file and reads it back; a schedule fires.

Expected: `tests/run.sh 12` prints "ALL PASSED" and exits 0.

### Task 6: Step 13 — native shell (Electron)

Files: `desktop/main.js`, `desktop/preload.js`, `package.json`, `server.js` (Electron-origin allowance), `tests/step13-electron.js`, `tests/run.sh`, `README.md`, `docs/ROADMAP.md`

- `desktop/main.js`: start the server in-process, a `BrowserWindow` on `http://127.0.0.1:PORT` with `contextIsolation`, `sandbox`, no node integration, a minimal preload, navigation locked to the local origin. Single-instance lock; an app menu with the shortcuts.
- Tray with "runs in background" (close to tray). Quick Entry: a global shortcut opens a small always-on-top window that sends the text to a new chat in the main window. Dictation hotkey toggle. Native notifications ("needs approval", "reply finished" while unfocused). Open-with / drop-on-dock attaches files. `lumen://` deep links. Launch-at-login preference.
- Packaging: `npm run desktop` for dev; an `electron-builder` config for an unsigned macOS app (note Gatekeeper). The guard accepts the Electron origin.
- Tests: Electron launched with `--remote-debugging-port` and driven through CDP: the window loads, single-instance holds, IPC for Quick Entry via a test-only hook.
- Manual verification (not automated): global hotkeys, tray, notifications, login item.

Expected: `tests/run.sh 13` prints "ALL PASSED" and exits 0.

### Task 7: Step 14 — providers, cloud model labelling, secrets

Files: `server.js` (new `providers.js`, new `secrets.js`), `public/app.js`, `public/index.html`, `public/style.css`, `tests/step14-providers.js`, `tests/run.sh`, `README.md`, `docs/ROADMAP.md`

- Cloud model awareness: mark Ollama cloud models (name ends `:cloud`, or `/api/tags` shows `remote_host`) with a cloud badge; one-time consent ("prompts are processed by Ollama's cloud"); a per-project **Local only** switch that blocks cloud models; an optional default-model preference.
- OpenAI-compatible providers: `{name, baseUrl, apiKey, models[]}` with presets (MiniMax API, OpenRouter, LM Studio at `http://localhost:1234/v1`, llama.cpp server). The server proxies `/chat/completions` streaming and translates to the NDJSON shape the client already uses (`message.content`, `message.thinking` from `reasoning_content`, `tool_calls` from streamed deltas with JSON-string arguments, images as `image_url` data URIs). Model ids are namespaced `provider:model`. The client stays unchanged.
- Secrets vault: macOS Keychain via `security`, Linux `secret-tool` when available, otherwise an encrypted file with a random key in `data/.key` (mode 600, with a visible warning). Move the Brave key, provider keys and MCP env values flagged secret into it. The API never returns secrets.

Tests (`tests/step14-providers.js`): a fake OpenAI-compatible streaming server (content, reasoning, tool-call deltas) end to end including the tool loop; secrets absent from `settings.json`; consent dialog; a local-only project blocks cloud models; Keychain tests use a throwaway service name and clean up.

Expected: `tests/run.sh 14` prints "ALL PASSED" and exits 0.

### Task 8: Step 15 — research and artifacts

Files: `server.js`, `public/app.js`, `public/index.html`, `public/style.css`, `tests/step15-research-artifacts.js`, `tests/run.sh`, `README.md`, `docs/ROADMAP.md`

- Research mode (a composer toggle, needs web tools): the model plans, then loops `web_search` / `fetch_page` within a budget (default 8 searches, 15 page fetches, 6 minutes) after one up-front consent for that run; a progress panel (queries, pages read) with Stop; a final report with numbered citations and a source list, opened as a Markdown artifact.
- AI-powered artifacts: the sandbox stays opaque-origin; `window.lumen.ask(prompt)` and `window.lumen.storage` via a `postMessage` bridge to the parent, with per-artifact consent, rate and size limits and a visible indicator. Link opening from an artifact asks first.
- Artifact library and pop-out: a page listing artifacts across chats (search, open, download); the pop-out route served with `Content-Security-Policy: sandbox allow-scripts` so it keeps an opaque origin.

Tests (`tests/step15-research-artifacts.js`): bridge round trip and limits; sandbox probes still blocked; library; the CSP header on the pop-out; a research run against the fake SearXNG with real `example.com` pages.

Expected: `tests/run.sh 15` prints "ALL PASSED" and exits 0.
