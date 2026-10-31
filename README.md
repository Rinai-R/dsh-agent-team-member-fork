# dsh-agent-team-member-fork

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh) plugin for **Agent Teams**. It lets the Team Lead create a new teammate whose context is forked from an **existing teammate's** conversation, not from the Lead's.

Example: a long-lived `billing` teammate has spent many turns learning a subsystem. With `spawn_teammate_from`, the Lead can start `billing-refunds` from that teammate's completed history and give it a parallel task, without explaining the subsystem again.

The plugin adds two things:

- **Subagent provider `fork-from`.** Its `prepareContinuable()` seeds the child Session with the source teammate's completed-turn prefix: every event up to and including the source's last `turn/end`.
- **Model tool `spawn_teammate_from`.** It is installed on every Team member with the same schema, and only the Lead may execute it. It calls `ctx.agentTeams.spawnTeammate(lead, { context: 'fork', provider: 'fork-from', … })`.

The new teammate is an ordinary Team member. It is a direct child of the Lead, is continuable, shows up in `list_agents`, and receives `send_message`.

## Prerequisites

- DeepSeek Harness `>=0.2.1-rc.5 <0.3.0` (declared in `engines.dsh`).
- The **Agent Teams (Experimental)** bundle (`@deepseek-ai/dsh-experimental-agent-team-profile`) enabled in the same profile. This plugin injects `agents`, `agentTeams`, `subagents`, `tools`, and `sessionQuery`. If any of them is missing, the plugin stays `pending (waiting for service: …)`.

## Install

Enable Agent Teams, then install the published npm package.

Plugins page: **Add package**, then enter `dsh-agent-team-member-fork`.

CLI (quit Desktop first when targeting the `desktop` profile):

```sh
dsh plugin --profile <profile> add dsh-agent-team-member-fork
```

The package is a dsh bundle (`dsh.bundle.patch: ./cordis.patch.yml`). The bundle inserts one row with `config: {}`. It does not re-insert any Agent Teams rows.

### Configuration

| key | default | meaning |
|---|---|---|
| `providerName` | `fork-from` | Subagent provider name registered on `ctx.subagents` and recorded as the member's `provider`. |

## Tool usage

`spawn_teammate_from` (Lead only):

| param | required | description |
|---|---|---|
| `source` | yes | Name of the existing teammate whose conversation is copied. |
| `name` | yes | New teammate name. It must be lower-kebab-case, at most 64 characters, not `lead`, and never used before in this Team (the same rules as `spawn_teammate`). |
| `description` | yes | Short responsibility, at most 200 characters. |
| `task` | yes | Complete initial task. **Restate the working directory, worktree, and write scope**, because the child inherits the source's history, including where the source was working. |

The result has the same fields as `spawn_teammate` (`{ member: {...} }`) plus `forked_from: "<source>"`.

The child's initial prompt is one text block with three parts:

1. a `<system-reminder>` identity block (`You are teammate "<name>".` …);
2. a notice: `The conversation above belongs to teammate "<source>". Its identity, task and working directory no longer apply to you. You are a new teammate forked from its context.`;
3. the task.

Validation rules:

- The caller must be the Team Lead.
- `source` must be an existing teammate that is not `failed` or `provisioning`. `lead` is rejected; use `spawn_teammate` with `context: "fork"` instead.
- The source must have at least one completed turn.

After a successful spawn, the plugin appends a log-only plugin record `plugin:dsh-agent-team-member-fork/lineage` (`{ version: 1, childId, childName, sourceId, sourceName, cutSeq }`) to the Lead Session. This record never reaches the model.

## When to use it vs `spawn_teammate`

| need | use |
|---|---|
| A clean teammate with no history | `spawn_teammate` `context: "fresh"` |
| A teammate that knows what **the Lead** knows | `spawn_teammate` `context: "fork"` |
| A teammate that knows what **an existing teammate** knows (parallelize an expert, hand off a branch of its work) | `spawn_teammate_from` |

## How it works

`spawnTeammate()` cannot carry provider data in rc.5, and `ContinuableCreateRequest` only names the Lead (`parent`). The child id is minted inside TeamService. So the tool hands the source to the provider through a **per-Lead in-process side channel**:

1. A per-Lead mutex serializes `spawn_teammate_from` calls for that Lead. Different Leads run concurrently.
2. Inside the mutex, the tool stages `{sourceId, sourceName}` under the Lead id and calls `spawnTeammate`.
3. The provider takes the staged entry **exactly once**. It reads the source through `ctx.sessionQuery.observeSession(sourceId, { projectionMode: 'none' })`, which works for live and cold sources and takes no writer lock, and then disposes the observation. It checks that the source header's `parentSession` is this Lead and returns the cut prefix as `seed`.
4. The staged entry is cleared in `finally`, whatever the outcome.

If the provider is selected without a staged source, `prepareContinuable` throws. This happens, for example, when someone calls `spawn_teammate` with a custom provider name. TeamService then records the member as `failed`. The provider never falls back to the Lead's context or to a fresh child.

**Cold resume does not need this plugin.** SubagentService resumes continuable children from their own `subagent/descriptor`, and the provider is only used at creation. The integration test unloads the plugin and then wakes the forked teammate with a Team message.

## Known limitations

- **Side-channel handoff.** The source travels through in-process state keyed by the Lead id, not through `spawnTeammate`. This is safe under the per-Lead mutex, but it is a workaround. **Upstream ask:** pass opaque provider data through `SpawnTeammateRequest` → `startActivation` → `ContinuableCreateRequest`.
- **Inbox replay (UNVERIFIED).** The source's pending inbox items that were spliced before the cut may replay in the child. The official `fork` provider has the same risk.
- **Lineage lives only in the plugin record.** The child's Session header `parentSession` is the Lead. Lineage to the source exists only in the Lead-log plugin record, and Session format migrations retain plugin records on a best-effort basis only.
- **Context size.** The child inherits the source's whole completed history, including the source's own inherited prefix if the source was itself forked.
- **Mid-turn sources.** A running source is cut at its last *completed* turn. Work of the in-flight turn is not copied.
- **Role enforcement.** The tool is visible to every Team member, which keeps seeded tool histories consistent. The Lead check happens at execute time.

## Development

```sh
export npm_config_cache=/tmp/dsh-npm-cache   # optional
npm ci
npm run typecheck
npm run build
npm test            # unit tests + real Cordis composition integration test
npm pack --dry-run
```

`types/rc5-type-shims.d.ts` is a typecheck-only shim for an rc.5 packaging gap. `@deepseek-ai/dsh-subagent`'s `projection.d.ts` is not reachable from its exported entry points, so `@deepseek-ai/dsh-session-projection`'s d.ts fails under `skipLibCheck: false`.

## License

MIT © 2026 Rinai-R
