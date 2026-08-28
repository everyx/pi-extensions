# pi-sleep-guard 设计

## Why：每进程自持，零契约

需求是"LLM 执行期间阻断系统休眠，所有 turn（含 subagent）结束再恢复"。

两条架构路线：

1. **中心化**：主进程观测一切、持有一把锁。缺点：主进程看不见子代理
   （子代理是独立 `pi --mode rpc` 进程），必须引入跨包事件契约——
   契约即多义入口，其他实现还得主动接入。
2. **分布式（本包采用）**：sleep-guard 全局安装后存在于每个 pi 进程，
   各自在本进程 agent 运行时持有平台 inhibitor。OS 对休眠 blocker 是
   OR 语义——任一持有者即可阻止休眠，跨进程协调天然不需要。

已 e2e 坐实的前提：`pi --mode rpc` 子进程会加载全局扩展并收到本进程的
`agent_start` / `agent_settled`。

## Module 清单

| module | 职责 | 接口 |
| --- | --- | --- |
| `wake-lock.ts` | 平台锁：holder 子进程监督 + RAII | `buildHolder()` 纯决策表、`WakeLock` 幂等锁 |
| `index.ts` | 扩展入口：agent 生命周期 → 锁 | 默认导出 extension 工厂 |

- `buildHolder(platform, {display, watcherPid})` 是纯函数决策表（表测试覆盖）；
  holder 一律带父 pid 自杀机制（caffeinate `-w` / `kill -0` 轮询 /
  PowerShell Get-Process 轮询），pi 崩溃 ⇒ holder 自动退出 ⇒ 永无孤儿锁。
- `WakeLock` 幂等：重叠的 agent_start（如重试/压缩）复用同一 holder，一次 release 即释放，防止引用计数泄漏。
  spawn 失败/无后端 → 一次性警告 + 如实 no-op（能力缺失不静默），
  绝不阻塞 agent 本身。

## 承诺分级

| 级别 | 覆盖 | 机制 |
| --- | --- | --- |
| 保证 | 主 agent 全程（含工具执行间隙、排队续跑） | 本进程 `agent_start…agent_settled` |
| 保证 | 以 `pi --mode rpc` 运行的子代理（含 pi-subagent 全形态） | 各子进程自持 |
| 不承诺 | 非 pi 进程形态的后台实现 | README 明示 |

诚实边界：用户主动睡眠（合盖/电源键/睡眠菜单）在三大平台都无视任何
inhibitor——OS 设计如此，文档如实声明。

## 配置

- `PI_SLEEP_GUARD_DISPLAY=1`：连屏幕熄灭一起挡（默认只挡系统睡眠）。

## 测试

`buildHolder` 决策表全平台分支（win32 断言解码后的 EncodedCommand 内容）、
WakeLock 幂等/空释放/no-backend 警告一次性。真实 holder 行为属 OS
集成面，靠人工冒烟（`pmset -g assertions` / `systemd-inhibit --list` /
`powercfg /requests` 可观测）。
