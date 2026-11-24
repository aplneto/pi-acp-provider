# pi-acp-provider

A [Pi](https://github.com/earendil-works/pi) provider extension that drives any
[Agent Client Protocol](https://agentclientprotocol.com) (ACP) agent, such as
Antigravity (`agy acp`), Codex ACP (`@agentclientprotocol/codex-acp`), GitHub
Copilot CLI, or Gemini CLI over stdio.

```
┌────────────────────────────────────────────────────────┐
│                        Pi TUI                          │
│         (Input bar, Stream Renderer, Status line)      │
└───────────────────────────▲────────────────────────────┘
                            │ Pi AssistantMessageEventStream
┌───────────────────────────▼────────────────────────────┐
│                  ACP Provider Extension                │
│  streamSimple() → ACP client (NDJSON RPC) + McpBridge  │
└───────────────────────────┼────────────────────────────┘
                            │ stdio (one process per session and agent)
┌───────────────────────────▼────────────────────────────┐
│          ACP agent (e.g. `agy acp`, `codex-acp`, …)    │
│    (Autonomous agent, built-in tools, + `pi` MCP)      │
└────────────────────────────────────────────────────────┘
```

The ACP agent runs its own autonomous loop in the session working directory and
streams progress back over ACP. When the Pi session has tools, the provider also
exposes them to the ACP agent through a session-scoped `pi` MCP server
(`mcpServers`), handing those tool calls back to Pi's agent loop so they execute
inside Pi and obey Pi's tool allowlist.

## Install

```bash
pi install npm:pi-acp-provider
```

Or from git: `pi install git:github.com/R-Dson/pi-acp-provider`.

To try it for one session without installing: `pi -e npm:pi-acp-provider`.

## Configuration

Declare agents under `acp.agents` in `~/.pi/agent/settings.json` (or
`$PI_CODING_AGENT_DIR/settings.json`). Each key becomes a model:
`/model acp/<key>`.

```json
{
  "acp": {
    "autoApproveTools": false,
    "agents": {
      "antigravity": { "name": "Google Antigravity", "command": "agy", "args": ["acp"] },
      "codex": { "name": "Codex", "command": "codex-acp", "args": [] }
    }
  }
}
```

Check each agent's documentation for the flag that starts its ACP mode. With no
agents configured, Pi shows a warning at startup and the provider has no models.

### Models and thinking level

Models are discovered automatically. When Pi refreshes its model list (at
interactive startup and whenever `/model` opens), each agent is started and an
ACP session is opened to read the models it offers. They show up as
`acp/<key>/<model id>`, e.g. `/model acp/antigravity/gemini-4-neon`.
`acp/<key>` keeps the agent's own default. The list is saved, so `pi -p` and
offline startups use the last one found.

Both the ACP `configOptions` model selector and the older `models` /
`session/set_model` API are supported. If the agent exposes a `thought_level`
option, Pi's thinking level (`shift+tab`, `--thinking`) is applied to it; levels
the agent doesn't offer are hidden. Discovery never triggers `authMethod`
sign-in; that waits for the first prompt.

### Agent slash commands

Each agent registers a Pi command named after its key. `/<key> <command>`
runs a slash command the agent advertises over ACP (`available_commands_update`),
e.g. `/antigravity context`. Arguments autocomplete from the agent's current
list. `/<key>` alone lists the commands. Running one switches to that agent if
another model is active, then sends `/<command>` as the prompt.

Per-agent keys:

| Key | Required | Meaning |
|---|---|---|
| `command` | yes | Executable, spawned in the session cwd. |
| `args` | no | Arguments, e.g. the agent's ACP flag. Default `[]`. |
| `name` | no | Display name in the model picker and messages. Default: the key. |
| `env` | no | Extra environment variables for the agent process. |
| `authMethod` | no | ACP `authenticate` method id to use when the agent reports `auth_required` (see Auth below). |

Global keys:

| Key | Env override | Default | Meaning |
|---|---|---|---|
| `autoApproveTools` | `ACP_AUTO_APPROVE` | `false` | When `false` (default), each permission request opens a select dialog (TUI/RPC) or is denied (background/print/JSON mode). Set `true` to auto-approve (`allow_once`). |
| `handshakeTimeoutMs` | | `30000` | Milliseconds to wait for `initialize`, `session/new`, `session/resume`, `session/load`, and model or thinking-level changes. |
| | `ACP_DEBUG=1` | off | Wire diagnostics on stderr. |

## Behavior

- **Lifecycle & isolation**: each Pi session and agent gets a separate process,
  spawned lazily on its first prompt and retained for follow-ups. Session `cwd`,
  UI context, and shutdown cleanup (`session_shutdown` / session resource
  cleanup) are scoped per Pi session ID so ending one session does not disrupt
  other concurrent sessions. Each agent runs in its own process group, so the
  whole tree (including tool subprocesses) is killed on cleanup or parent exit.
  A crashed agent is respawned with a fresh session on the next prompt.
- **Session mapping**: one ACP session per Pi session per agent when Pi supplies
  a session ID; overlapping turns on the same Pi session are rejected cleanly.
  Calls without a session ID use an isolated single-turn process and cannot
  continue an earlier ACP conversation. Each turn sends only the newest user
  message, because the agent keeps conversation history on its side.
- **Session continuation & restart recovery**: the extension persists
  `acp-session` entries on the Pi session branch. On `/resume`, `--continue`,
  or `--session`, it restores the saved ACP session via capability-negotiated
  `session/resume` (preferred, without history replay) or `session/load`
  (ignoring replayed `session/update` history). Unsupported capabilities or
  missing sessions surface explicit errors. `/fork` starts a fresh ACP session.
- **Instructions**: Pi's current system instructions are sent when the ACP
  session starts. Agents advertising `sessionCapabilities.systemPrompt` receive
  them in `append` mode. Otherwise they are prepended to the first user prompt;
  that fallback has user-message semantics and does not guarantee system-level
  precedence. Instructions are not repeated on follow-up turns or restored
  sessions. If they change during a used session, the provider reports an error
  and requires a new Pi session.
- **Pi tool bridge (`McpBridge`)**: when the Pi session has tools, the provider
  starts a session-scoped, bearer-authenticated local HTTP MCP server paired with
  a stdio shim (`src/mcp-stdio-shim.mjs`) and passes it in `mcpServers`. When
  the ACP agent calls a Pi tool (`mcp_pi_*`), the ACP turn suspends via
  `ToolHandoff`, the provider emits a Pi `toolUse` turn so Pi executes the tool
  and records native tool activity, and the next `stream()` call resumes the
  ACP turn with the `toolResult`. Bridged calls obey Pi's current tool
  allowlist across turns.
- **Streaming**: ACP v1 `session/update` notifications. `agent_thought_chunk`
  maps to Pi thinking blocks and `agent_message_chunk` to text blocks.
  Agent-native tool calls render inline as `⚙️ Executing [title]...` and, on
  completion, `✓ title: <first line of output>` (or `✗` on failure), including
  calls reported already finished.
- **Abort**: Pi's abort signal (Ctrl+C) sends `session/cancel`, closes any
  pending `ToolHandoff`, and finalizes the message as aborted immediately. It
  answers any open permission prompt with `cancelled` and leaves the session
  usable. The next prompt waits (up to 5 s) for the agent to confirm the
  cancellation, so late updates can't leak into it.
- **Permissions**: `session/request_permission` prompts via an interactive
  select dialog that names the asking agent when a UI is available, and denies
  (`reject_once`) in non-interactive/background sessions. Set
  `autoApproveTools: true` (or `ACP_AUTO_APPROVE=1`) to auto-approve with
  `allow_once` (never `allow_always`).
- **Auth**: when an agent answers `session/new`, `session/resume`, or
  `session/load` with ACP `auth_required` (code -32000), the provider calls
  `authenticate` with the agent's configured `authMethod` and retries once.
  Without one, the error lists the auth methods advertised in `initialize`. A
  missing command reports a not-found hint naming the agent. The provider
  registers as ambient-auth so `/model` selection never blocks.
- **Usage**: ACP does not report per-turn token usage, so the provider records
  zeros.

### Adapter notes & known limitations

| Adapter | System prompt | `McpBridge` (`mcp_pi_*`) | `session/resume` / `load` | Disable built-in tools |
|---|---|---|---|---|
| **Antigravity** (`agy acp` 1.5.15) | First-user-message fallback | Verified live | Verified live (`session/resume`) | Not supported by adapter |
| **Codex** (`@agentclientprotocol/codex-acp` 2.9.0) | Native `append` mode | Verified live | Advertised (`resume` & `load`) | Not supported by adapter |
| **Claude** (`claude-agent-acp`) | Pending reauth | Pending reauth | Pending reauth | — |

- **Cross-directory & worktree subagents**: Pi's `StreamOptions` does not yet
  include the active session's `cwd`, and shared `ModelRuntime` registrations
  can be replaced when a child session binds extensions (see
  [docs/shared-runtime-investigation.md](docs/shared-runtime-investigation.md)
  and `scripts/reproduce-*.mjs`). The provider honors `streamOptions.cwd` when
  supplied, but cross-directory or worktree subagents with disabled child
  extensions remain unsupported until upstream Pi exposes session `cwd` and
  session-scoped provider ownership.
- **Built-in vs. Pi tools**: `agy acp` and `codex-acp` do not offer a flag or
  capability to disable their own built-in tools, so Pi's tool allowlist is
  enforced only on Pi-bridged (`mcp_pi_*`) calls.
- **No image input**: prompts are sent as text only; image attachments are noted
  rather than forwarded.
- **No ACP client `fs`/`terminal` capabilities**: agents use their own tools or
  bridged Pi tools; other agent→client requests get method-not-found.
- **Stream hooks**: `onPayload` and `onProviderStreamEvent` are honored;
  `onResponse` is HTTP-specific and not called.

## Development

```bash
npm run typecheck   # strict tsc, no emit
npm test            # node:test suite against a scripted fake ACP agent
```

The test suite (`test/`) uses `test/fake-agent.mjs` to cover ACP v1 wire
shapes, per-session isolation and `cwd` scoping, directive forwarding,
`session/resume` and `session/load`, `McpBridge` / `ToolHandoff` (success,
denial, allowlist changes, overlap, abort, crash), permissions, cancellation,
auth, refusals, and split NDJSON frames. No real agent or network is needed.

## Layout

- `src/acp.ts`: ACP v1 / JSON-RPC wire types and boundary parsers
- `src/acp-client.ts`: child process, NDJSON transport, handshake, sessions, auth
- `src/provider.ts`: the Pi `Provider` (agents and their discovered models), model/thinking selection, MCP handoff loop, and event translation
- `src/tool-handoff.ts`: per-turn promise queue bridging ACP tool calls to Pi's agent loop
- `src/mcp-bridge.ts`: session-scoped authenticated HTTP MCP server exposing Pi's current tools
- `src/mcp-stdio-shim.mjs`: stdio-to-HTTP JSON-RPC shim for ACP adapters using stdio `mcpServers`
- `src/config.ts`: settings and env resolution
- `src/index.ts`: extension factory (`pi.registerProvider`, branch session persistence, lifecycle wiring)
