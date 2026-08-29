# pi-sleep-guard

[English](README.md) | [中文](README.zh.md)

Keeps the machine awake while pi agents are running — releases the moment every turn settles.

## How it works

Install globally (`~/.pi/agent/extensions` or as a pi package) and every pi
process — your main session and each `pi --mode rpc` sub-agent child — runs
its own guard. Each process holds a platform sleep inhibitor exactly while
its own agent is running:

| Platform | Holder |
| --- | --- |
| macOS | `caffeinate -i -w <pid>` (`-d` with `PI_SLEEP_GUARD_DISPLAY=1`) |
| Linux | `systemd-inhibit --what=sleep:idle` (no display axis on this platform) |
| Windows | PowerShell + `SetThreadExecutionState` (`ES_DISPLAY_REQUIRED` optional) |

Sleep inhibitors are OR-semantics at the OS level: any single holder keeps the
machine awake, so main agent and sub-agents need no coordination whatsoever.
Every holder watches its parent pid and self-terminates if the pi process
dies — a crash can never leave an orphan blocking sleep.

## Guarantees

- **Main agent**: held from `agent_start` to `agent_settled` (covers tool
  execution and queued continuations between turns).
- **Sub-agents that are `pi --mode rpc` processes** (including
  [@everyx/pi-subagent](https://github.com/everyx/pi-extensions), foreground,
  background, persistent): each child holds its own lock while running.
- Other background-agent implementations: not promised. If they run as pi RPC
  children they are covered for free; otherwise only main-agent protection applies.

## Honest limits

- User-initiated sleep (lid close, power button, sleep menu) overrides any
  inhibitor on all three platforms — by OS design.
- On systems without the platform backend (e.g. Linux without systemd), you get
  a one-time warning; agents keep working, sleep simply isn't blocked.

## Config

- `PI_SLEEP_GUARD_DISPLAY=1` — also block display off (default: system sleep
  only, the screen may blank normally).

