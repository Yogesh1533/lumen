# Lumen

A self-hosted chat UI for local LLMs, in the spirit of Open WebUI. Zero dependencies: a ~150-line Node server and a vanilla JS frontend, talking to [Ollama](https://ollama.com).

The UI layout and API shape were derived from observing a running Open WebUI instance with the REA reverse-engineering MCP. No Open WebUI code or branding is used.

## Run

```bash
ollama serve            # if not already running
node server.js          # http://localhost:3100
```

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
- Safe markdown rendering (code blocks with copy, lists, tables, quotes)

## API

| Route | Purpose |
|---|---|
| `GET /api/models` | models from Ollama |
| `POST /api/chat` | streaming NDJSON proxy to Ollama `/api/chat` |
| `GET/POST/DELETE /api/chats` | list (`?q=` search) / create / delete all |
| `GET/PUT/DELETE /api/chats/:id` | read / update / delete |
| `GET /api/chats/export` | download all chats |
