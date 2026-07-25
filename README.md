# pi-subagent

[English](README.md) | [中文](README.zh.md)

Spawn isolated sub‑agents from pi. Each runs in its own context and streams results back.

```
You:  Research this project's database schema for me
  → pi calls subagent, spins up a child agent
  → Child works independently, sends results back
  → You keep chatting
```

> Only works on Linux/macOS (requires Unix socket + tmux).

## Why?

Pi doesn't have built‑in sub‑agents. When you want to split work across multiple agents running in parallel, or send a long‑running task to the background without blocking your main conversation — that's what `subagent` is for.

## Install

```bash
pi install git:github.com/everyx/pi-subagent
```

Or manually:

```bash
mkdir -p ~/.pi/agent/extensions/subagent
ln -sf "$(pwd)/index.ts" ~/.pi/agent/extensions/subagent/index.ts
ln -sf "$(pwd)/runner.ts" ~/.pi/agent/extensions/subagent/runner.ts
```

Restart pi and just tell it "ask a sub‑agent to…".

## Usage

### Kick off a task

Tell pi:

```
Ask a sub‑agent to analyze the auth logic under src/
```

Pi calls `subagent`, a child agent runs in isolation, and the result comes back — you continue from there.

### Run several at once

```
Spawn three sub‑agents to look at the auth module, the database layer, and the API routes
```

Pi runs all three in parallel and returns the combined results.

### Interactive — watch it work

```
Start an interactive sub‑agent to refactor the data layer with repository pattern, I want to watch
```

Pi creates a tmux session. The result includes its name (e.g. `pi-sub-a1b2c`), so you can attach:

```bash
tmux attach -t pi-sub-a1b2c
```

Detach (Ctrl+B D) and the child keeps running. Results come back automatically.

### Send a follow‑up (battle)

```
That data‑layer sub‑agent — the approach won't work, rewrite it with composition instead
```

Pi pastes the new prompt into the child's editor. The child continues and its new result comes back.

### Close a session

```
Kill pi-sub-a1b2c
```

## Two modes

| | Non‑interactive | Interactive |
|---|---|---|
| Backend | `pi --print --no-session`, zero overhead | Full pi in tmux |
| Attachable | ❌ | ✅ `tmux attach -t pi-sub-xxx` |
| Follow‑ups | ❌ | ✅ |
| Best for | Quick queries, one‑offs | Complex work, exploration, iteration |

Non‑interactive is the default — fast and lightweight. Reach for interactive when you need to watch or iterate.

## Advanced

### Pick a model

```
Spawn a sub‑agent with claude-sonnet to analyze the database design
```

No model specified → inherits your current session's model.
Model specified but not found in the registry → falls back to the parent model with a warning.

### Restrict tools

```
Ask a sub‑agent to research the project structure, but only let it use bash and read
```

Sub‑agent won't see any other tools.

## Cleanup

When pi exits, if sub‑agents are still running:
- **TUI mode** — asks whether to kill them
- **Headless mode** — kills silently

You can also tell pi "kill that sub‑agent" any time.
