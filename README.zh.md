<h1 align="center">dsh-agent-team-member-fork</h1>

<p align="center">
  <a href="README.md">English</a> ·
  <a href="README.zh.md">简体中文</a>
</p>

<p align="center">从已有上下文的 Agent Teams teammate 再分出一个 teammate。</p>

`spawn_teammate` 可以复制 Lead，或从空白开始。这个插件复制一个已有 teammate，让新工作线带上那段历史。

- **从 teammate 来：** 长期存在的 `billing` 可以作为 `billing-refunds` 的来源。
- **只有 Lead 能执行：** 每个成员看到的工具相同，只有 Lead 能调用。
- **普通成员：** 子级可恢复，会出现在 `list_agents`，也能接收 `send_message`。
- **不带走未处理消息：** 来源还有未领取的收件箱时会拒绝，避免那些消息重放。
- **恢复不依赖本插件：** 创建之后，子级从自己的会话恢复。

## 开始使用

### 前置条件

- DeepSeek Harness `>=0.2.1-rc.5 <0.3.0`
- 同一 profile 已开启 Agent Teams

### 插件

在 dsh 里打开 **Plugins → Install a third-party plugin**，输入 `dsh-agent-team-member-fork`。或者在终端：

```bash
dsh plugin --profile web add dsh-agent-team-member-fork
```

安装到 `desktop` profile 前先退出 Desktop。重启 dsh。让 Lead 调用 `spawn_teammate_from`，参数是 `source`、`name`、`description`、`task`。在 `task` 里重新写明工作目录。

| 需求 | 用法 |
|---|---|
| 没有历史 | `spawn_teammate`，`context: "fresh"` |
| Lead 的历史 | `spawn_teammate`，`context: "fork"` |
| 已有 teammate 的历史 | `spawn_teammate_from` |

## 限制

来源必须有已完成的轮次，且不能是失败或仍在创建。子级继承已完成的历史，不继承来源当前这一轮。记录上的父会话仍是 Lead。

## 开发

```bash
npm ci
npm run typecheck
npm run build
npm test
```

## 许可证

MIT。与 DeepSeek 无关。
