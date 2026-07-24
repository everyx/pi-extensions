# pi-subagent Spec

## Problem Statement

Pi explicitly does not ship a built-in sub-agent feature, per the author's philosophy documented in the blog post. The recommended pattern—spawning `pi --print` via bash—works for one-shot delegation but lacks:

- **Programmatic battle**: the main agent cannot send follow-up prompts to a sub-agent after seeing its output, preventing iterative negotiation.
- **Attachability**: non-interactive sub-agents (`pi --print`) run as black boxes; the user cannot inspect intermediate state or jump into the conversation.
- **Parallelism**: running multiple sub-agents concurrently requires manual orchestration.
- **Lifecycle management**: dangling sub-agent processes and tmux sessions accumulate without coordinated cleanup.

Other skills in the ecosystem (e.g. wayfinder's "Fire the research subagents") need a standard `subagent` tool to delegate work, but no such tool exists.

## Solution

A pi extension that registers a `subagent` tool callable by the LLM. The tool supports:

- **Non-interactive mode** (default): spawn `pi --print --no-session` and capture stdout. Zero overhead, no tmux.
- **Interactive mode** (`interactive: true`): spawn a full pi session inside a named tmux session (`pi-sub-<id>`). The user can `tmux attach -t pi-sub-<id>` at any time.
- **Battle mode** (`session: "pi-sub-xxx" + task`): the parent sends a follow-up prompt to a running interactive sub-agent via `tmux paste-buffer`. The sub-agent's child-mode extension waits for `agent_settled` and pushes the result back over a Unix socket.
- **Parallel mode** (`tasks[]`): runs multiple sub-agents concurrently via `Promise.all` and aggregates their results.

The same extension binary serves both parent and child roles: the child detects `PI_SUBAGENT_PARENT_SOCKET` at startup and activates a listener for `agent_settled` (no tool registration in child mode).

## User Stories

1. As a pi user, I want to delegate a research task to a sub-agent without polluting my main session's context window, so that the main agent stays focused on the current task.
2. As a pi user, I want the sub-agent to run in non-interactive mode by default, so that I don't pay tmux overhead for simple one-shot tasks.
3. As a pi user, I want to set the sub-agent to interactive mode when I anticipate needing to inspect or jump into its session, so that I have full observability.
4. As a pi user, I want the tool to display the tmux session name (`pi-sub-xxx`) when running interactively, so that I can `tmux attach` to it immediately.
5. As a pi user, I want to send a follow-up prompt to a running interactive sub-agent after seeing its first result, so that I can iterate on the answer without losing context.
6. As a pi user, I want to run multiple sub-agents in parallel, so that I can explore independent questions (e.g., "find all auth code" + "find all database schema") simultaneously.
7. As a pi user, I want parallel sub-agent results aggregated into a single response with clear section headers, so that I can scan them at a glance.
8. As a pi user, I want sub-agent sessions cleaned up when the parent pi exits, so that dangling tmux sessions do not accumulate.
9. As a pi user, I want a confirming prompt before killing lingering sub-agents in interactive mode, so that I can choose to keep them for later re-attachment.
10. As a pi user, I want to close a specific sub-agent session early via the tool, so that I can free resources when a sub-agent is no longer needed.
11. As a pi user, I want to override the model and tool allowlist per sub-agent, so that I can use a cheap model (Haiku) for scouting and a capable model (Sonnet) for implementation.
12. As a skill developer, I want a `subagent` tool with a stable parameter schema, so that my skill can invoke it programmatically (e.g. wayfinder's "Fire the research subagents").
13. As a pi user, I want the sub-agent's output returned as plain text (not a file reference or structured JSON), so that the main agent can consume it immediately without extra parsing.
14. As a pi user, I want to abort sub-agent execution via Ctrl+C, so that I can cancel a long-running or mistaken sub-task.
15. As a pi user, I want the extension to require no npm dependencies beyond what pi already bundles (`typebox`, `@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`), so that installation is trivial.

## Implementation Decisions

### Architecture

The extension (`index.ts`) is a single file with two operating modes controlled by environment variable:

```
Parent mode (no env var):
  → registers `subagent` tool
  → manages tmux sessions, socket servers, sub-process lifecycle
  
Child mode (PI_SUBAGENT_PARENT_SOCKET set):
  → hooks `agent_settled` to push last assistant output via Unix socket
  → does NOT register the tool (avoids conflict with parent's tool)
```

### Communication protocol (child → parent)

Unix socket with length-prefixed framing:

```
[4 bytes: BE uint32 length][UTF-8 text bytes]
```

The child connects, writes one packet, disconnects. Each round uses a fresh connection. Parent creates a new socket server per round (battle re-creates after close).

### tmux lifecycle

| | Non-interactive | Interactive |
|---|---|---|
| tmux session | Not created | `pi-sub-<random>` |
| pi invocation | `pi --print --no-session "..."` (via `spawn`) | `pi -n pi-sub-xxx --name sub-xxx 'task'` (via shell script in tmux) |
| Result capture | stdout pipe | Unix socket (child pushes on `agent_settled`) |
| Battle support | ❌ | ✅ `tmux paste-buffer` + socket |
| Cleanup on parent exit | N/A (no tmux) | Confirm prompt (interactive) or silent kill (headless) |

### Shell quoting for tmux script

The task is embedded as a single-quoted shell argument. Single quotes in the task are escaped with the `'\''` pattern (`end-quote, escaped-quote, resume-quote`). This is handled by the `squote()` helper local to `runInteractive`.

### Session state

A module-level `Map<string, SessionState>` tracks active interactive sessions:

```typescript
interface SessionState {
  id: string;
  sessionName: string;
  socketPath: string;
  server: net.Server;
}
```

The map is used for battle routing, close operations, and cleanup on `session_shutdown`.

### Parallel execution

`Promise.all` over the task array. Each task runs independently—there is no shared mutable state between concurrent sub-agents (each gets a unique session name, socket path, and tmux session).

### Tool parameter schema

```typescript
// Single mode
{ task: string, model?: string, tools?: string, interactive?: boolean }

// Parallel mode
{ tasks: [{ id?: string, task: string, model?: string, tools?: string }],
  interactive?: boolean }

// Battle mode
{ session: string, task: string }

// Close mode
{ session: string, close: true }
```

### Cleanup on parent exit

`session_shutdown` event (fires on Ctrl+C, Ctrl+D, SIGHUP, SIGTERM). Interactive (TUI) mode shows a confirm dialog listing active sessions. Headless mode kills silently. Temp dir (`/tmp/pi-subagent-*`) is cleaned up on quit.

## Testing Decisions

### What makes a good test

Test the protocol, not the infrastructure. The core novel logic is the Unix socket length-prefixed framing that child and parent use to communicate. Everything else (tmux orchestration, pi sub-process spawning) is a thin wrapper around well-understood system tools and is better validated through manual integration testing.

### Module under test

- **Socket protocol**: the `createServer` + `readOnce` + `closeServer` functions and the corresponding child-side `net.createConnection` + length-prefixed write pattern.

### Test approach

A single seam: **length-prefixed socket round-trip**. Create a server, connect a client, write a message with the 4-byte header + UTF-8 payload, verify the server reads it correctly. Test edge cases:

- Empty message
- Multi-byte UTF-8 characters
- Large message (near timeout boundary)
- Client disconnect before writing
- Abort signal cancels the read

### Prior art

The pi mono repo does not ship tests for its extension examples. This repo follows the same convention—extensions are tested in daily use, not in CI.

## Out of Scope

- **Agent definition files** (`~/.pi/agent/agents/*.md`): the initial implementation does not define or discover preset agent personalities. Agents are defined entirely by the parameters their caller passes (`task`, `model`, `tools`). Users who want reusable configurations can use pi's existing Prompt Templates.
- **Concurrency limiting**: `Promise.all` runs all tasks concurrently without a cap. If too many parallel sub-agents cause resource pressure, a concurrency limit can be added later.
- **Windows support**: Unix sockets and tmux are Linux/macOS only. No Windows compatibility in this version.
- **Structured output parsing**: the child returns raw assistant text. No JSON schema enforcement or structured extraction.
- **Persistent sub-agent sessions across parent restarts**: sessions are ephemeral and cleaned up on parent exit. No session serialization.
- **Background daemon mode**: sub-agents always run in a pi process. No headless long-running daemons.

## Further Notes

- The extension must be auto-loaded in child mode (i.e., installed in `~/.pi/agent/extensions/` or via `pi install`) so that child pi instances automatically detect `PI_SUBAGENT_PARENT_SOCKET` and activate the `agent_settled` listener.
- The tool's `renderCall` and `renderResult` are minimal. Future improvements could show live streaming status for parallel tasks or a richer battle history in the collapsed view.
- Battle mode sends the follow-up prompt via `tmux paste-buffer`, which types the text as terminal input. This works with pi's editor but assumes the editor is empty and waiting for input. A `Ctrl+C` clear is not sent (tmux paste-buffer replaces the current line in most terminal editors).
