# Lumen roadmap and handoff

Written so a fresh coding session can continue the project without the earlier conversation.
Repo: `Yogesh1533/lumen` (private). Local checkout: `~/lumen`. The user's own copy runs on port **3100**; tests use **3101**.

## 1. Status

Steps 1 to 7 are built, tested and merged (PRs #1 to #7):
attachments and vision, artifacts, projects, thinking and branching and auto titles, styles and memory,
MCP tools with approval, command palette and shortcuts and dictation and web tools and installable app.

Step 8 (quick wins) is built, tested and merged (PR #9):
token usage and a usage dialog, read aloud, find in conversation, Markdown export, chat tabs,
try another model and side-by-side compare, and a troubleshooting dialog with a diagnostic report.

Step 9 (import from Claude Desktop) is built, tested and merged (PR #10):
a review dialog for Claude's MCP servers, extension bundles (`.mcpb`/`.dxt`), a switch per tool,
a per-server log viewer and "Reload all".

Step 10 (skills) is built, tested and merged (PR #11):
a skill is a folder with a `SKILL.md`; a Skills dialog (list, switch on and off, write and edit,
upload a zip or loose files, delete), two starter skills, the skills tools `use_skill` and
`read_skill_file`, and the enabled skills in the system prompt.

Step 11 (side chat and split view) is built, tested and merged (PR #12):
a side chat in a panel of its own (its own chat record, seeded with a bounded snapshot of the main
conversation, "Insert into chat" puts the answer into the main chat), a split view whose second pane
is Lumen itself in an embed mode, and a cross-pane refresh over a BroadcastChannel.

The server stamps the chats with a monotonic clock (`stamp.js`): the stamps are strictly increasing,
so two chats made in the same millisecond never tie and "continue last chat" always opens the chat
that was updated last (it used to open the older one of the two).

Step 12 (workspace agent) is built, tested and committed on branch `step-12-workspace`:
trusted folders, seven workspace tools kept inside the folder of the chat, the Ask and Auto-edit modes, approval
cards with the diff of an edit and the exact command, a Changes pane with revert, a Terminal pane with Stop, the
"needs your input" badge and notification, and scheduled tasks.

**Next: steps 13 to 15 below.** The user asked for all of them to be run autonomously (build, test, merge, repeat).

## 2. Orientation

| File | Role |
|---|---|
| `server.js` | Zero-framework Node API: chats/projects/settings storage, request **guard**, Ollama proxy, MCP routes |
| `mcp.js` | MCP client manager (stdio + Streamable HTTP) on `@modelcontextprotocol/sdk` |
| `webtools.js` | Built-in `fetch_page` / `web_search` with SSRF protection |
| `public/app.js` | The whole single-page UI (vanilla JS, no build step) |
| `public/features/quickwins.js` | Step-8 UI (usage, read aloud, find, export, tabs, compare, troubleshooting); a classic script loaded after `app.js`, sharing its global scope |
| `public/features/claudeimport.js` | Step-9 UI (import dialog, extension form, tool switches, log viewer); a classic script loaded after `app.js` |
| `skills.js` | The skills of the user: the folders in `data/skills/<name>/`, the two read-only tools of the model |
| `public/features/skills.js` | Step-10 UI (Skills dialog, the editor of a `SKILL.md`, the uploads, the approval switches); a classic script loaded after `app.js` |
| `starter-skills/` | The two skills that ship with Lumen (`summarise`, `explain`); copied into `data/skills/` on the first run, never overwritten |
| `claude.js` | Claude Desktop's config and extensions — **read-only** (never writes in Claude's folders) |
| `zip.js` | Dependency-free reader for `.mcpb`/`.dxt` bundles, with the limits and the path checks |
| `public/index.html`, `style.css` | Markup and styles |
| `bin/lumen-app.js` | Opens Lumen in a Chrome/Edge app window |
| `tests/` | Browser tests driven over CDP (see section 6) |
| `data/` | Runtime data (git-ignored): `chats.json`, `projects.json`, `settings.json`, `skills/<name>/` (the skills of the user) |

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

**Done** on branch `step-8-quickwins` (tests: `tests/step8-quickwins.js` — 84 assertions — plus `tests/lib/harness-checks.js` — 13 assertions; `tests/run.sh 8`).
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

Fix round 2 (same branch, third commit — test harness only, no change to the shipped feature code):
- The Chrome profile of a run is deleted again: the profile dir is `chrome-prof-<port>-<pid>` and is removed when the browser exits, and every
  `chrome-prof-<port>` dir left over by an earlier run is swept before the browser starts (the profile of a still running run is kept).
- A closed terminal stops the browser: the harness handles `SIGHUP` like `SIGINT` and `SIGTERM` (`process.on('exit')` does not fire on a signal).
- The harness checks do not use the fixed debug ports 9390/9391/9392 any more — they take a free port from the OS. The checks even occupy the old
  fixed ports while they run, so a step-8 run no longer fails with a misleading message when something else holds one of them.
- The step-4 thinking check no longer lets the thinking text stand in for the live indicator: the "open and live" check comes from the DOM alone
  (a `MutationObserver` watches it, so a short-lived live block is not missed), and the thinking text of the finished message is a separate
  assertion. A broken live class now fails the test.
- The step-8 "the dialog does not open" assertions ask for the element to exist as well (`!!document.querySelector(...) && !...open`): a page
  that throws answers with a truthy "EXC ..." string, so the old form could pass without checking anything. A companion assertion proves the
  check is not vacuous.

### Step 9: import from Claude Desktop
- Detect the Claude config path per OS (macOS above; Windows `%APPDATA%\Claude`; Linux `~/.config/Claude`). Read-only parse of `mcpServers` (`command`, `args[]`, `env{}`).
  Show a **review dialog** (commands visible, env values masked); the user adds each explicitly with the existing trust confirmation. Never auto-add. Skip duplicates.
- **Extensions (.mcpb/.dxt):** unzip (use `fflate` or `adm-zip`) into `data/extensions/<id>`, validate `manifest.json` (v0.3), render a form from `user_config`
  (types `directory`, `file`, `string`, `number`, `boolean`; `multiple`; `required`; sensitive fields masked), substitute `${__dirname}`, `${HOME}`, `${user_config.key}`
  (array values expand into multiple args), run through the existing stdio MCP client. Also list already-installed Claude extensions for import (copy by reference, never edit them).
- **Per-tool toggles:** checkbox per tool in the Tools dialog; disabled tools are not sent to the model. Store in Lumen's settings (do not read Claude's toggles file).
- **MCP logs and reload:** per-server stderr ring buffer at `GET /api/mcp/:id/logs`, a log viewer, and "Reload all".
- Tests: fixture config + fixture `.mcpb` built in the test (zip with a tiny node MCP server); toggles remove a tool from the `tools` payload; placeholder substitution; path traversal in zip entries rejected; zip size limit.

**Done** on branch `step-9-claude-import` (tests: `tests/step9-claude-import.js` — 145 assertions — plus `tests/lib/zipwrite.js`, a tiny zip writer for the fixtures; `tests/run.sh 9`).
Handoff notes:

- **New files:** `claude.js` (read-only access to Claude's config and extensions), `zip.js` (the bundle reader), `public/features/claudeimport.js` (the UI),
  `tests/lib/zipwrite.js` (the test's zip writer). `server.js` grew the `/api/claude/*` routes, the tool switches and the log route; `mcp.js` keeps a
  stderr ring buffer; `public/app.js` only skips switched-off tools in `buildTools()` and calls the new `hooks.onToolsRender`.
- **The tool-switch format contract** (steps 10 and 12 reuse it — define it once, here):
  `settings.toolToggles[providerId][toolName] === false` means *off*; a missing key means *on*.
  `providerId` is the id of the MCP server (a UUID), `"builtin"` for the built-in web tools, and later `"skills"` (step 10) and `"workspace"` (step 12).
  The browser gets every tool with an `enabled` flag and leaves the `enabled === false` ones out of the `tools` payload; the server refuses a call to a
  switched-off tool (defence in depth — the model cannot call it either). `PUT /api/mcp/:id/tools` with `{disabled: [toolName, …]}` writes the switches;
  removing a server removes its switches. The **page** keeps the switches of every server in a map (`toolOff`) and updates it before the request goes
  out, and the requests of one server go one after the other — two clicks in a row therefore do not lose the first one.
- **Secrets.** `view()` used to return the env values in plain text — fixed. The browser now only ever gets the env **keys** and a mask
  (`••••` plus the last four characters; values of four characters or less are fully masked). A value can be replaced or removed with
  `PUT /api/mcp/:id/env` (`{key, value}` or `{key, clear: true}`) — the old value is never read back, so it can never leak. The command, the arguments
  and the URL of a server are scrubbed of the secret values too, so a secret pasted into an argument does not show up in the dialog either.
  The **output** of a server is scrubbed as well: the `error` and the `stderr` of `view()` and every line of `GET /api/mcp/:id/logs` go through the
  same `redact()`, so a server that writes its own command line to stderr cannot put a secret into the browser. A secret of less than four
  characters is masked as well (as a whole word, so the text around it stays readable).
- **Never automatic.** `POST /api/claude/import` and `POST /api/claude/extensions/install` refuse to do anything without `confirm: true` (400 otherwise),
  and the dialog asks the same trust question as a server that is added by hand. A server that is already in Lumen is marked and refused (409).
  The client sends `confirm: true` **only after** the user has seen the command and answered the question: for an extension the command comes from
  `POST /api/claude/extensions/preview` (the command and the arguments with the secret values masked), for a server of Claude's config from the
  review dialog (the command and the arguments, also scrubbed of the secret values).
- **An imported server is a normal server.** The server of Claude's config goes through the same `cleanCfg` as one that is added by hand: a name of at
  most 40 characters, a command of at most 1000 characters, at most 50 arguments of at most 1000 characters, at most 20 env values, and a `http(s)`
  URL — a `file://` URL or a server without a command is refused with a 400.
- **Bundles are hostile input.** `zip.js` refuses absolute paths, drive letters, `..` segments, symlink entries, encrypted entries, Zip64 and broken
  directories, and it verifies that every file stays inside the extraction folder. The folder is emptied before it is written to, and the files are
  written with mode 600. **The limits:** 2000 entries, 50 MB uncompressed in total, 20 MB per file, 20 MB for the uploaded file, 200:1 compression ratio.
  **They are checked on the bytes that are really produced, not on the numbers the bundle claims:** the inflation is bounded
  (`zlib.inflateRawSync(raw, { maxOutputLength })`), the size of every file is measured after the inflation, the running total is the sum of the
  written bytes, and the sizes in the central directory are only a first filter. A bundle that lies about its size is therefore refused as well.
  (The `maxOutputLength` of `zlib` has been there since Node v12.19.0/v14.5.0 — the **Node 22+** floor of `package.json` is a support
  choice, not a technical need: 22 is the current LTS, 18 and 20 are end-of-life.)
  **Every refusal names the limit that fired** — the limit per file, the limit in total, the limit of the upload, the number of files or the
  compression ratio are five different messages. A bundle whose compressed stream is broken is reported as broken (the error of `zlib` is passed on),
  not as a file that is too big. The name of an entry comes from the bundle, so it is stripped of control characters and shortened before it goes
  into an error message.
  Uploaded bundles are unpacked into `data/extensions/<uuid>`; an extension of Claude Desktop is imported **by reference** (its folder is never copied
  into Lumen and never written to).
- **Manifests** are v0.3 (`manifest_version: "0.3"`); anything else is refused. `user_config` supports the types `directory`, `file`, `string`, `number`
  and `boolean` with `required`, `multiple` and `sensitive`; sensitive fields are password fields and **their default never enters the page** (an
  empty field means "use the default"). The schema the **browser** gets comes from `claude.publicUserConfigSchema()` — the same schema as the
  server's, but without the `default` of a sensitive field, so a manifest that declares a secret as a default never puts it into the browser. The
  server keeps the default (`claude.userConfigSchema()`), so an empty field still means "use the default" when the extension is installed. A list
  that is not a secret shows the default of the manifest in its textarea; a list of secrets stays empty.
  The placeholders `${__dirname}`, `${HOME}` and `${user_config.key}` are substituted; an argument that is
  exactly a `${user_config.key}` of a list becomes one argument per value. A `binary` extension runs the file itself — it is never its own first
  argument.
- **Logs and reload.** `mcp.js` keeps the last 200 stderr lines per server (`GET /api/mcp/:id/logs`), the Tools dialog has a viewer (≡) per server and
  a "Reload all" button (`POST /api/mcp/reload`). The built-in web tools have no process, so they have no log and no button.
- **The tests use fixtures, never the real files.** `LUMEN_CLAUDE_CONFIG` and `LUMEN_CLAUDE_EXTENSIONS` point the reader at a fixture folder;
  `tests/run.sh` sets both. The test also asserts that Claude's config file is byte-for-byte unchanged after the import.
- Not covered by the tests: a real `.mcpb` from the Claude app (the fixture is built by the test), an extension in another language than node, and the
  Windows and Linux config paths (the path is chosen per OS in `claude.js`, but the test runs on macOS).

### Step 10: Skills
- A skill is a folder with `SKILL.md` (YAML frontmatter `name`, `description`) plus optional files, stored in `data/skills/<name>/`. 30 MB limit.
- UI: Skills dialog (list, enable/disable, create/edit `SKILL.md`, upload zip or files, delete) with two starter skills.
- Model integration: enabled skills' names and one-line descriptions go into the system prompt; built-in tools `use_skill(name)` (returns the SKILL.md body and file list) and
  `read_skill_file(name, path)`. ~~`use_skill` auto-approved by default (read-only, local) but configurable.~~ **Corrected: approval is required by default** (see the handoff notes below).
- Tests: listing in prompt; real model calls `use_skill`; traversal blocked in `read_skill_file`; zip upload; size limit; disable hides it.

**Done** on branch `step-10-skills` (tests: `tests/step10-skills.js` — 112 assertions; `tests/run.sh 10`).
Handoff notes:

- **New files:** `skills.js` (the folders, the validation, the two tools of the model), `public/features/skills.js` (the UI),
  `starter-skills/summarise/` (`SKILL.md` + `checklist.md`) and `starter-skills/explain/` (`SKILL.md` + `examples.md`),
  `tests/step10-skills.js`. `server.js` grew the `/api/skills*` routes; `public/app.js` grew `loadSkills()` and `skillsPrompt()`.
- **`builtinServer()` became `builtinServers()`** (an array), as the plan asked: the web server keeps the id `builtin`, the skills server gets the id `skills`
  (`builtin: true`, `transport: 'builtin'`, `status: 'connected'`, and it is listed in `GET /api/mcp` next to the web server, so its tools can be switched off like any other).
  `POST /api/mcp/call` dispatches `server: 'skills'` to the skills implementation, exactly like `server: 'builtin'` goes to `webtools.call` — through the same
  `toolEnabled(provider, name)` check, so a switched-off skills tool never runs. `PUT /api/mcp/skills/tools` writes the switches with the step-9 format contract
  (`settings.toolToggles['skills'][tool] === false` means off; the provider id is the server id).
- **The approval ruling (the plan's section 5 and the security invariants disagreed).** The invariants win: **a skills tool asks for approval like every other tool.**
  The Skills dialog has a switch per skills tool — "ask before a skill is used" — and it is **on** by default. Turning it **off** writes "always allow" for that exact
  tool into the **existing** client store (`toolAllow()` / `saveAllow()` in `public/app.js`, the same localStorage store the "Always allow" button writes to). That is the
  invariant's own exception and nothing more: no server-side auto-approval, no new bypass, no change to the approval flow. `read_skill_file` is **not** exempt — it is the
  tool that touches a path inside a skill folder, so it must be able to refuse a traversal.
- **The 30 MB limit holds however the skill arrives.** `zip.js` now takes a limits override (`readZip(buf, limits)` / `extract(buf, destDir, limits)`, merged over the
  defaults) — **the defaults did not change** (the step-9 tests pin them). A skill bundle uses 30 MB per file, 30 MB in total and 30 MB per upload; the same limit is
  enforced on the folder as a whole after the extraction, on a hand-written `SKILL.md` and on a loose file. The limits are measured on the bytes that are really
  produced, not on the sizes the bundle claims. The ratio limit of the general bundle reader (200:1) is **2000:1 for skill bundles**: there the 30 MB byte limits are the
  ceiling, and 200:1 would refuse a legitimate file of zeroes (a deflate stream cannot expand more than about 1000:1 anyway).
- **A bundle is unpacked into a folder of its own first** (`data/skills/.staging-<uuid>`), so a bundle that is refused leaves nothing behind and the skill of the user is
  only replaced when the bundle is good. The staging folder is **inside** `data/skills/` (Lumen never writes next to it) and its name is not a skill name, so it is never
  listed; a folder of it that a crash left behind is swept away at the next start (`skills.sweepStaging()`). A bundle whose `SKILL.md` sits in a folder of its own is
  accepted (the folder is unwrapped).
- **An upload that replaces a skill says so.** The dialog asks first ("There is already a skill called X. This upload replaces it: its N files (…) are removed…") and
  the server is careful: the old folder is **moved aside** (`<name>.old-<uuid>`) and only deleted when the new folder is in place — a bundle that fails on the way puts
  the old skill back.
- **The name is a folder name**, so it must match `^[a-z0-9][a-z0-9_-]{0,39}$` — no slashes, no dots, no `..`, no spaces, at most 40 characters. A path inside a skill may
  not be absolute, may not hold `..`, and **a symlink is never used** — not the file itself and not a folder on the way to it. Every path is held against the **real
  path of `data/skills/`** (not against the folder of the skill, which may itself be a symlink) and every segment of the path is checked with `lstat` on **every**
  path of a skill — the read, the write, the delete and the copy — so a symlinked folder inside a skill cannot redirect a write or a delete out of it, and a skill
  folder that is a symlink to a folder outside is not a skill at all: nothing is read from it, nothing is written into it, and the starter skills are not copied into it.
- **The tools are read-only.** `use_skill` returns the body of the `SKILL.md` and the list of the files; `read_skill_file` returns one text file (at most 1 MB **of
  bytes**, counted with `Buffer.byteLength` — the file is cut off on the disk, not read whole — and the answer says that it was cut off). Neither writes, deletes nor
  runs anything. A skill that is switched off is refused by both and is not in the system prompt.
- **The system prompt** lists only the enabled skills, with their names and their one-line description, and the block says that the text of a skill is material the user
  installed on this computer — not an instruction of Lumen. A **Temporary chat still sends the enabled skills to the model**, the same way it sends the files of a
  project: the invariant of section 2 covers the **memory** only, and a skill is not memory.
- **The starter skills** are copied into `data/skills/` on the first run and are **never overwritten** (the user may have edited them). A starter that the user
  **deleted** stays deleted: the name keeps a tombstone in the settings (`settings.skills[name].removed = true`, and `enabled = false`), `ensureStarters()` skips it
  and the list of the skills does not show it. A new skill with the same name clears the tombstone. The **copy** is proved like every other write of a skill: the
  target of every starter file is held against the real path of `data/skills/` and every segment of it is checked. A starter file whose target is a symlink is
  **refused on its own** (it is not written through the symlink) and the rest of the starter is still installed; when the `SKILL.md` itself cannot be proved, the
  whole starter is refused, because a folder without a `SKILL.md` is not a skill.
- **The skills server appears only while a skill is switched on** (like the web server, which appears when the web tools are on). With every skill off, Lumen sends
  no skills tool to the model at all and the server is not in the list of the servers.
- **The built-in Skills server changes what the earlier steps' tests see.** It is in the list of the servers (`GET /api/mcp`) **while at least one skill is
  switched on** — with every skill off it is not there at all (see the bullet above), so the list of the servers is as it was before, and the header badge counts
  2 tools more while the server is there. Three assertions of the earlier steps were therefore changed (the same run on the base commit
  `f8c05f7` is green without them): `tests/step5-styles-memory.js` — "Normal adds nothing" now asks that the *style* adds no text (the skills block is in the
  prompt); `tests/step6-mcp-tools.js` — the test server is looked up by its name and not by its place in the list, and the badge is 3 + 2 = 5;
  `tests/step7-desktop-polish.js` — the web server is looked up by its id (`builtin`), because the Skills server is built in as well.
- **A model with a skill in its prompt asks to use it — and a test has to answer.** `tests/step4-thinking-branches.js` asks "Explain step by step why the sky
  appears blue."; with the starter skill `explain` in the system prompt the model asks for that skill instead of answering, and the turn waits for the approval
  card. The test now answers the card ("Allow once") and waits for the turn to be over (`finishTurn()`), exactly like a user would. The assertions about the
  thinking block did not change: the message that carries the thinking is the one with the tool call, and its block is closed and timed as before.
- **Traps in the tests** (worth knowing for the later steps): the CDP harness answers with a truthy `"EXC …"` string when the page throws, so a boolean check has to be
  compared with `=== true` (the step-10 test has a `t()` helper for that); `fetch` refuses a body on `GET` (the test helper must not send one); and a test must not crash
  when the route does not exist yet — it has to report a failure and keep going.
- Not covered by the tests: a skill whose name is `upload` (it works: only `POST /api/skills/upload` is the upload route, the other verbs take the name as it is),
  and the real drag-and-drop of the file picker (the test sets the files of the input).

**Fix round 1** (the review of the first commit; the changes are in the commit after `afc421a`):

- **A deleted starter does not come back.** The delete leaves a tombstone in the settings (`removed: true`, `enabled: false`) and `ensureStarters()` skips it, so a
  starter that the user deleted stays deleted — and stays off — after a restart. A starter that the user only **edited** is still there after a restart.
  (`tests/step10-skills.js`: "a deleted starter does not come back after a restart", "an edited starter is still there after a restart". The test starts a second
  Lumen with the same data folder — the code path of a restart.)
- **An upload that replaces a skill says so, and it does not destroy the old skill on the way.** The dialog warns (and can be cancelled); the server moves the old
  folder aside and deletes it only when the new folder is in place.
- **The containment is against the real path of `data/skills/`**, and every segment of a path is checked with `lstat` on the write and the delete path. A skill folder
  that is a symlink to a folder outside is not a skill, and a symlinked folder inside a skill cannot redirect a write or a delete.
- **The read cap counts bytes**, not characters, and a file that is too big is cut off on the disk.
- **The skills server is hidden when no skill is on**, so the model gets no useless tool definitions.
- **The staging folder of an upload is inside `data/skills/`**, and a leftover of a crash is swept away at the start.
- The tests grew: the deleted/edited starter over a restart, the upload that replaces a skill, the symlinked skill folder and the symlinked subfolder, the read cap,
  the hidden server, the staging folder, a zip whose `SKILL.md` is in a subfolder, and `DELETE /api/skills/:name/files` in the list of the cross-site requests. Two
  assertions that proved nothing were replaced: "use_skill does not run anything" now compares the folder of the skill (size, mtime and hash of every file) before
  and after the call, and the assertion about the model is now "the model called a tool named use_skill" (what it actually proves).
- `tests/step4-thinking-branches.js` waits for the **reply of the assistant** before it checks that there is no reasoning block (before that, the last message could be
  the one of the user and the assertion proved nothing).
- The CDP harness answers a pending approval card like a user would ("Allow once") and waits for the turn to be over (`tests/lib/cdplib.js`, `finishTurn()` and `ask()`), and it
  waits for a message whose role is **assistant** and whose content is not empty. A skill in the system prompt can make the model ask to use a skill, and the turn then waits
  for the card: step 3 was the next step that hung on it, and it uses the harness now. The assertions of the earlier steps did not change.
- The skills API is also called **from the page itself** (the browser's own `fetch`, with the browser's own Host/Origin/Sec-Fetch-Site headers), so `guard()` is exercised the
  way a request of the user goes through it. The other calls of the test come from Node with the headers a browser sends.

**Fix round 2** (the review of the fix round 1; the changes are in the commit after `2c9ffa2`):

- **Every path of a skill is contained — the read, the write, the delete and the copy.** The folder of the skill is a path too: `skills.skillFolder()` (in
  `skills.js`) is the one place that proves it. A skill folder that is a symlink is refused (`"A symlink is not used"`), and the real path of the folder must be
  inside the real path of `data/skills/`. `read()` (the `GET /api/skills/:name`), `update()` (`PUT`), `create()` (`POST`), `remove()`, `addFile()`, `removeFile()`,
  `extract()` and `mustExist()` (the tools of the model) all go through it, and so do `list()` and `anyEnabled()`, which skip a symlinked folder.
- **A `SKILL.md` that is a symlink is never written** (`skills.skillMdPath()`): the write would follow it out of the folder of the skill.
- **A name that is not there is not trusted because it does not exist.** `create()` proves the parent (the folder of the skills) and refuses the name itself when
  it is a symlink; a folder that is made is proved again before the `SKILL.md` is written into it.
- **The starter skills are not copied into a symlinked folder** (`ensureStarters()`): the folder is proved before the copy, and a folder that is a symlink is
  left alone.
- **The backup of a replaced skill is swept away at the start** (`sweepStaging()`): the old folder of a skill is moved aside as `<name>.old-<uuid>` while a bundle
  replaces it, and a crash in between leaves that folder behind. If the skill is there, the backup is a leftover and goes; if the skill is not there, the backup
  **is** the skill and it is put back. The sweep runs **before** the starter skills are installed, so a skill that was put back is not overwritten by a starter.
- **A Temporary chat still sends the enabled skills to the model**, the same way it sends the files of a project. The invariant of section 2 covers the
  **memory** only, and a skill is not memory. The sentence is in `README.md` (the skills bullet) and in the step-10 notes above.
- The sentence "it is always in the list of the servers" was wrong (the Skills server is hidden while no skill is on) and now agrees with the code.

**Fix round 3** (the re-review of the fix round 2; the changes are in the commit after `ed5f412`):

- **The copy of a starter is proved like every other write of a skill** (`ensureStarters()` in `skills.js`). The source of the copy is ours (`starter-skills/`), the
  target is not: the target of every starter file is now held against the real path of `data/skills/` with `safeInside()`, so every segment of it is checked and a
  symlink in the way is refused. **A starter file whose target is a symlink is refused on its own** (it is not written through the symlink) and the rest of the
  starter is still installed; when the `SKILL.md` itself cannot be proved, the **whole starter is refused**, because a folder without a `SKILL.md` is not a skill.
- **The sweep only puts back a folder that is a skill** (`sweepStaging()`): a backup `<name>.old-<uuid>` that is a symlink (or that is not a real folder) is **not
  restored — it is deleted as a link**, and the folder it points at is never touched. A backup that is put back is proved with `skillFolder()` first: it must be a
  real folder inside the real path of `data/skills/`, or the name is put back as it was and nothing is restored.
- **A refusal is a refusal, not a crash of the file system.** `safeInside()` refuses a path whose folder on the way is not a folder ("That path is not a folder"),
  and `addFile()` refuses a target that is a folder ("That path is a folder, not a file"), instead of letting the file system answer with `EEXIST` or `EISDIR`.
- **A name that is not a name is a 400** (`server.js`): a broken escape in the URL (`/api/skills/%`) is refused with a message, not with a 500.

### Step 11: Side Chat and Split View
- **Side Chat:** right panel with its own thread seeded with a snapshot of the main conversation ("answer briefly; this is a side question"); never modifies the main chat;
  "Insert into chat" button; shortcut.
- **Split View:** second pane is an `<iframe src="/?embed=1&chat=ID">` of Lumen itself (same origin, separate JS state, shared server data). Add an `embed` mode (no sidebar, compact header)
  and cross-pane refresh over `BroadcastChannel`. This avoids refactoring the global state in `app.js`. Side Chat can reuse the same embed mechanism.
- Tests: two panes stream independently; side chat leaves main messages unchanged; insert works; embed mode layout; sidebar refresh across panes.

**Done** on branch `step-11-side-split` (tests: `tests/step11-side-split.js` — 115 assertions; `tests/run.sh 11`).
Handoff notes:

- **New file:** `public/features/splitview.js` (the whole feature: the embed mode, the channel, the side chat, the split view).
  `public/index.html` grew the two panels (`#sidePane` with `#sideFrame`, `#splitPane` with `#splitFrame`), the two header buttons
  (`#sideChatBtn`, `#splitBtn`) and the script tag; `public/style.css` grew the rules of the panels and of the embed mode.
  `server.js` was **not** touched: there is no new route, nothing new is exposed.
- **The embed pane is Lumen itself and it is not sandboxed.** `#sideFrame` and `#splitFrame` have **no `sandbox` attribute at all**
  (the sandbox flag that would give a frame the origin of the app does not appear anywhere in the diff). The pane is a full user of the app: it sends messages, it uses
  tools, it approves tool calls. The artifact preview is a different element (`#artFrame`) and keeps its own sandbox
  (`sandbox="allow-scripts allow-forms"`, an opaque origin) — the step-2 tests still pass unweakened.
- **The embed mode is a mode of the same page**, not a second app: `?embed=1` puts the class `embed` on `<body>` (no sidebar, a compact
  header) and `?chat=ID` opens that chat. There is no `app-embed.js` and no second copy of the app. The mode is known to `app.js`
  itself (`const isEmbed`), so the feature scripts and the app agree on it — one source of truth.
- **A pane keeps the chat of its own address.** The pane opens the chat of the query string and nothing else, so the "continue the last
  chat" switch and the restored chat tabs of the app cannot drag the pane to another conversation. The user can still point the pane at
  another chat with the picker in the compact header, and the command palette hides the chats of the user in a pane.
- **A chat that does not exist does not break a pane:** `?chat=ID` with an unknown id falls back to a new chat and the normal empty state.
- **The side chat is a chat record of its own** (`POST /api/chats` with the seed as its first message) and it never writes to the main chat.
  The only way into the main chat is the "Insert into chat" button: it adds a **message of the user** with the marker
  `[Side chat] <title>` and lets the normal `persist()` save it — no new route, no direct write into the store.
- **The snapshot is bounded and says so.** The seed holds the last 20 messages of the main chat (oldest first) and at most 20,000 characters
  in all; the cap is written into the seed itself ("at most 20 messages and 20,000 characters go into the snapshot … 12 of 20 messages and
  18,675 of 20,000 characters are shown here"), between `--- begin snapshot ---` and `--- end snapshot ---`. The head of the seed and the two
  markers are measured before the body is cut, so the seed can never be longer than the cap.
- **One BroadcastChannel for the whole app** (`lumen`). A window posts `{type:'sync', chat, list}` when the messages of a chat changed and/or
  the list of the chats changed. The fingerprint of the list is order-independent, so a window that refreshes because of another window
  does not post about that refresh — the panes cannot spin (the test watches the counter of the received messages and the counter of the
  posts). A browser without `BroadcastChannel` has no cross-pane refresh and no error. A lone pane behaves exactly as before.
- **The side chat is named "Side chat — <title of the main chat>"** and is marked as named (`titled`), so the model does not give it a title of its own.
- The temporary-chat rule is inherited by the panes (they are the same app): the memory is never used and nothing is saved in a temporary chat.

Fix round 1 (same branch, second and third commit):
- **The second pane of the split view is `/?embed=1&chat=ID` with a real chat id** (the plan's own mechanism, honoured literally). When the
  split view opens, the main window picks the **most recent** chat of the user that no other window has open and puts its id in the `src`
  (the list of the server puts the pinned chats first, so the order of the list is not the order of the chats — the stamp decides); the picker
  of the pane can point it at another chat. Two panes on one chat cannot work: `PUT /api/chats/:id` replaces the whole list of the messages, so
  two panes that write the same chat take each other's messages away.
- **Two windows are never on the same chat.** Every window has an id (`main`, or `pane-<random>`) and announces the chat it has open over the
  channel (`{type:'pane', id, chat}`) when it starts and whenever its chat changes. A window that hears an id it does not know answers once
  with its own announcement (the answer is not answered again — no loop). A **pane** that learns that another window has the chat it has
  open moves away (it opens a new empty chat and stops writing to that chat); the **main window never moves away** — the user clicking a
  chat in the sidebar must not be undone. A pane **refuses** to open a chat that another window has open (its picker does not offer it, and
  the open path refuses it even when the id is forced), and its picker leaves out the chats of **all** the other windows, not only the
  main one's. A chat that the main window makes by writing in it (such a chat gets its id only when it is saved) is announced too.
- **A pane that refreshes because of another window does not post about that refresh — the post is dropped, not queued.** The signature of
  the list is still updated, so the next real change compares against a fresh baseline. A local change that lands inside such a window loses
  its list post; the next event re-syncs the list.
- **The feature does not replace a function of `app.js` any more.** `app.js` grew four additive hooks — `onChatsRender` (after the list of
  the chats is rendered), `onPersist` (after a chat was saved), `beforeOpenChat` (`(id) => false` refuses to open that chat) and `onPalette`
  (the items of the command palette) — and `splitview.js` uses only those. The four hooks are `if (hooks.x)` with a `null` default, so
  nothing else in the app changes; the hooks that were there before (`onOpenChat`, `onNewChat`) are chained, never replaced.
- **The panes share the localStorage of the app** (the model, the chat tabs), so the tab strip of a pane could make the next reload of the
  main window come back on the chat of the pane. In the embed mode the tab strip is now neither saved nor restored nor shown (`isEmbed` in
  `app.js`; the tab strip is hidden by the rules of the embed mode in `style.css`).
- **The server stamps the chats with a monotonic clock** (`stamp.js`, the third commit of this round): the stamps are strictly increasing,
  so two chats made in the same millisecond never tie and "continue last chat" always opens the chat that was updated last. The clock is
  exported and the test drives it directly (1000 calls in a tight loop must give 1000 strictly increasing values).
- The tests of the step were widened: the panes that do not spin is now a real change in one window (a new chat) with the two halves the
  old test was missing (the other window receives **exactly one** message and does **not** post back), the sidebar of the pane is checked
  for the title of the new chat, the model of the pane is checked against the model the test asked for, the embed mode is checked with
  `getComputedStyle` instead of a comparison of the header's HTML, a reload of the main window after a side chat was opened does not land
  on the side chat, and the seed of the side chat is checked against the numbers it says about itself.

Fix round 2 (same branch, fourth commit — `splitview.js` and its test only):
- **A pane does not act before it knows.** Before a pane opens the chat of its address it claims it (`{type:'pane', claim}`) and runs
  a "who has what" round (`{type:'who'}` answered by `{type:'has', to}`), bounded at 400 ms so a lone pane still comes up. A chat
  that another window has open **or has claimed** is taken; the pane then starts empty and says "Another window has this chat".
  The main window runs the same round before it hands a chat to a new pane, and never hands out a chat it already gave to one of its frames.
- **One resolution for a conflict both sides reach at once:** the main window always keeps the chat; between two panes the smaller id keeps it.
  The side that keeps it announces again, so the other side gives it up.
- **A pane that gave a chat up forgets it:** its address goes back to `/?embed=1` (`history.replaceState`) and the main window resets the
  `src` of that frame, so a reloaded pane cannot take the chat back; the reloaded pane says why it is empty.
- **The pane that moves away leaves no empty chat in the store:** the empty state after a move-away is temporary until the user types
  or sends (a 2 s backstop lifts it), so the aborted turn of the pane does not save a "New Chat" with no messages.
- **What the user typed while the pane was opening is kept** (it is appended to the opened chat, or the pane keeps its own chat if the user already wrote).
- **The panes come back after a reload of the main window:** the chat of each frame is kept in `localStorage` under the id of the browser
  tab (`sessionStorage` `lumen.win`), so two tabs of the app do not fight over the same frames; closing a pane forgets it and announces that its window is gone.
- Two test fixes found on the full run: the harness waits for the pinned model to be listed before it picks it (the first page of a fresh
  server waits for Ollama's capabilities of every model, which can take longer than the old fixed 1.5 s), and step 1 uses the pinned
  `LUMEN_TEST_MODEL` when it has vision instead of the first vision model listed (that was the cloud model, so the prompt left the machine
  despite the pin — and the cloud model returned an empty answer).

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

**Done** on branch `step-12-workspace` (tests: `tests/step12-workspace.js` — 143 assertions, one skipped when `~/.ssh` does not exist; `tests/run.sh 12`).
Handoff notes:
- **New files:** `workspace.js` (the server side: folder validation, containment, the tools, the snapshots, the shell runner, the approval
  tokens) and `public/features/workspace.js` (the bar, the dialog, the Changes and Terminal pane, the badge, the task notices).
  `server.js` grew `/api/workspace/*`, the `workspace` built-in server and the scheduler; `package.json` grew `diff`.
- **`app.js` grew five additive hooks:** `toolServer(srv)` (false keeps a server's tools from the model — the workspace tools only go out
  when the chat has a folder), `toolPolicy(call, chat)` (returns `{auto}`, `{ask, noAlways, preview, previewKind, body}` or `{error}`;
  `body` is merged into the `/api/mcp/call` request), `onAwait(call, chat, waiting)`, `onCancelTools()` and `onToolResult(call, chat)`.
  The approval card shows `call.preview` and hides "Always allow" when `call.noAlways`.
- **Where the workspace of a chat lives:** `settings.workspace.chats[chatId] = {folder, mode}`; a temporary chat (and a chat that is not
  saved yet) uses a page-made id (`tmp-…`) kept only in the server's memory. A new chat is saved before its first workspace call, so its
  changes are filed under its own id. A chat without a folder of its own gets the folder of its project (`settings.workspace.projects`)
  in the Ask mode. A folder that is no longer trusted gives no access, whatever a chat says.
- **The approval token** (`POST /api/workspace/preview`) is the server-side half of the approval: an edit in the Ask mode and every
  command only run with a token bound to the session, the tool, the exact arguments (a hash) and, for an edit, the file's hash at
  preview time; it is good once, for ten minutes. In Auto-edit the page still passes the token of the preview, so the file-hash check
  holds there too. This guards against page bugs and replays — not against a script in Lumen's own page (same rights as the user).
- **"Always allow" lives in the browser** (`localStorage`), so the server cannot see it. A scheduled task therefore carries its own
  `allowTools` list (picked in the dialog from the browser's always-allow set). The server drops `workspace/fs_write`, `fs_edit` and
  `shell` from it, and the headless call path refuses them again.
- **Shell:** `/bin/sh -c` with `detached: true` (its own process group; Stop and the timeout kill `-pid`, SIGTERM then SIGKILL after 2 s);
  environment = the server's minus a deny-list (names with KEY/TOKEN/SECRET/PASSWORD/AUTH/SESSION/…, prefixes ANTHROPIC_/OPENAI_/AWS_/GH_/
  GITHUB_/SSH_/GPG_/LUMEN_/OLLAMA_ …); output kept to 100 KB (the command keeps running; the rest is dropped); the model may lower the
  timeout (`timeout_seconds`, 1–120). The Terminal pane polls `GET /api/workspace/runs/:chat` every 500 ms while a command runs.
- **Scheduler:** a 5 s tick in the server; an interval task first runs one interval after it is made. It calls Ollama without streaming,
  with up to 8 tool rounds, and stores the answer as a new chat `Scheduled: <name>`. The page polls `GET /api/workspace` every 15 s and
  shows a toast (and a notification when hidden) for a new run.
- Not covered by the tests: a real network mount (the check is tested with a fake mount list), a real browser notification (the test fakes
  `Notification` and `document.hidden`), the daily schedule firing at its time (only the interval one is waited for).

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
