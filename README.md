# pi-subagent

[English](README.md) | [中文](README.zh.md)

**Minimal sub‑agents for your Pi — two primitives, no noise, no limits.**

```
You:  Research this project's database schema for me
  → pi calls Agent, spawns a resident `pi --mode rpc` child
  → Child works independently in its own context window
  → Result comes back; you keep chatting
```

## Why?

Pi has no built‑in sub‑agents. So heavy, parallel, or context‑heavy work crowds into your one window. pi‑subagent moves that work to a child pi: the noise stays there, only the answer comes back.

## Features

- **Quiet context** — logs, search hits, and test output stay in the child's window. You get the final result, not the churn.
- **True parallel** — fire several background agents at once; each delivers its own notification when done. No queue, no result tool.
- **Stay in control** — `steer` redirects a running agent; `stop` kills it. Nothing is fire‑and‑forget.
- **Pi‑native** — rendering, sessions, and attach all reuse pi's own mechanisms; the cards look like built‑in tools because they are.
- **Inherit or override** — a child inherits your model and thinking level by default; override it per child. A cheap model for recon, a strong one for the build.
- **No hidden limits** — no token ceiling, no deadline, no concurrency cap by default. An optional `timeoutMs` adds a guardrail when you want one.
- **Reviewable** — every session persists and is never deleted; attach any result with `pi --session <path>`.
- **Zero deps & nestable** — only `peerDependencies`. A child is a full pi instance, so it can spawn another child.
- **Token economy** — the system side stays lean:
  - **System prompt** — two tools and terse guidance cost ≈**587 tokens** of injection (~2.3KB; drifts with the tokenizer).
  - **Notification** — the LLM sees only minimal structured data; decoration (title, usage, session path) stays in the render layer.
  - **Results** — tail‑truncated (2000 lines / 50KB); expand any card for the full transcript.

## Comparison with similar extensions

pi-subagent, [`@tintinweb/pi-subagents`](https://github.com/tintinweb/pi-subagents), and [`pi-subagents`](https://github.com/nicobailon/pi-subagents) all give pi isolated, parallel sub‑agents. They sit on a *primitives → framework* spectrum, and pi-subagent sits at the minimal end: two primitives, no predefined roles, no harness — you compose. What that buys you is in [Features](#features); where the trade‑offs fall is below.

| | **pi-subagent** | **@tintinweb/pi-subagents** | **pi-subagents (nicobailon)** |
|---|---|---|---|
| Design stance | Minimal primitives | Full framework | Full framework |
| Tool surface | `Agent` + `AgentControl` (2) | Claude Code‑style `Agent` / `get_subagent_result` / `steer_subagent` | `subagent` + management/status/control families |
| Predefined roles | None — defined by prompt | Custom types via `.pi/agents/*.md` (frontmatter) | 8 built‑in (scout / reviewer / worker / oracle…) |
| Parallelism | Uncap (one process per agent) | Queued, default 4 concurrent | spawn / turn / usage budgets |
| Default limits | None (optional `timeoutMs`) | Graceful turn limits | turn / usage budgets |
| Observability | pi‑native cards + widget + `pi --session` | FleetView + conversation viewer | FleetView inspector + fleet |
| Nesting | Built‑in, no depth cap | Opt‑in, depth cap | Recursion guard |
| Extras | Token economy, zero runtime deps, no orphans on reload/crash | Memory, worktree isolation, schedule, cross‑extension RPC, event bus | Missions/scheduling, watchdog, worktree, intercom, chain orchestration |
| Best for | Owning your own composition | A turnkey sub‑agent system | Built‑in roles + workflow orchestration |

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

Restart pi, then tell it "ask a sub‑agent to…".

## Quick start

### Kick off a task

```
Ask a sub‑agent to analyze the auth logic under src/
```

Pi calls `Agent` (foreground), the child runs in isolation, and the result comes back inline.

### Run several in parallel

```
Spawn three sub‑agents to look at the auth module, the database layer, and the API routes
```

Pi calls `Agent` with `run_in_background: true` three times. Each completion notification carries that agent's final output — no polling, no extra result tool.

### Steer or stop

```
That data‑layer sub‑agent — the approach won't work, rewrite it with composition instead
```

Pi calls `AgentControl` with `steer` to redirect the running agent. To stop a runaway agent: "kill that background sub‑agent" → `stop`. Both need a **live** agent — they only work before its completion notification.

## Configuration

### Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `PI_SUBAGENT_SESSION_DIR` | `<agentDir>/subagent-sessions/` | Where sub‑agent session files live; set to relocate. `<agentDir>` follows pi's agent dir (`~/.pi/agent`, or pi's own `PI_CODING_AGENT_DIR`). |

The directory lives **outside** pi's standard session tree so `pi -r` (resume) stays clean. Sessions are never deleted.

### Tool reference

#### `Agent` — spawn an isolated sub‑agent

| Param | Type | Default | Meaning |
|---|---|---|---|
| `prompt` | string | **required** | Self‑contained task description for the sub‑agent. |
| `title` | string (3–5 words) | **required** | Labels the tool card, notification card, widget row, and session name — like Claude Code's `description` / Codex's `task_name`. |
| `model` | string | inherited | Override the sub‑agent's model. Specified but not registered → **error, no silent fallback**. |
| `thinking` | `"off"`…`"max"` | inherited | Override thinking level; omit to run at your current session's level. |
| `tools` | string[] | all | Whitelist of tool names visible to the sub‑agent — anything else is invisible. |
| `run_in_background` | boolean | `false` | Foreground (default) blocks until the result is ready. `true` returns an `agent_id` immediately and delivers a completion notification carrying the final output. |
| `timeoutMs` | number | none | Optional deadline (ms). On firing, the extension stops the child, waits for it to settle, and shuts down gracefully. |

#### `AgentControl` — intervene in a running agent

| Param | Meaning |
|---|---|
| `steer` | Inject a redirecting message into the running agent (delivered after its current turn settles). |
| `stop` | Gracefully terminate (stdin EOF → graceful shutdown). No completion notification. |

The LLM is guided by `promptSnippet` + `promptGuidelines` (system‑prompt injection): when to delegate, to keep prompts self‑contained, and to never poll.

## Advanced

### Pick a model

```
Spawn a sub‑agent with claude-sonnet to analyze the database design
```

No model specified → inherits your current session's model. Same for `thinking` — omit it and the sub-agent runs at your current level; pass `"off"`…`"max"` to override.

Model **specified but not found** in the registry → error, no silent fallback.

### Restrict tools

```
Ask a sub‑agent to research the project structure, but only let it use read and grep
```

Sub‑agent won't see any other tools. Read‑only exploration with a cheaper model is a good pattern for research tasks.

## How it works

Every sub‑agent is a resident `pi --mode rpc` child with a persisted session:

- **Foreground** — `Agent` waits for the child to settle, fetches the final output, then closes stdin (graceful shutdown).
- **Background** — `Agent` returns immediately; on `agent_settled` the extension delivers a `subagent-notification` (JSON content to the LLM, rendered card to the user) and the child shuts down gracefully.
- **Steer/stop** — `AgentControl.steer` writes a `steer` command to the child's stdin (delivered after its current turn settles); `stop` closes stdin for a graceful shutdown.
- **Attach / review** — sub‑agent sessions live in `<agent dir>/subagent-sessions/` (see [Configuration](#configuration)). Find the session path in the main conversation and run `pi --session <path>` — or ask the LLM, the notification carries the path too.
- **Graceful turn limits (opt‑in)** — no hidden deadline: a sub‑agent runs until it finishes or is stopped unless you pass `timeoutMs`. No abrupt SIGTERM. No token limits — usage is only reported on the notification card.

## Nested sub‑agents

A child is a full pi instance — so if you installed this extension globally, it spawns children of its own. Each level is its own process with its own context; depth multiplies startup time and token cost. You — or the model — judge when it's worth it.

## Costs & caveats

- **Headless children die with the host** (`pi -p`). The main process exits at the end of its reply; background children are then torn down via stdin EOF — never orphaned. Background flows (waiting for the notification, steer, stop) are for the always‑alive TUI session.
- **One process per child.** Foreground and background are the same resident rpc child. Many children = many processes — spawn with care.
- **One‑shot results.** A background result is delivered once; if the main session dies before delivery, the result survives in the session file (`pi --session <path>`).
- **Steer needs a live child.** `AgentControl` works only while a child is running, before its completion notification.

## Cleanup

When pi exits, running sub‑agents get a graceful stdin‑EOF shutdown. Sessions stay on disk for attach/replay — nothing is killed, nothing deleted.