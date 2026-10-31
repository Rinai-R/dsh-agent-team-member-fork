/**
 * Integration test over a real Cordis composition: AgentLoop, JSONL persistence, SubagentService,
 * spawn + fork providers, TeamService, a test SessionQuery, a routing mock LLM, and this plugin.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import TeamService from '@deepseek-ai/dsh-experimental-agent-team'
import { createUserMessage, type GenerateOptions } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SubagentService from '@deepseek-ai/dsh-subagent'
import * as SubagentFork from '@deepseek-ai/dsh-subagent-fork-in-process'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import * as MemberFork from '../src/index.js'
import { LINEAGE_RECORD_TYPE, lineageOf } from '../src/lineage.js'
import { lastTurnEndIndex } from '../src/seed.js'
import { RoutingMockAdapter, textResponse, toolCallResponse } from './support/mock-adapter.js'
import { observationStats, TestSessionQuery } from './support/test-session-query.js'

const SIGNAL = new AbortController().signal
const roots: string[] = []
const contexts: Context[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const WORKER_IDENTITY = 'You are teammate "worker".'

/** Route answers by Session and conversation content. */
function router() {
  const state = { forkIssued: false, workerCalls: 0 }
  const respond = (options: GenerateOptions) => {
    const text = JSON.stringify(options.messages)
    if (options.sessionId === 'lead') {
      if (!state.forkIssued && text.includes('FORK_NOW')) {
        state.forkIssued = true
        return toolCallResponse('call-fork-1', 'spawn_teammate_from', {
          source: 'expert',
          name: 'worker',
          description: 'parallel worker forked from expert',
          task: 'WORKER_TASK: work in /tmp/dsh-fork-worktree on part B.',
        })
      }
      return textResponse('LEAD DONE')
    }
    if (text.includes('WORKER_TASK')) {
      state.workerCalls += 1
      return textResponse(state.workerCalls === 1 ? 'WORKER DONE' : 'WORKER RESUMED')
    }
    return textResponse('EXPERT KNOWLEDGE: the push gateway uses topic X.')
  }
  return { state, respond }
}

async function setup() {
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx, { workingDirectory: true })
  const storageRoot = mkdtempSync(join(tmpdir(), 'dsh-fork-it-'))
  roots.push(storageRoot)
  await ctx.plugin(JsonlSessionPersistence, { root: storageRoot })
  await ctx.plugin(TestSessionQuery)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SubagentService)
  await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
  await ctx.plugin(SubagentFork, { providerName: 'fork' })
  await ctx.plugin(TeamService, {})
  const pluginFiber = await ctx.plugin(MemberFork, { providerName: 'fork-from' })
  const route = router()
  const adapter = new RoutingMockAdapter(route.respond)
  ctx.llm.registerAdapter(['mock'], adapter)
  const lead = await ctx.agentLoop.create(SessionId('lead'), { provider: 'mock', model: 'mock' })
  return { ctx, lead, adapter, route, pluginFiber }
}

async function storedEvents(ctx: Context, id: SessionId): Promise<{ events: readonly SessionEvent[]; inherited: number }> {
  const handle = await ctx.sessionPersistence.open(id, 'read')
  try {
    return { events: (await handle.read()).events, inherited: handle.inheritedEventCount }
  } finally {
    await handle.close()
  }
}

async function waitCold(ctx: Context, id: SessionId): Promise<void> {
  await vi.waitFor(() => { expect(ctx.agents.get(id)).toBeUndefined() }, { timeout: 10_000 })
}

function textOf(event: SessionEvent): string {
  return JSON.stringify(event.data)
}

describe('spawn_teammate_from in a real Team composition', () => {
  it('forks a new teammate from an existing teammate, records lineage, and cold-resumes without the plugin', async () => {
    const { ctx, lead, adapter, route, pluginFiber } = await setup()

    // The provider and the Lead-scoped tool are registered.
    expect(ctx.subagents.getProvider('fork-from')).toBeDefined()

    // 1. Lead spawns a fresh `expert`, which completes one scripted turn and goes cold.
    const expertStarted = await ctx.agentTeams.spawnTeammate(lead, {
      name: 'expert',
      description: 'long-lived domain expert',
      prompt: [{ type: 'text', text: 'EXPERT_TASK: learn the push gateway.' }],
      context: 'fresh',
      provider: 'spawn',
      signal: SIGNAL,
    })
    const expertId = expertStarted.member.id
    await waitCold(ctx, expertId)
    await lead.whenIdle()
    const expertLog = (await storedEvents(ctx, expertId)).events
    const expertCut = lastTurnEndIndex(expertLog)
    expect(expertCut).toBeGreaterThan(0)
    expect(expertLog.some(e => textOf(e).includes('EXPERT KNOWLEDGE'))).toBe(true)

    // 2. The Lead's model calls spawn_teammate_from (through the real tool registry and loop).
    lead.followup(createUserMessage({ content: [{ type: 'text', text: 'FORK_NOW' }], source: { kind: 'user' } }))
    await vi.waitFor(() => { expect(route.state.workerCalls).toBeGreaterThanOrEqual(1) }, { timeout: 10_000 })
    await lead.whenIdle()
    const roster = ctx.agentTeams.listMembers(lead)
    const worker = roster.find(m => m.name === 'worker')
    expect(worker).toMatchObject({ role: 'teammate', provider: 'fork-from', context: 'fork' })
    expect(worker?.status === 'running' || worker?.status === 'inactive').toBe(true)
    const workerId = worker!.id
    await waitCold(ctx, workerId)
    await lead.whenIdle()

    // The Lead's first request declared the tool.
    const leadForkRequest = adapter.requests.find(r => r.sessionId === 'lead' && JSON.stringify(r.messages).includes('FORK_NOW'))
    expect(leadForkRequest?.tools?.some(t => t.name === 'spawn_teammate_from')).toBe(true)

    // 3. The worker's log begins with expert's events through expert's last turn/end.
    const workerStored = await storedEvents(ctx, workerId)
    const workerLog = workerStored.events
    expect(workerStored.inherited).toBeGreaterThanOrEqual(expertCut + 1)
    expect(JSON.parse(JSON.stringify(workerLog.slice(0, expertCut + 1)))).toEqual(JSON.parse(JSON.stringify(expertLog.slice(0, expertCut + 1))))
    // Cold source → read through the prepared (persistence) path, and every lease was released.
    expect(TestSessionQuery.sources).toContain('prepared')
    expect(observationStats.disposed).toBe(observationStats.opened)

    // 4. The worker's own initial message carries its identity reminder and the fork notice.
    const own = workerLog.slice(workerStored.inherited)
    const initial = own.find(e => e.type === 'user/message' && textOf(e).includes(JSON.stringify(WORKER_IDENTITY).slice(1, -1)))
    expect(initial).toBeDefined()
    expect(textOf(initial!)).toContain('The conversation above belongs to teammate \\"expert\\"')
    expect(textOf(initial!)).toContain('WORKER_TASK')
    expect(own.some(e => textOf(e).includes('WORKER DONE'))).toBe(true)
    // The worker's model request saw expert's history plus its own identity.
    const workerRequest = adapter.requests.find(r => r.sessionId === workerId)
    expect(JSON.stringify(workerRequest?.messages)).toContain('EXPERT KNOWLEDGE')
    // Teammates see the identical tool schema (Lead-only is enforced at execute time).
    expect(workerRequest?.tools?.some(t => t.name === 'spawn_teammate_from')).toBe(true)
    expect(JSON.stringify(workerRequest?.messages)).toContain(JSON.stringify(WORKER_IDENTITY).slice(1, -1))

    // 5. Lineage plugin record in the Lead log, and the tool result reported forked_from.
    const leadLog = lead.session.snapshotEvents()
    const lineage = leadLog.map(lineageOf).filter(r => r !== undefined)
    expect(lineage).toEqual([{
      version: 1, childId: workerId, childName: 'worker', sourceId: expertId, sourceName: 'expert', cutSeq: expertCut,
    }])
    expect(leadLog.find(e => (e.type as string) === LINEAGE_RECORD_TYPE)?.ignorable).toBe(true)
    const toolResult = leadLog.find(e => e.type === 'tool/result' && textOf(e).includes('forked_from'))
    expect(toolResult).toBeDefined()
    expect(textOf(toolResult!)).toContain('fork-from')

    // 6. Dispose the plugin: provider and scoped tool are removed.
    await pluginFiber.dispose()
    expect(ctx.subagents.getProvider('fork-from')).toBeUndefined()
    expect(ctx.tools.get('spawn_teammate_from', lead)).toBeUndefined()

    // 7. Cold resume of the forked teammate works without this plugin.
    await ctx.agentTeams.sendMessage(lead, { target: 'worker', content: [{ type: 'text', text: 'RESUME_PING' }], signal: SIGNAL })
    await vi.waitFor(() => { expect(route.state.workerCalls).toBe(2) }, { timeout: 10_000 })
    await waitCold(ctx, workerId)
    const resumed = (await storedEvents(ctx, workerId)).events
    expect(resumed.some(e => textOf(e).includes('RESUME_PING'))).toBe(true)
    expect(resumed.some(e => textOf(e).includes('WORKER RESUMED'))).toBe(true)
    expect(ctx.agentTeams.listMembers(lead).find(m => m.name === 'worker')?.status).not.toBe('failed')
  })

  it('records a teammate as failed when the provider is selected without a staged source, never falling back to Lead context', async () => {
    const { ctx, lead } = await setup()
    // Select the provider directly (no staged source): creation must fail.
    await expect(ctx.agentTeams.spawnTeammate(lead, {
      name: 'rogue',
      description: 'direct provider use',
      prompt: [{ type: 'text', text: 'hi' }],
      context: 'fork',
      provider: 'fork-from',
      signal: SIGNAL,
    })).rejects.toThrow(/no source staged/)
    expect(ctx.agentTeams.listMembers(lead).find(m => m.name === 'rogue')?.status).toBe('failed')
  })

  it('installs the tool only in Team member scopes and rejects an unknown source without side effects', async () => {
    const { ctx, lead } = await setup()
    const tool = ctx.tools.get('spawn_teammate_from', lead)
    expect(ctx.tools.get('spawn_teammate_from')).toBeUndefined()
    expect(tool).toBeDefined()
    const exec = { agent: lead, signal: SIGNAL } as unknown as Parameters<NonNullable<typeof tool>['execute']>[1]
    await expect(tool!.execute({ source: 'nobody', name: 'w', description: 'd', task: 't' }, exec)).rejects.toThrow(/not found/)
    expect(ctx.agentTeams.listMembers(lead).map(m => m.name)).toEqual(['lead'])
  })
})
