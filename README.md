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
- Safe markdown rendering (code blocks with copy, lists, tables, quotes)

## API

| Route | Purpose |
|---|---|
| `GET /api/models` | models from Ollama |
| `POST /api/chat` | streaming NDJSON proxy to Ollama `/api/chat` |
| `GET/POST/DELETE /api/chats` | list (`?q=` search) / create / delete all |
| `GET/PUT/DELETE /api/chats/:id` | read / update / delete |
| `GET /api/chats/export` | download all chats |
