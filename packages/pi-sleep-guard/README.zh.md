# pi-sleep-guard

[English](README.md) | [中文](README.zh.md)

**LLM 干活时机器不睡，所有 turn 结束即恢复——主 agent 和子代理全覆盖。**

```
你： 跑一遍全量测试，再让子 agent 深度调研这个问题
  → 主 agent 运行中，系统休眠被阻断
  → 子 agent（独立 pi 进程）各自运行时，各自持锁
  → 所有 turn 结束的瞬间，休眠策略恢复原样
```

## 为什么需要它？

长任务动辄几十分钟：全量测试、大规模重构、多代理并行调研。人走开了，
系统按空闲策略睡掉，SSH 断连、任务中断、进度作废。pi-sleep-guard 让
"agent 还在干活"和"机器保持清醒"严格同步——不多锁一秒，不少锁一秒。

## 工作原理

全局安装后，**每个 pi 进程都自带一份守卫**——你的主会话、每个
`pi --mode rpc` 子代理进程都是。各进程只在本进程 agent 运行期间持有
平台原生的休眠抑制器：

| 平台 | 抑制器 |
| --- | --- |
| macOS | `caffeinate -i -w <pid>` |
| Linux | `systemd-inhibit --what=sleep:idle` |
| Windows | PowerShell + `SetThreadExecutionState` |

OS 对休眠抑制器是"任一持有即阻止"语义：主 agent 和子代理之间**不需要任何
协调机制**。每个抑制器进程都监视父 pid 并在父进程死亡时自动退出——pi 崩溃
也绝不会留下孤儿进程把机器永久钉在清醒状态。

## 承诺分级

- **保证 — 主 agent**：从 `agent_start` 到 `agent_settled` 全程持锁
  （含工具执行间隙、自动重试、排队续跑）。
- **保证 — pi RPC 形态的子代理**（含
  [@everyx/pi-subagent](https://github.com/everyx/pi-extensions) 的前台 /
  后台 / persistent 全形态）：每个子进程自己精确持锁。
- **不承诺 — 其他后台实现**：以 `pi --mode rpc` 运行的免费获得覆盖；
  其余形态只有主 agent 级保护。

## 诚实的边界

- **用户主动睡眠**（合盖、电源键、菜单点睡眠）在任何平台都会无视一切
  抑制器直接生效——这是 OS 的设计意图，不是本包能违背的。
- 无平台后端的系统（如无 systemd 的 Linux）会收到一次性警告；agent
  照常工作，只是不休眠阻断。

## 配置

- `PI_SLEEP_GUARD_DISPLAY=1` — 连屏幕熄灭一起挡（默认只挡系统睡眠，
  屏幕照常熄灭，你可以正常锁屏走人）。
