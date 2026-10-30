# Prophey

Electron + React desktop client with four interchangeable engines: Prophey, pi,
Claude Code and Codex. Shared capabilities describe each engine's commands,
models, compaction, permissions and session ownership. Protocol details stay in
adapters; the desktop owns projects, session navigation and UI.

## Features

- Project-grouped session sidebar with per-project search and status filters
- Streaming chat, tool cards, Markdown, thinking blocks, abort/queue
- Paste or drop images into the composer; images are sent to the model and stay viewable in the transcript
- Model picker and model allow-list per provider
- Provider login (OAuth / API key), custom providers via `models.json`
- Light and dark themes
- Conversation outline and user-message timeline
- Session panel (right-hand inspector): environment, context usage, MCP connectors, files the session wrote, and background commands with stop buttons
- Sessions stored in pi's own `~/.pi/agent/sessions` tree, shared with the pi CLI/TUI
- Four engines: Prophey provider loop, pi RPC, Claude Agent SDK and Codex app-server
- Capability-driven slash commands, native compaction, model selection and approval dialogs
- Native questions from every engine: Claude Code's `AskUserQuestion`, Codex's `request_user_input` and pi/Prophey's desktop tool all use the same panel above the composer
- Multi-directory projects: one session can work across several folders, with `root`-scoped tools
- MCP settings: master switch, server list, and a built-in desktop tool
- `ask_user_question` tool: agents ask questions in a desktop dialog (single choice, multi-select, free text, answered in order)
- System proxy support (OAuth, updates, and the pi child process)
- Auto update via GitHub Releases (`electron-updater`)

## Development

Requires Node.js 24+.

```bash
npm install
npm run dev      # Electron + Vite HMR
npm start        # build and run
npm test         # contract and regression tests
npm run typecheck
npm run build
npm run test:smoke # real Electron UI + IPC with an isolated temporary profile
```

## Packaging

```bash
npm run dist     # NSIS installer in release/
npm run release  # build and publish to GitHub Releases (needs GH_TOKEN)
```

The update feed defaults to `touwaeriol/prophey`. Override it with:

```bash
PI_DESKTOP_UPDATE_REPO=owner/repo
PI_DESKTOP_UPDATE_URL=http://example.com/feed
PI_DESKTOP_RELEASES_URL=https://github.com/owner/repo/releases
```

Tagging `v*` runs `.github/workflows/release.yml`, which builds the Windows installer and publishes the GitHub Release.

## Images

Paste or drop images into the composer. Images remain attachments in a thumbnail strip; no filename or marker is inserted into the message text. Click a thumbnail to preview it or remove it before sending. Sent images are retained by the selected engine and displayed in the transcript.

Images only reach a model that declares image input. For a model you added by hand in `models.json`, tick 「支持图片」 in 设置 → 服务商 → 该模型; otherwise pi sends the text `(image omitted: model does not support images)` instead of the picture, and the desktop now refuses the send with that explanation rather than letting the screenshot vanish.

## Sessions

The default Prophey engine stores transcripts under the desktop user-data directory.
pi can use its CLI session directory or an isolated desktop profile. Claude Code and
Codex own their native sessions; the desktop keeps an engine-aware index for navigation.
Switch engines beside the composer to copy the current user, assistant and tool history
into a fresh native session, without reasoning or provider signatures. A running turn
is stopped first; the original session remains in the sidebar. Failed switches restore
the source session. See [context handoff](docs/engine-handoff.md).

See [engine compatibility](docs/engine-compatibility.md) for native capabilities and
known upstream limitations, and [the 0.5.4 audit](docs/code-review-0.5.4.md) for the
refactoring scope and validation evidence.

## MCP and the desktop question tool

Settings → MCP controls MCP support: a master switch (pi starts with `--no-mcp` when off), the server list from `~/.pi/agent/mcp.json`, and a built-in desktop tool.

The built-in tool is `mcp__desktop__ask_user_question`. It is registered by a pi extension the app loads with `--extension`, so nothing is written into `mcp.json` and terminal pi sessions are unaffected. Agents call it to ask you something: the question appears in a panel directly above the composer, supports single choice, multi-select, and free-form typing (no need to pick "other" first), and multiple questions are answered one at a time with the option to go back and change earlier answers. The answer goes back to the model as the tool result.

The pieces live in `packages/mcp-core` (stdio MCP server — the core interaction server; new desktop tools go in `packages/mcp-core/tools`), `apps/desktop/resources/extension` (pi extension that registers it), and `apps/desktop/src/main/bridge.ts` (loopback bridge between the MCP server and the window).

### Native questions from the CLI engines

Claude Code and Codex ask through their own channels, and the desktop answers them in the same panel — no extra MCP server, no prompt injected into their configs:

| Engine | Channel | Desktop handling |
| --- | --- | --- |
| Claude Code | `canUseTool` → `AskUserQuestion` | questions go to the panel; the answer comes back as `updatedInput.answers` |
| Codex | server request `item/tool/requestUserInput` | answers come back as `answers[questionId].answers` |

Codex's tool is experimental in codex-cli 0.163 and stays off unless the app turns it on, so a Codex session is started with `-c tools.experimental_request_user_input.enabled=true -c features.default_mode_request_user_input=true` (a per-launch override; `~/.codex/config.toml` is never rewritten). Settings → General → “原生提问” turns it off. Approval requests (`item/commandExecution/requestApproval`, `item/fileChange/requestApproval`, `item/permissions/requestApproval`) use the same panel with a deny/allow choice, and a missing window means deny — never a silent grant.

### Built-in engines: CodeGraph and WarpGrep

Two optional engines can be enabled per app, both used through the same extension:

| Engine | Setup | What it adds |
| --- | --- | --- |
| CodeGraph | `npm i -g @colbymchenry/codegraph` | Symbol search, call relationships, impact analysis over a project index |
| WarpGrep | Morph API key | Natural-language code search: several rounds of grep/read, then the relevant files |

The app runs a small MCP gateway in its main process — one loopback service with one endpoint per engine (`/mcp/codegraph`, `/mcp/warpgrep`) — and pi connects to those endpoints. The gateway holds the real engine (a stdio MCP server for CodeGraph, an in-process search for WarpGrep) and only lists the tools in its allowlist, so the model sees 8 CodeGraph tools and 1 WarpGrep tool instead of everything the engines offer.

CodeGraph results list symbols, signatures and `file:line` locations; source bodies are only returned when a call sets `includeSource: true`. WarpGrep returns file paths and line ranges the same way, and file excerpts read during a search are sent to the Morph API.

Of those, the core ones (`codegraph_explore/search/callers/impact`, `codebase_search`) are declared directly; the rest load on demand through `tool_search`.

### Subagents

The main agent can start subagents — separate `pi` processes that work on a task in the project — and drive them through eight desktop tools: `search_agents`, `list_models`, `start_subagent`, `get_subagent`, `wait_subagent`, `send_subagent_prompt`, `stop_subagent`, `get_subagent_changes`.

- Results are Markdown and, by default, only the final answer plus a summary of what the subagent touched. The transcript is opt-in (`include: ["messages"]`), because a running subagent's full history is the expensive thing to put in context.
- Four presets ship built in (`explorer`, `reviewer`, `tester`, `worker`) and are stored in `%APPDATA%/agent-desktop/agents.json`; every preset field can be overridden per call.
- Presets are either listed in the system prompt (`agents.exposure: "prompt"`), found through `search_agents` (`"lazy"`), or not mentioned at all (`"hidden"`). There is no loading step: a preset id works as soon as the model knows it.
- Subagents run with `--no-mcp`: they cannot ask the user questions or start further subagents.

Every built-in tool can be switched off individually in Settings → MCP; a disabled tool is registered as `hidden`, so the model never sees it. The CodeGraph index (`.codegraph/`) is built automatically when a project has none — re-indexing stays a manual action, because the running server holds the index lock.

