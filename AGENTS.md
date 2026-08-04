# pi-subagent

See [SPEC.md](SPEC.md) for design intent.

## Rules

- 空行：用 `Text("\n" + content)`，别用 `Text("")`
- 渲染函数内禁止同步调用 `context.invalidate()`
- 不加 token limit
- 不加 spawn-failure 通知
