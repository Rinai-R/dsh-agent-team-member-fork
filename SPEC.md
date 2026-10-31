# dsh-agent-team-member-fork — v0.1 implementation spec

Target runtime: DeepSeek Harness 0.2.1-rc.5 with the Agent Teams bundle enabled.
API evidence: `../dsh-agent-team-scheduler/research/api-findings.md` (Q2, Q4, Q8, Q9, Q10). Packaging: `../dsh-agent-team-scheduler/research/packaging-findings.md`.

## 1. What it does

Lets the Team Lead create a new teammate whose context is forked from an **existing teammate** (for example a long-lived `im-push` expert) instead of from the Lead:

- a subagent provider `fork-from` whose `prepareContinuable()` seeds the child with the source teammate's completed-turn prefix;
- a Lead-only model tool `spawn_teammate_from` that stages the source and calls `ctx.agentTeams.spawnTeammate(lead, { context: 'fork', provider: 'fork-from', ... })`.

The child is an ordinary Team member (direct child of the Lead, continuable). Cold resume does not need this plugin (descriptor-based, see findings Q8).

## 2. Module layout

```
src/
  index.ts      plugin entry: name, inject, Config, apply
  types.ts      types only
  handoff.ts    per-Lead staged source + per-Lead async mutex
  seed.ts       PURE: cut a SessionEvent[] to the last turn/end; validation helpers
  provider.ts   SubagentProvider implementation
  tool.ts       spawn_teammate_from definition + execute
  lineage.ts    plugin record for lineage
tests/
```

## 3. Plugin entry

```ts
export const name = 'agent-team-member-fork'
export const inject = ['agents', 'agentTeams', 'subagents', 'tools', 'sessionQuery']
export interface Config {
  providerName: string   // default 'fork-from'
}
```

`apply`: register provider (`ctx.subagents.registerProvider`, returns disposer → wrap in `ctx.effect`), install the tool on every Team member the same way tool-agent-team does (`ctx.agents.list()` + `agent/created` + `agent/disposed`, `agent.ctx.tools.register(defineTool(...))`, identical schema for all members).

## 4. Provider

```ts
{
  name: config.providerName,
  capabilities: { agentOptions: true, agentPreset: false, outputSchema: true, depthLimit: true },
  inheritsParentContext: true,
  async prepareContinuable({ parent, sessionId, signal }) {
    const staged = handoff.take(parent.id)   // throws Error('fork-from: no source staged for this Lead') when absent
    const events = await readSourceEvents(staged.sourceId, signal)
    const seed = completedTurnPrefix(events) // [] → throw: source has no completed turn
    staged.resolveCut(lastSeq)               // lets the tool record lineage
    return { seed }
  }
}
```

- `readSourceEvents`: `using obs = await ctx.sessionQuery.observeSession(sourceId, { signal, projectionMode: 'none' })` → copy `obs.events` (works live and cold, no writer lock). Dispose the observation.
- `completedTurnPrefix(events)`: slice `[0 .. index of last event with type 'turn/end']` inclusive; require `events[i].seq === i` for the kept slice (contiguous from 0), otherwise throw.
- Never fall back to the Lead's context or a fresh child; a missing handoff must fail so TeamService records the member as `failed`.

## 5. Handoff (`handoff.ts`)

- `withLeadLock(leadId, fn)`: per-Lead promise chain mutex; concurrent `spawn_teammate_from` calls for the same Lead run serially.
- `stage(leadId, { sourceId, sourceName })` inside the lock, `take(leadId)` consumed once by the provider, `clear(leadId)` in `finally`.
- Any staged entry left after the spawn returns is cleared.

## 6. Tool `spawn_teammate_from`

Params (schemastery-style spec like tool-agent-team):

```
source: string (required)       existing teammate name to fork from
name: string (required)         new teammate name (lowercase kebab-case, same rule as spawn_teammate)
description: string (required)  short responsibility (<= 200 chars)
task: string (required)         initial task
```

Execute:
1. `lead = exec.agent`; `ctx.agentTeams.membership(lead).role === 'lead'` else throw `only the Team Lead can spawn teammates`.
2. Resolve `source` in `listMembers(lead)`: must be role `teammate`, status not `failed`/`provisioning`; else throw a clear error.
3. `withLeadLock(lead.id)`: stage → `ctx.agentTeams.spawnTeammate(lead, { name, description, prompt, context: 'fork', provider: config.providerName, signal: exec.signal })` → clear.
4. `prompt` = one text block:
   - the identity reminder in the **exact format tool-agent-team's `spawn_teammate` uses** (copy it from `/tmp/dsh-research/pkgs/deepseek-ai-dsh-experimental-tool-agent-team-0.2.1-rc.5/lib/index.js`; it is a user-role `<system-reminder>` stating `You are teammate "<name>".`), followed by
   - `The conversation above belongs to teammate "<source>". Its identity, task and working directory no longer apply to you. You are a new teammate forked from its context.` and then the task text.
5. After success append lineage record to the Lead session: `appendPluginRecord(lead.session, 'plugin:dsh-agent-team-member-fork/lineage', { version: 1, childId, childName, sourceId, sourceName, cutSeq })` (declare via `PluginRecordMap` merging).
6. Return the same result fields as `spawn_teammate` (member view JSON) plus `forked_from: source`.

Description (model-facing) must explain when to use it versus `spawn_teammate` (context: fork copies the Lead; this copies an existing teammate), and warn to restate the working directory / worktree in `task`.

## 7. Tests (vitest)

- seed: cut at last turn/end, no turn/end → error, non-contiguous seq → error.
- handoff: serialization per Lead, independent Leads concurrent, take-once, cleanup on throw.
- provider: no staged source → throws; reads via sessionQuery; disposes observation.
- tool: non-lead rejected; unknown/failed/provisioning source rejected; spawnTeammate called with provider name + fork context + prompt text snapshot; lineage record appended; handoff cleared on spawn failure.
- apply/dispose: provider registration and tool registrations removed on dispose.

## 8. Known limitations (README)

- Source pending inbox items that were spliced before the cut may replay in the child (UNVERIFIED, same as the official fork provider).
- The child's session header `parentSession` is the Lead; source lineage exists only in the plugin record.
- The child inherits the source's whole completed history (context size).
