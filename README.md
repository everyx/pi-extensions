# pi-subagent

[English](README.md) | [中文](README.zh.md)

Spawn isolated sub‑agents from pi. Each sub‑agent is a full pi instance running in its own context — your conversation stays clean.

```
You:  Research this project's database schema for me
  → pi calls Agent, spawns a resident `pi --mode rpc` child
  → Child works independently in its own context window
  → Result comes back; you keep chatting
```

## Why?

Pi doesn't have built‑in sub‑agents. When a task would flood your context with verbose intermediate output (search results, logs, test output), or you want to run independent tasks in parallel without blocking your conversation — that's what this extension is for.

## Install

```bash
# npm (recommended)
pi install npm:@everyx/pi-subagent

# git
pi install git:github.com/everyx/pi-subagent
```

Or symlink for development:

```bash
ln -sf /path/to/pi-subagent ~/.pi/agent/extensions/subagent
```

Restart pi and just tell it "ask a sub‑agent to…".

## Tools

Two primitive tools:

- **`Agent`** — spawn an isolated sub‑agent: `{ prompt, title, model?, thinking?, tools?, run_in_background? }`. `title` (3‑5 words, required) labels the tool header, notification card, widget row, and session name — like Claude Code's `description` / Codex's `task_name`. Foreground (default) blocks until the result is ready; `run_in_background: true` returns an `agent_id` immediately and delivers a completion notification carrying the final output.
- **`AgentControl`** — intervene in a running background agent: `steer` (inject a redirecting message) or `stop` (terminate).

The LLM is guided by `promptSnippet` + `promptGuidelines` (system-prompt injection): when to delegate, to keep prompts self-contained, and to never poll.

## Usage

### Kick off a task

Tell pi:

```
Ask a sub‑agent to analyze the auth logic under src/
```

Pi calls `Agent` (foreground), the child runs in isolation, and the result comes back.

### Run several in parallel (background)

```
Spawn three sub‑agents to look at the auth module, the database layer, and the API routes
```

Pi calls `Agent` with `run_in_background: true` three times. Each completion notification carries that agent's final output — no polling, no extra result tool.

### Steer or stop a running agent

```
That data‑layer sub‑agent — the approach won't work, rewrite it with composition instead
```

Pi calls `AgentControl` with `steer` to redirect the running agent. To stop a runaway agent: "kill that background sub‑agent" → `stop`.

## Advanced

### Pick a model

```
Spawn a sub‑agent with claude-sonnet to analyze the database design
```

No model specified → inherits your current session's model. Same for `thinking` — omit it and the sub-agent runs at your current thinking level; pass `"off"`…`"max"` to override.
Model specified but not found in the registry → error, no silent fallback.

### Restrict tools

```
Ask a sub‑agent to research the project structure, but only let it use read and grep
```

Sub‑agent won't see any other tools. Read-only exploration with a cheaper model is the recommended pattern for research tasks.

## How it works

Every sub‑agent is a resident `pi --mode rpc` child with a persisted session:

- **Foreground** — `Agent` waits for the child to settle, fetches the final output, then closes stdin (graceful shutdown).
- **Background** — `Agent` returns immediately; on `agent_settled` the extension delivers a `subagent-notification` (JSON content to the LLM, rendered card to the user) and the child shuts down gracefully.
- **Steer/stop** — `AgentControl.steer` writes a `steer` command to the child's stdin (delivered after its current turn settles); `stop` closes stdin for a graceful shutdown.
- **Attach / review** — sub‑agent sessions are stored in `<agent dir>/subagent-sessions/` (default `~/.pi/agent/subagent-sessions/`; override with `PI_SUBAGENT_SESSION_DIR`, and `PI_CODING_AGENT_DIR` is honored for the agent dir, same as pi), deliberately **outside** pi's standard session tree so `pi -r` stays clean. They are **never deleted**. To resume or review one, find the session path in the main conversation (the Agent call result or the completion notification card) and run `pi --session <path>` — or ask the LLM, the notification carries the path too.
- **Graceful turn limits (opt-in)** — by default the extension imposes **no hidden deadline**: a sub‑agent runs until it finishes or is stopped (the same restraint Claude Code shows — it has no time watchdog). The `Agent` tool accepts an optional `timeoutMs` (Codex's `timeout_ms` style): when passed, the extension aborts at the deadline, waits for the settle, then shuts down. No truncated output from an abrupt SIGTERM. When the limit fires, the session file holds the full transcript; the tool result marks the run stopped. There are no token limits — usage is only reported on the notification card.

## Nested sub‑agents

Sub‑agents are full pi instances and therefore spawn sub‑agents of their own if you have this extension installed globally — nesting works out of the box with no depth control. Each level is a separate process with its own context, so nesting depth multiplies startup time and token cost. You (or the model) judge when nesting is worth it.

## Costs & caveats

- **Headless (`pi -p`) background agents die with the host.** The main process exits when the agent finishes its response — background children are then torn down via stdin EOF (they never leak as orphans). Background workflows (wait for notification, steer, stop) are designed for the TUI session, which stays alive.
- **One process per agent.** Foreground and background are identical (resident rpc child). Many background agents = many processes — spawn them in moderation.
- **Notification is one-shot.** A background result is delivered once; if the main session dies before delivery, the result survives only in the session file (attach it with `pi --session <path>`).
- **Steer needs a live agent.** `AgentControl` only works while the agent is still running, before its completion notification.

## Cleanup

When pi exits, running sub‑agents receive a graceful stdin-EOF shutdown. Sessions remain on disk for attach/replay; nothing is killed or deleted.
