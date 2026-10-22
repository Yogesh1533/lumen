# Lumen

A self-hosted chat UI for local LLMs, in the spirit of Open WebUI. Zero dependencies: a ~150-line Node server and a vanilla JS frontend, talking to [Ollama](https://ollama.com).

The UI layout and API shape were derived from observing a running Open WebUI instance with the REA reverse-engineering MCP. No Open WebUI code or branding is used.

## Run

```bash
ollama serve            # if not already running
node server.js          # http://localhost:3100
```

Needs **Node 22+** (22 is the current LTS; Node 18 and 20 are end-of-life).

Env vars: `PORT` (3100), `OLLAMA_BASE_URL` (http://127.0.0.1:11434), `LUMEN_DATA` (data/chats.json).

## Features

- Streaming chat with stop, regenerate, edit-and-resend, delete, copy
- Model picker populated from Ollama; shows reasoning (`thinking`) streams
- Chat history: search, pin, rename, delete, grouped by date, JSON export
- Controls panel: system prompt, temperature, top-p, context length, max tokens
- Temporary chats (not saved), suggested prompts, light/dark theme, mobile layout
- Attachments: drag/drop, paste, or pick images (sent to vision models), PDFs and text/code files (inlined as context)
- Artifacts: HTML, SVG and Markdown code blocks open in a side panel (Preview/Code tabs, version stepping, copy, download). Previews run in a sandboxed iframe with an opaque origin, so generated scripts cannot reach the app, its API or your chats
- Projects: group chats under a project with its own instructions and knowledge files (text, code, PDF). Both are added to every chat's system prompt, and the context window grows automatically to fit (up to 32k). Chats outside a project never see its knowledge. Deleting a project keeps its chats
- Thinking: reasoning models get a collapsible "Thinking…" block with a live timer ("Thought for 2.3s" once done) and a header toggle to switch thinking off
- Edit and regenerate keep every version: edit any of your messages inline, or regenerate a reply, and flip between versions with `‹ 1/2 ›`. Branches are saved with the chat
- Auto titles: chats are named by the model after the first exchange (rename a chat to keep your own title)
- Styles: Concise / Explanatory / Formal / Friendly presets plus your own custom styles, chosen per chat from the header
- Memory (🧠 in the sidebar): facts the assistant carries into every chat. Add them by hand, with the Remember button on a message, or by typing "Remember that …". Memory is never used or saved in Temporary chats, and can be switched off
- Tools via MCP (🔧 Tools in the header): connect Model Context Protocol servers (a local command, or a remote Streamable-HTTP URL) and let tool-capable models call them. Every call shows an approval card (Allow once / Always allow / Deny); results appear in the chat and are fed back to the model, for up to 8 rounds per turn. Stop cancels a pending approval
- Import from Claude Desktop (🔧 Tools → Import from Claude): Lumen reads Claude's config (read-only) and shows a review dialog with the servers it finds — their command, their arguments and their environment variables (values masked). You add each one yourself, with the same trust question as any other server; nothing is ever added automatically, and a server that is already in Lumen is marked as such. An imported server goes through the same limits as one you add by hand (a name of at most 40 characters, at most 50 arguments, a `http(s)` URL)
- Extensions: upload a `.mcpb`/`.dxt` bundle, or import one of Claude Desktop's own extensions (by reference — its files are never copied or changed). Lumen unpacks the bundle, reads its `manifest.json` and asks for the settings it declares (a text, a number, a folder, a file, a switch; a list that is not a secret starts with the default of the manifest; secret fields are password fields and their values never enter the page). The placeholders `${__dirname}`, `${HOME}` and `${user_config.…}` are filled in, the command that will run is shown to you, and only after you agree does the extension start like any other MCP server
- A switch per tool (🔧 Tools): switch a tool off and it is no longer sent to the model, and the server refuses to run it. The switches are Lumen's own — Claude's toggles are never read. Two switches in a row do not lose one another: the page keeps the state of the switches per server
- Skills (🧩 Skills in the header): a skill is a folder with a `SKILL.md` — a name, a one-line description and the instructions for the model — plus files of its own. Write one by hand, upload a zip, or add loose files, and switch it on and off. The enabled skills (their names and descriptions only) go into the system prompt, and the model loads one with the built-in tools `use_skill` and `read_skill_file` — both read-only, and both asking for your approval first, like any other tool. A Temporary chat sends the enabled skills to the model too, the same way it sends the files of a project: the rule that a Temporary chat keeps nothing covers the memory only, and a skill is not memory. The two tools only exist while at least one skill is switched on. Two skills ship with Lumen: `summarise` and `explain`. They are on from the start, so a question that matches one of them makes the model ask to use it (switch a skill off in the dialog, or switch off the "ask before a skill is used" for its tool, if you would rather not be asked). Deleting a skill is final: a starter skill you delete does not come back at the next start. An upload with the name of a skill that is already there replaces it — the dialog says what is lost before it does
- MCP log viewer: the ≡ button on a server shows its last output (the last 200 lines of stderr, with the secret values scrubbed), and "Reload all" starts every server again
- Command palette (Ctrl/Cmd+K) to jump to any chat (across projects), switch model/style/project, or run any action; shortcuts: Ctrl/Cmd+Shift+O new chat, Ctrl/Cmd+B sidebar, Ctrl/Cmd+/ help, Esc stops a running reply
- Web access (off by default, 🔧 Tools → Web access): built-in `fetch_page` (public pages only; private/local addresses are blocked) and `web_search` via your own SearXNG instance or the Brave Search API. Every call still needs approval
- Voice dictation (🎤): uses the browser's speech recognition and asks for consent first, because Chrome/Edge send the audio to the vendor's servers
- Installable: `npm run app` opens Lumen in its own window (Chrome/Edge/Brave/Chromium, starts and stops the server for you), or use "Install app" in the browser (web manifest included)
- Usage (📊 Usage in the header): every reply keeps Ollama's token counters, the status line shows tokens/s, and the usage dialog totals them per model and per day. Cloud models (`:cloud`) are marked ☁
- Read aloud: a "Read aloud" button on every reply (markdown stripped), a stop control, a voice picker and an optional auto-read switch in the Controls panel
- Find in conversation (Ctrl/Cmd+F): a find bar with match count, next/previous and highlights; Esc closes it
- Export: download a chat as Markdown (optionally with thinking and tool calls), copy it as Markdown, or print it to PDF (a print stylesheet hides the app chrome)
- Chat tabs: a tab strip over the open chats, next/previous tab, reopen the last closed tab (Ctrl/Cmd+Shift+T), and a "Continue last chat when Lumen starts" switch (it opens the chat that was updated last); the open tabs are remembered across reloads
- Side chat (💬 Side chat, Ctrl/Cmd+Alt+S): a panel of its own asks a side question in a thread of its own, seeded with a snapshot of the main conversation (the last 20 messages, oldest first, at most 20,000 characters — the cap is written into the seed) and the instruction to answer briefly. The side chat is a chat record of its own and never writes to the main chat; "Insert into chat" puts the answer into the main chat as your own message, marked with "[Side chat] <title>"
- Split view (▣ Split, Ctrl/Cmd+Alt+P): a second pane of Lumen itself — the same app in an embed mode (no sidebar, a compact header, a picker for the chat of the pane), in an iframe of the same origin without a sandbox, so the pane is a full user of the app: it sends messages, uses tools and approves them. The panes tell each other over a BroadcastChannel: a chat that is created, renamed or deleted in one pane shows up in the sidebar of the other, without a reload
- Try another model: regenerate a reply with a different model (the old answer stays as another version), or compare two models side by side in the ⚖ dialog and keep the answer you prefer
- Troubleshooting (🧠 → Troubleshooting…): the server's own log lines, a diagnostic report (versions, data folder, Ollama reachability and model list — never chat content) and a copy button for bug reports. The log shows the status of the MCP servers, never their output — that stays in the Tools dialog
- Safe markdown rendering (code blocks with copy, lists, tables, quotes)

## API

| Route | Purpose |
|---|---|
| `GET /api/models` | models from Ollama |
| `POST /api/chat` | streaming NDJSON proxy to Ollama `/api/chat` |
| `GET/POST/DELETE /api/chats` | list (`?q=` search) / create / delete all |
| `GET/PUT/DELETE /api/chats/:id` | read / update / delete |
| `GET /api/chats/export` | download all chats |
| `GET /api/usage` | token usage per model and per day (aggregated from the saved chats) |
| `GET /api/logs` | the server's own recent log lines |
| `GET /api/diagnostics` | diagnostic report (versions, paths, Ollama status — no chat content) |
| `GET /api/claude/config` | the MCP servers of Claude Desktop (read-only; env values masked) |
| `POST /api/claude/import` | add one server of Claude's config (needs `confirm: true`) |
| `GET /api/claude/extensions` | the extensions Claude Desktop has installed |
| `POST /api/claude/extensions` | unpack an uploaded `.mcpb`/`.dxt` bundle and read its manifest |
| `POST /api/claude/extensions/preview` | the command an extension would run, with the secret values masked (shown before the install) |
| `POST /api/claude/extensions/install` | install an extension as an MCP server (needs `confirm: true`) |
| `GET /api/mcp/:id/logs` | the last stderr lines of a server |
| `POST /api/mcp/reload` | start every enabled server again |
| `PUT /api/mcp/:id/tools` | switch the tools of a server on or off |
| `PUT /api/mcp/:id/env` | replace or remove one environment value (the old value is never sent back) |
| `GET /api/skills` | the skills of this computer, with their files, and the limits that apply |
| `POST /api/skills` | create a skill (a name and a `SKILL.md`) |
| `GET/PUT/DELETE /api/skills/:name` | read a skill / edit its `SKILL.md` or switch it on and off / delete it |
| `POST /api/skills/upload` | upload a zip as a skill |
| `POST /api/skills/:name/files` | add one file to a skill |
| `DELETE /api/skills/:name/files?path=` | remove one file of a skill |

## Security notes

- Lumen listens on `127.0.0.1` only and has no login: anyone who can reach that port on this computer can use it.
- MCP servers are programs that run as you. Only add servers you trust. Their config (including any environment variables you enter, such as API keys) is stored in plain text in `data/settings.json`.
- Claude Desktop's config is only ever read — Lumen never writes in Claude's folders. An imported server or extension is never added without your confirmation, and a tool is never approved for you.
- Environment values are secrets: the browser only gets the keys and a mask (`••••1234`), and a value can only be replaced, never read back. The command, the arguments and the URL are scrubbed of secret values as well — and so is the output of a server, in the list and in the log viewer.
- An uploaded extension bundle is treated as hostile input: paths that escape the folder, symlinks, encrypted entries and oversized bundles are refused (2000 files, 50 MB in total, 20 MB per file, 20 MB per upload). The limits are checked on the bytes that are really produced, not on the sizes the bundle claims, so a bundle that lies in its directory is refused as well. Every refusal names the limit that fired, and a bundle with a broken compressed stream is reported as broken — not as a file that is too big.
- Because Lumen can launch programs, the API rejects cross-site requests (mismatched `Origin`, `Sec-Fetch-Site: cross-site`, non-JSON bodies) and unexpected `Host` headers (DNS rebinding), so a web page you visit cannot drive it.
- Tool calls always need your approval unless you chose "Always allow" for that exact tool (revoke in 🔧 Tools).
- A skill is text you installed on this computer. The skills tools only read: they never write, delete or run anything. Every path of a skill — the read, the write, the delete and the copy — is held against the real path of the folder of the skills, and every segment of it is checked: a path that would leave that folder (a `..`, an absolute path, a symlink in the way, a skill folder that is a symlink to a folder outside) is refused, and nothing is ever written into a folder outside it. The copy of a starter skill is proved the same way: a starter file whose target is a symlink is not written through it, and the rest of the starter is still installed. The content of a `SKILL.md` is marked in the system prompt as your material, not as an instruction of Lumen. A skill folder is at most 30 MB, however it arrives (a zip, a loose file, a hand-written `SKILL.md`), and the limit is checked on the bytes that are really produced, not on the sizes a bundle claims. `read_skill_file` returns at most 1 MB of a file (the bytes, not the characters) and says that it cut it off. The skills tools ask for approval like every other tool; the switch in the Skills dialog only writes "always allow" for that one exact tool, into the same store as the "Always allow" button.
- Artifact previews are sandboxed with an opaque origin and cannot reach the API or your chats.
- The second pane of the split view and the side chat are Lumen itself (the same origin, the same rights as the window you are in — they are not sandboxed, and they can use the API). Only the artifact preview is kept apart.
- Web pages and search results are untrusted text that the model will read. Keep tool approval on, and be wary of approving other tools right after a model has read a page you don't trust. A Brave API key is stored in plain text in `data/settings.json` (never sent back to the browser).
- Dictation is not local: see above.

## Development

- Tests: `npm test` (or `tests/run.sh 1 5`) drives a throwaway server in Chrome over CDP. Pin a local model with `LUMEN_TEST_MODEL=gemma4:latest` so test prompts stay off cloud models.
- Roadmap and handoff notes for continuing the project: [docs/ROADMAP.md](docs/ROADMAP.md).
