<h1 align="center">dsh-agent-team-member-fork</h1>

<p align="center">
  <a href="README.md">English</a> ·
  <a href="README.zh.md">简体中文</a>
</p>

<p align="center">Fork a new Agent Teams teammate from a teammate that already has the context.</p>

`spawn_teammate` can copy the Lead or start clean. This plugin copies an existing teammate, so a new line of work starts with that history.

- **From a teammate:** A long-lived `billing` teammate can be the source for `billing-refunds`.
- **Lead only:** Every member sees the same tool. Only the Lead can run it.
- **Ordinary member:** The child is continuable, listed by `list_agents`, and accepts `send_message`.
- **No pending mail:** A source with an unclaimed inbox is rejected, so those messages do not replay.
- **Resume without the plugin:** After creation, the child resumes from its own session.

## Getting Started

### Prerequisites

- DeepSeek Harness `>=0.2.1-rc.5 <0.3.0`
- Agent Teams enabled in the same profile

### Plugin

In dsh, open **Plugins → Install a third-party plugin** and enter `dsh-agent-team-member-fork`. Or from the terminal:

```bash
dsh plugin --profile web add dsh-agent-team-member-fork
```

Quit Desktop before installing into the `desktop` profile. Restart dsh. Ask the Lead to call `spawn_teammate_from` with `source`, `name`, `description`, and `task`. Restate the working directory in `task`.

| Need | Use |
|---|---|
| No history | `spawn_teammate`, `context: "fresh"` |
| The Lead's history | `spawn_teammate`, `context: "fork"` |
| An existing teammate's history | `spawn_teammate_from` |

## Limits

The source must have a completed turn and must not be failed or still starting. The child inherits that completed history, not the source's current turn. The official parent remains the Lead.

## Development

```bash
npm ci
npm run typecheck
npm run build
npm test
```

## License

MIT. Not affiliated with DeepSeek.
