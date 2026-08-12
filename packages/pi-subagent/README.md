# pi-subagent

[English](README.md) | [中文](README.zh.md)

**Minimal sub‑agents for your Pi — three primitives, no noise, no limits.**

```
You:  Research this project's database schema for me
  → pi calls agent_spawn, spawns a resident `pi --mode rpc` child
  → Child works independently in its own context window
  → Result comes back; you keep chatting
```

## Why?

Pi has no built‑in sub‑agents. So heavy, parallel, or context‑heavy work crowds into your one window. pi‑subagent moves that work to a child pi: the noise stays there, only the answer comes back.

## Features

- **Quiet context** — logs, search hits, and test output stay in the child's window. You get the final result, not the churn.
- **True parallel** — fire several background agents at once; each delivers its own notification when done. No queue, no result tool.
- **Stay in control** — `agent_send` redirects a running agent (or wakes an idle one); `agent_stop` kills it. A child's message up the tree is delivered best-effort (no ack).
- **Persistent on demand** — spawn with `persistent: true` and the child stays resident after completion: idle at zero tokens, ready to be woken by a later `agent_send` for follow‑ups in the same context — or killed by `agent_stop`.
- **Pi‑native** — rendering, sessions, and attach all reuse pi's own mechanisms; the cards look like built‑in tools because they are.
- **Inherit or override** — a child inherits your model and thinking level by default; override it per child. A cheap model for recon, a strong one for the build.
- **No hidden limits** — no token ceiling, no deadline, no concurrency cap by default. An optional `timeoutMs` adds a guardrail when you want one.
- **Reviewable** — every session persists and is never deleted; attach any result with `pi --session <path>`.
- **Zero deps & nestable** — only `peerDependencies`. A child is a full pi instance, so it can spawn another child.
- **Token economy** — the system side stays lean:
  - **System prompt** — three tools and terse guidance inject roughly 2–3KB of system prompt (token count drifts with the tokenizer).
  - **Notification** — the LLM sees only minimal structured data; decoration (title, usage, session path) stays in the render layer.
  - **Results** — tail‑truncated (2000 lines / 50KB); expand any card for the full transcript.

## Comparison with similar extensions

pi-subagent, [`@tintinweb/pi-subagents`](https://github.com/tintinweb/pi-subagents), and [`pi-subagents`](https://github.com/nicobailon/pi-subagents) all give pi isolated, parallel sub‑agents. They sit on a *primitives → framework* spectrum, and pi-subagent sits at the minimal end: three primitives, no predefined roles, no harness — you compose. What that buys you is in [Features](#features); where the trade‑offs fall is below.

| | **pi-subagent** | **@tintinweb/pi-subagents** | **pi-subagents (nicobailon)** |
|---|---|---|---|
| Design stance | Minimal primitives | Full framework | Full framework |
| Tool surface | `agent_spawn` / `agent_stop` / `agent_send` (3) | Claude Code‑style `Agent` / `get_subagent_result` / `steer_subagent` | `subagent` + management/status/control families |
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
ln -sf /path/to/pi-extensions/packages/pi-subagent ~/.pi/agent/extensions/subagent
```

Restart pi, then tell it "ask a sub‑agent to…".

## Quick start

### Kick off a task

```
Ask a sub‑agent to analyze the auth logic under src/
```

Pi calls `agent_spawn` (foreground), the child runs in isolation, and the result comes back inline.

### Run several in parallel

```
Spawn three sub‑agents to look at the auth module, the database layer, and the API routes
```

Pi calls `agent_spawn` with `run_in_background: true` three times. Each completion notification carries that agent's final output — no polling, no extra result tool.

### Message or stop

```
That data‑layer sub‑agent — the approach won't work, rewrite it with composition instead
```

Pi calls `agent_send` to inject a redirecting message into the running agent (delivered after its current turn settles). To stop a runaway agent: "kill that background sub‑agent" → `agent_stop`. Both work on a running agent; with `persistent: true` they also work after completion — `agent_send` wakes the idle agent for follow‑ups, `agent_stop` kills it.

## Configuration

### Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `PI_SUBAGENT_SESSION_DIR` | `<agentDir>/subagent-sessions/` | Where sub‑agent session files live; set to relocate. `<agentDir>` follows pi's agent dir (`~/.pi/agent`, or pi's own `PI_CODING_AGENT_DIR`). |

The directory lives **outside** pi's standard session tree so `pi -r` (resume) stays clean. Sessions are never deleted.

### Tool reference

#### `agent_spawn` — spawn an isolated sub‑agent

| Param | Type | Default | Meaning |
|---|---|---|---|
| `prompt` | string | **required** | Self‑contained task description for the sub‑agent. |
| `title` | string (3–5 words) | **required** | Labels the tool card, notification card, widget row, and session name — like Claude Code's `description` / Codex's `task_name`. |
| `model` | string | inherited | Override the sub‑agent's model. Specified but not registered → **error, no silent fallback**. |
| `thinking` | `"off"`…`"max"` | inherited | Override thinking level; omit to run at your current session's level. |
| `tools` | string[] | all | Whitelist of tool names visible to the sub‑agent — anything else is invisible. |
| `run_in_background` | boolean | `false` | Foreground (default) blocks until the result is ready. `true` returns an `agent_id` immediately and delivers a completion notification carrying the final output. |
| `timeoutMs` | number | none | Optional deadline (ms). On firing, the extension stops the child, waits for it to settle, and shuts down gracefully. |
| `persistent` | boolean | `false` | Keep the child resident (idle, zero tokens) after completion instead of shutting down. A later `agent_send` wakes it to continue the same context; `agent_stop` tears it down. Works for foreground and background spawns. |

#### `agent_stop` — terminate an agent

| Param | Meaning |
|---|---|
| `agent_id` | **required** — the id `agent_spawn` returned. Stops a running agent, or an idle `persistent` one. Graceful shutdown (stdin EOF); no completion notification. |

#### `agent_send` — message an agent in the tree

| Param | Meaning |
|---|---|
| `to` | **required** — the agent id agent_spawn gave you (a short human name like `max`), or `"@parent"` to message the session that spawned you. |
| `message` | **required** — the message text; delivered after the target's current turn settles, or wakes an idle persistent agent. |

Messages travel the parent↔child edges of the agent tree: a direct child is delivered straight down, `@parent` goes up, and cross‑level/sibling messages are forwarded through the parent LLM's context along the way.

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

- **Foreground** — `agent_spawn` waits for the child to settle, fetches the final output, then closes stdin (graceful shutdown).
- **Background** — `agent_spawn` returns immediately; on `agent_settled` the extension delivers a `subagent-notification` (JSON content to the LLM, rendered card to the user) and the child shuts down gracefully.
- **Send/stop** — `agent_send` delivers a message to the child's stdin (queued while it runs, delivered after its current turn settles); `agent_stop` closes stdin for a graceful shutdown. Both work on a running agent.
- **Persistent idle** — with `persistent: true` the child stays resident after completion (idle, zero tokens). A later `agent_send` wakes it to continue the same context; `agent_stop` tears it down. The completion notification and widget row carry the `idle` marker.
- **Attach / review** — sub‑agent sessions live in `<agent dir>/subagent-sessions/` (see [Configuration](#configuration)). Find the session path in the main conversation and run `pi --session <path>` — or ask the LLM, the notification carries the path too.
- **Graceful turn limits (opt‑in)** — no hidden deadline: a sub‑agent runs until it finishes or is stopped unless you pass `timeoutMs`. No abrupt SIGTERM. No token limits — usage is only reported on the notification card.

## Nested sub‑agents

A child is a full pi instance — so if you installed this extension globally, it spawns children of its own. Each level is its own process with its own context; depth multiplies startup time and token cost. You — or the model — judge when it's worth it.

The mechanism is a pure point-to-point deliverer: `agent_send` delivers to a direct child by its id (a short human name like `max`), or to `"@parent"` — and errors on anything else. Routing is the LLM's job: each agent addresses only the ids it was given, hop by hop (a grandchild reaching the root goes through its parent's LLM deciding to forward with `@parent`). Information disclosure is the only limit — a parent holds the ids of the agents it spawned; nobody knows ids they were never told.

## Costs & caveats

- **Headless children die with the host** (`pi -p`). The main process exits at the end of its reply; background children are then torn down via stdin EOF — never orphaned. Background flows (waiting for the notification, messaging, stopping) are for the always‑alive TUI session.
- **One process per child.** Foreground and background are the same resident rpc child. Many children = many processes — spawn with care.
- **One‑shot results.** A background result is delivered once; if the main session dies before delivery, the result survives in the session file (`pi --session <path>`).
- **Send/stop need an addressable child.** `agent_send` and `agent_stop` target a live child — or, for `persistent` spawns, the resident idle child after completion. A non‑persistent child is gone once its completion notification fires; messaging or stopping it errors.

## Cleanup

When pi exits, sub‑agents (running or idle) get a graceful stdin‑EOF shutdown. Sessions stay on disk for attach/replay — nothing is killed, nothing deleted.