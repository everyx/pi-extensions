# pi-subagent

Sub‑agent extension for [pi](https://pi.dev). Delegates tasks to isolated pi instances via tmux.

## How it works

Two‑mode extension that runs inside both the **parent** and the **child** pi process:

1. **Parent mode** (default) – registers the `subagent` tool
2. **Child mode** (env var `PI_SUBAGENT_PARENT_SOCKET`) – listens for `agent_settled` and reports the result back via Unix socket

### Execution modes

| Mode | Backend | tmux | Attachable |
|------|---------|------|------------|
| `interactive: false` (default) | `pi --print --no-session` | ❌ | ❌ |
| `interactive: true` | tmux + pi interactive | ✅ | ✅ `tmux attach -t pi-sub-xxx` |

### Battle

When a sub‑agent runs interactively, the parent can send follow‑up prompts by calling `subagent` again with the same `session` name. The new prompt is pasted into the child's pi editor via tmux paste‑buffer, and the child reports its next result when `agent_settled` fires.

The parent agent can go back‑and‑forth with a sub‑agent programmatically, or you can `tmux attach` and join the conversation yourself.

## Install

```bash
# From git repo
pi install git:github.com/everyx/pi-subagent

# Or clone and symlink for development
git clone https://github.com/everyx/pi-subagent ~/.pi/agent/git/pi-subagent
pi config  # enable the extension
```

Or manually symlink:

```bash
mkdir -p ~/.pi/agent/extensions
ln -sf "$(pwd)/index.ts" ~/.pi/agent/extensions/subagent/index.ts
```

The extension is auto‑loaded in every pi session. In child mode it detects the env var and only reports results – no tool registered.

## Usage

### Single task (non‑interactive)

The main agent calls:

```
subagent({ task: "Find all auth‑related code and summarize the architecture" })
```

Result is captured stdout from `pi --print`.

### Single task (interactive, attachable)

```
subagent({ task: "Refactor the database layer", interactive: true })
```

A tmux session `pi-sub-<id>` is created. The session name appears in the tool result so you can:

```bash
tmux attach -t pi-sub-abc123
```

The child pi runs in that tmux. Detach (Ctrl+B D) to let it continue autonomously.

### Battle (follow‑up with a running sub‑agent)

```
subagent({ session: "pi-sub-abc123", task: "I don't like that approach, try using composition instead" })
```

The new prompt is pasted into the child's editor. The parent waits for the child to settle, then reads the new result.

### Parallel tasks

```
subagent({
  tasks: [
    { id: "auth", task: "Analyze the auth module" },
    { id: "db",   task: "Analyze the database layer" },
  ]
})
```

Each runs in parallel (or sequentially for now – concurrency coming). Results are combined into one response.

### Close a session

```
subagent({ session: "pi-sub-abc123", close: true })
```

Kills the tmux session and cleans up the socket.

## Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `task` | `string` | — | Task prompt (single mode) |
| `tasks` | `array` | — | Parallel tasks `[{id?, task, model?, tools?}]` |
| `session` | `string` | — | Existing session name (battle or close) |
| `close` | `boolean` | — | Close the session |
| `model` | `string` | — | Model override (single mode) |
| `tools` | `string` | — | Tool allowlist (single mode) |
| `interactive` | `boolean` | `false` | Spawn in tmux for attachability |

## Cleanup

On exit (Ctrl+C, Ctrl+D, SIGHUP, SIGTERM), the extension checks for active sub‑agent sessions. In interactive (TUI) mode it asks whether to kill them; in headless mode it kills them silently.

## Protocol

Child → Parent (Unix socket):

```
[4 bytes: BE uint32 length][UTF-8 text]
```

The child connects, sends one packet, disconnects. Each round uses a fresh connection.
