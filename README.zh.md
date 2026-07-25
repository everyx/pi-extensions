# pi-subagent

[English](README.md) | [中文](README.zh.md)

让 pi 能派生子 agent，在隔离上下文里跑任务，结果流回主会话。

```
用户：帮我研究一下这个项目的数据库设计，总结表结构
  → pi 调 subagent 派子 agent 去做
  → 结果回来，继续往下聊
```

## 为什么需要这个？

pi 不内置子 agent。遇到复杂问题你想分拆给多个 agent 并行探索，或者让一个 agent 做耗时研究不阻塞主对话——这时候就要 `subagent`。

> 目前只支持 Linux/macOS（依赖 Unix socket + tmux）。

## 安装

```bash
pi install git:github.com/everyx/pi-subagent
```

或者手动：

```bash
mkdir -p ~/.pi/agent/extensions/subagent
ln -sf "$(pwd)/index.ts" ~/.pi/agent/extensions/subagent/index.ts
```

装好后重启 pi，直接跟它说"让子 agent 做 X"就行了。

## 场景

### 让子 agent 跑个任务

跟 pi 说：

```
让子 agent 分析一下 src/ 下的认证逻辑
```

pi 会调 `subagent` 起一个隔离的子 agent 去做，结果回来之后你可以继续问。

### 同时跑多个

```
派三个子 agent，分别分析认证模块、数据库层和 API 路由
```

pi 会并行启动三个子 agent，结果聚合到一起返回。

### 跑个交互式的，盯着它干

```
启动一个交互式子 agent，重构数据层用 repository 模式，我要看着它干
```

pi 会创建一个 tmux 会话，结果里会返回 session 名（比如 `pi-sub-a1b2c`），你可以 attach：

```bash
tmux attach -t pi-sub-a1b2c
```

Detach（Ctrl+B D）后子 agent 继续跑，结果自动回来。

### 对正在干的 agent 追加指令

```
之前那个数据层的子 agent，那个方案不行，改用组合模式重写
```

新指令会粘贴到子 agent 的编辑器里，它继续干活，结果回来。

### 关闭一个会话

```
把 pi-sub-a1b2c 关掉
```

## 两种运行模式

| | 非交互 | 交互 |
|---|---|---|
| 怎么跑 | `pi --print --no-session`，零开销 | tmux 里起完整 pi 会话 |
| 能不能盯着看 | ❌ | ✅ `tmux attach -t pi-sub-xxx` |
| 能不能追加指令 | ❌ | ✅ |
| 适用场景 | 简单查询、一次性任务 | 复杂重构、探索性分析 |

非交互是默认的，又快又轻。需要人盯着或者来回迭代时才用交互模式。

## 进阶玩法

### 指定模型

你可以让子 agent 用不同的模型：

```
派个子 agent，用 claude-sonnet 分析数据库设计
```

不指定模型 → 沿用主会话的模型。
指定了但 registry 里找不到 → 降级到主模型，给你个 warning。

### 限制工具

```
让子 agent 只准用 bash 和 read，研究一下项目结构
```

子 agent 就看不到其他工具了。

## 退出清理

退出 pi 时如果有子 agent 还在跑：
- **TUI 模式**：弹框问你要不要杀掉
- **Headless 模式**：静默清理

也可以提前跟 pi 说"把那个子 agent 关掉"。
