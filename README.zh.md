# dsh-agent-team-member-fork

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）的 **Agent Teams** 插件：让 Team Lead 基于**某个现有 teammate** 的对话分叉出新的 teammate，而不是基于 Lead 自己的上下文。

典型场景：一个长期存在的 `im-push` 专家已经用很多轮对话熟悉了某个子系统。Lead 用 `spawn_teammate_from` 可以从它已完成的历史创建 `im-push-b`，直接分配并行任务，不必重新讲解背景。

插件提供两部分：

- **subagent provider `fork-from`**：`prepareContinuable()` 用源 teammate 的已完成轮次前缀作为子 Session 的 seed，即源日志中直到最后一个 `turn/end`（含）的全部事件。
- **模型工具 `spawn_teammate_from`**：以相同的 schema 安装到每个 Team 成员上，但只有 Lead 能执行。它调用 `ctx.agentTeams.spawnTeammate(lead, { context: 'fork', provider: 'fork-from', … })`。

新 teammate 是普通的 Team 成员：Lead 的直接子级、可续接，会出现在 `list_agents` 中，也能接收 `send_message`。

## 前置条件

- DeepSeek Harness `>=0.2.1-rc.5 <0.3.0`（由 `engines.dsh` 声明）。
- 同一 profile 中已启用 **Agent Teams (Experimental)** bundle（`@deepseek-ai/dsh-experimental-agent-team-profile`）。插件注入 `agents`、`agentTeams`、`subagents`、`tools`、`sessionQuery`；其中任一服务缺失时，插件保持 `pending (waiting for service: …)`。

## 安装

插件页面（Desktop / Web GUI）：点击 **Add package**，输入 `dsh-agent-team-member-fork`；也可以输入本地目录或 `.tgz` 的**绝对路径**。

命令行（目标是 `desktop` profile 时，需先完全退出 Desktop）：

```sh
dsh plugin --profile <profile> add dsh-agent-team-member-fork
# 本地开发（记录为 link:，直接加载仓库内的 lib/）
npm ci && npm run build
dsh plugin --profile <profile> add /absolute/path/to/dsh-agent-team-member-fork
```

本包是一个 dsh bundle（`dsh.bundle.patch: ./cordis.patch.yml`），只插入自身的一行，配置为 `config: {}`，不会重复插入 Agent Teams 的行。

### 配置

| 键 | 默认值 | 含义 |
|---|---|---|
| `providerName` | `fork-from` | 注册到 `ctx.subagents` 的 provider 名称，同时记录为成员的 `provider`。 |

## 工具用法

`spawn_teammate_from`（仅 Lead 可用）：

| 参数 | 必填 | 说明 |
|---|---|---|
| `source` | 是 | 要复制其对话的现有 teammate 名称。 |
| `name` | 是 | 新 teammate 名称：小写 kebab-case，最多 64 个字符，不能是 `lead`，且在本 Team 中从未用过（规则与 `spawn_teammate` 相同）。 |
| `description` | 是 | 简短职责说明，最多 200 个字符。 |
| `task` | 是 | 完整的初始任务。**请重申工作目录、worktree 和写入范围**，因为子级会继承源 teammate 的历史，其中包括源当时的工作位置。 |

返回字段与 `spawn_teammate` 相同（`{ member: {...} }`），另加 `forked_from: "<source>"`。

子级的初始提示是一个文本块，依次包含三部分：

1. `<system-reminder>` 身份块（`You are teammate "<name>".` …）；
2. 说明：`The conversation above belongs to teammate "<source>". Its identity, task and working directory no longer apply to you. You are a new teammate forked from its context.`；
3. 任务正文。

校验规则：

- 调用方必须是 Team Lead。
- `source` 必须是现有 teammate，且状态不是 `failed` 或 `provisioning`。`lead` 会被拒绝；如需复制 Lead 的上下文，请用 `spawn_teammate` 并设置 `context: "fork"`。
- 源 teammate 至少要有一个已完成的轮次。

创建成功后，插件会向 Lead Session 追加一条仅记录在日志中的 plugin record：`plugin:dsh-agent-team-member-fork/lineage`（`{ version: 1, childId, childName, sourceId, sourceName, cutSeq }`）。该记录不会进入模型上下文。

## 与 `spawn_teammate` 的选择

| 需求 | 使用 |
|---|---|
| 没有任何历史的全新 teammate | `spawn_teammate`，`context: "fresh"` |
| 了解 **Lead** 所知内容的 teammate | `spawn_teammate`，`context: "fork"` |
| 了解**某个现有 teammate** 所知内容的 teammate（把专家并行化，或接手其工作的一个分支） | `spawn_teammate_from` |

## 工作原理

rc.5 中 `spawnTeammate()` 无法携带 provider 数据，`ContinuableCreateRequest` 也只包含 Lead（`parent`），子级 id 由 TeamService 内部生成。因此工具通过**按 Lead 区分的进程内旁路**把源信息交给 provider：

1. 按 Lead 加互斥锁：同一 Lead 的 `spawn_teammate_from` 调用串行执行，不同 Lead 之间互不阻塞。
2. 在锁内，工具以 Lead id 为键暂存 `{sourceId, sourceName}`，然后调用 `spawnTeammate`。
3. provider **只取一次**暂存项，通过 `ctx.sessionQuery.observeSession(sourceId, { projectionMode: 'none' })` 读取源日志（源在线或离线均可，不占写锁），读完即释放 observation。随后它校验源 header 的 `parentSession` 等于当前 Lead，并把截断后的前缀作为 `seed` 返回。
4. 无论结果如何，暂存项都在 `finally` 中清除。

如果在没有暂存源的情况下选用该 provider（例如有人用自定义 provider 名称调用 `spawn_teammate`），`prepareContinuable` 会抛出错误，TeamService 随即把该成员记录为 `failed`。provider 绝不会回退到 Lead 的上下文，也不会退化为全新子级。

**冷恢复不依赖本插件。** SubagentService 依据子级自身的 `subagent/descriptor` 恢复可续接子级，provider 只在创建时使用。集成测试会先卸载插件，再用 Team 消息唤醒分叉出的 teammate，以验证这一点。

## 已知限制

- **旁路交接。** 源信息通过以 Lead id 为键的进程内状态传递，而不是经由 `spawnTeammate`。在按 Lead 互斥的前提下这是安全的，但仍属变通做法。**上游诉求：** 让不透明的 provider 数据沿 `SpawnTeammateRequest` → `startActivation` → `ContinuableCreateRequest` 传递。
- **收件箱重放（未验证）。** 源 teammate 在截断点之前 splice 进来、尚未处理的收件箱条目，可能会在子级中重放。官方 `fork` provider 也有同样的风险。
- **血缘关系只记录在 plugin record 中。** 子级 Session header 中的 `parentSession` 是 Lead；到源 teammate 的血缘关系只存在于 Lead 日志的 plugin record 里，而 Session 格式迁移对 plugin record 只做尽力保留。
- **上下文体积。** 子级会继承源 teammate 的全部已完成历史；如果源本身也是分叉出来的，还包括它继承的前缀。
- **源正在运行时。** 截断点是源最后一个*已完成*的轮次，进行中轮次的工作不会被复制。
- **角色校验。** 工具对所有 Team 成员可见，以保持 seed 中工具历史的一致；Lead 身份在执行时校验。

## 开发

```sh
npm ci
npm run typecheck
npm run build
npm test            # 单元测试 + 真实 Cordis 组合的集成测试
npm pack --dry-run
```

`types/rc5-type-shims.d.ts` 是仅用于类型检查的补丁，弥补 rc.5 的一个打包缺口：`@deepseek-ai/dsh-subagent` 的 `projection.d.ts` 无法从其导出入口访问到，导致 `@deepseek-ai/dsh-session-projection` 的 d.ts 在 `skipLibCheck: false` 下报错。

## 许可证

MIT © 2026 Rinai-R
