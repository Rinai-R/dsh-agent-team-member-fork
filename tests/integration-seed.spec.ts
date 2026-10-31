/**
 * Real-composition integration tests for the two risky seed cases:
 * - a source whose latest completed turn leaves an unclaimed inbox message (must not be inherited);
 * - a nested fork (seeded from a teammate that was itself forked) and its cold resume.
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
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import * as MemberFork from '../src/index.js'
import { lineageOf } from '../src/lineage.js'
import { lastTurnEndIndex, pendingInboxCount } from '../src/seed.js'
import { RoutingMockAdapter, textResponse } from './support/mock-adapter.js'
import { TestSessionQuery } from './support/test-session-query.js'

const SIGNAL = new AbortController().signal
const roots: string[] = []
const contexts: Context[] = []
const gates: Array<PromiseWithResolvers<void>> = []

afterEach(async () => {
  for (const gate of gates.splice(0)) gate.resolve()
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

type Respond = (options: GenerateOptions, text: string) => ReturnType<typeof textResponse> | Promise<ReturnType<typeof textResponse>>

async function setup(respond: Respond) {
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx, { workingDirectory: true })
  const storageRoot = mkdtempSync(join(tmpdir(), 'dsh-fork-it2-'))
  roots.push(storageRoot)
  await ctx.plugin(JsonlSessionPersistence, { root: storageRoot })
  await ctx.plugin(TestSessionQuery)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SubagentService)
  await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
  await ctx.plugin(TeamService, {})
  const pluginFiber = await ctx.plugin(MemberFork, { providerName: 'fork-from' })
  const adapter = new RoutingMockAdapter(options => {
    if (options.sessionId === 'lead') return textResponse('LEAD DONE')
    return respond(options, JSON.stringify(options.messages))
  })
  ctx.llm.registerAdapter(['mock'], adapter)
  const lead = await ctx.agentLoop.create(SessionId('lead'), { provider: 'mock', model: 'mock' })
  const tool = ctx.tools.get('spawn_teammate_from', lead)
  if (tool === undefined) throw new Error('spawn_teammate_from not installed on the Lead')
  const spawnFrom = async (args: { source: string; name: string; description: string; task: string }) => {
    const exec = { agent: lead, signal: SIGNAL } as unknown as Parameters<typeof tool.execute>[1]
    return await tool.execute(args, exec) as MemberFork.SpawnFromValue
  }
  return { ctx, lead, adapter, pluginFiber, spawnFrom }
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

function gate(): PromiseWithResolvers<void> {
  const g = Promise.withResolvers<void>()
  gates.push(g)
  return g
}

describe('pending inbox of the source', () => {
  it('a live source can have an unclaimed inbox message at its last turn/end; the fork cuts before it and never inherits it', async () => {
    const turn2 = gate()
    const turn3 = gate()
    const reached = { turn2: false, turn3: false }
    const { ctx, lead, adapter, spawnFrom } = await setup(async (_options, text) => {
      if (text.includes('WORKER_TASK')) return textResponse('WORKER DONE')
      if (text.includes('QUEUED_FOR_EXPERT')) { reached.turn3 = true; await turn3.promise; return textResponse('EXPERT TURN 3') }
      if (text.includes('SECOND_TASK')) { reached.turn2 = true; await turn2.promise; return textResponse('EXPERT TURN 2') }
      return textResponse('EXPERT KNOWLEDGE')
    })
    const expertId = (await ctx.agentTeams.spawnTeammate(lead, {
      name: 'expert', description: 'expert', prompt: [{ type: 'text', text: 'EXPERT_TASK' }], context: 'fresh', provider: 'spawn', signal: SIGNAL,
    })).member.id
    await waitCold(ctx, expertId)

    // Turn 2 runs (gated); while it runs, an ordinary follow-up is queued for the next turn.
    await ctx.agentTeams.sendMessage(lead, { target: 'expert', content: [{ type: 'text', text: 'SECOND_TASK' }], signal: SIGNAL })
    await vi.waitFor(() => { expect(reached.turn2).toBe(true) }, { timeout: 10_000 })
    const expert = ctx.agents.get(expertId)!
    expert.followup(createUserMessage({ content: [{ type: 'text', text: 'QUEUED_FOR_EXPERT' }], source: { kind: 'user' } }))
    turn2.resolve()
    // Turn 2 ends; turn 3 claims the follow-up and blocks in its model call.
    await vi.waitFor(() => { expect(reached.turn3).toBe(true) }, { timeout: 10_000 })

    // The risk is real: through the last turn/end the source inbox still holds the follow-up.
    const live = expert.session.snapshotEvents()
    const lastEnd = lastTurnEndIndex(live)
    expect(pendingInboxCount(live.slice(0, lastEnd + 1))).toBeGreaterThan(0)
    const firstEnd = live.findIndex(e => e.type === 'turn/end')
    expect(firstEnd).toBeLessThan(lastEnd)

    const result = await spawnFrom({ source: 'expert', name: 'worker', description: 'worker', task: 'WORKER_TASK' })
    expect(result.member.diagnostics).toEqual([expect.stringContaining('skipped the source\'s last 1 completed turn(s)')])
    const workerId = ctx.agentTeams.listMembers(lead).find(m => m.name === 'worker')!.id
    await waitCold(ctx, workerId)

    const worker = await storedEvents(ctx, workerId)
    // Seed = expert through its first (clean) turn/end.
    expect(worker.inherited).toBe(firstEnd + 1)
    expect(pendingInboxCount(worker.events.slice(0, worker.inherited))).toBe(0)
    // The worker never saw or ran the queued follow-up or the later turn.
    const workerRequests = adapter.requests.filter(r => r.sessionId === workerId)
    expect(workerRequests.length).toBeGreaterThan(0)
    for (const request of workerRequests) {
      const text = JSON.stringify(request.messages)
      expect(text).not.toContain('QUEUED_FOR_EXPERT')
      expect(text).not.toContain('SECOND_TASK')
    }
    expect(worker.events.some(e => JSON.stringify(e.data).includes('QUEUED_FOR_EXPERT'))).toBe(false)
    expect(lead.session.snapshotEvents().map(lineageOf).filter(r => r !== undefined)).toEqual([
      expect.objectContaining({ childName: 'worker', sourceName: 'expert', cutSeq: firstEnd }),
    ])
    turn3.resolve()
  })

  it('fails the new member when every completed turn of the source leaves a pending message', async () => {
    const turn1 = gate()
    const turn2 = gate()
    const reached = { turn1: false, turn2: false }
    const { ctx, lead, spawnFrom } = await setup(async (_options, text) => {
      if (text.includes('QUEUED_FOR_EXPERT')) { reached.turn2 = true; await turn2.promise; return textResponse('EXPERT TURN 2') }
      reached.turn1 = true
      await turn1.promise
      return textResponse('EXPERT KNOWLEDGE')
    })
    const expertId = (await ctx.agentTeams.spawnTeammate(lead, {
      name: 'expert', description: 'expert', prompt: [{ type: 'text', text: 'EXPERT_TASK' }], context: 'fresh', provider: 'spawn', signal: SIGNAL,
    })).member.id
    await vi.waitFor(() => { expect(reached.turn1).toBe(true) }, { timeout: 10_000 })
    ctx.agents.get(expertId)!.followup(createUserMessage({ content: [{ type: 'text', text: 'QUEUED_FOR_EXPERT' }], source: { kind: 'user' } }))
    turn1.resolve()
    await vi.waitFor(() => { expect(reached.turn2).toBe(true) }, { timeout: 10_000 })

    await expect(spawnFrom({ source: 'expert', name: 'worker', description: 'worker', task: 'WORKER_TASK' })).rejects.toThrow(/unclaimed inbox message/)
    expect(ctx.agentTeams.listMembers(lead).find(m => m.name === 'worker')?.status).toBe('failed')
    turn2.resolve()
  })
})

describe('nested fork', () => {
  it('forks from a teammate that was itself forked, and the nested child cold-resumes without the plugin', async () => {
    const calls = { worker: 0, worker2: 0 }
    const { ctx, lead, adapter, pluginFiber, spawnFrom } = await setup((_options, text) => {
      if (text.includes('WORKER2_TASK')) {
        calls.worker2 += 1
        return textResponse(calls.worker2 === 1 ? 'WORKER2 DONE' : 'WORKER2 RESUMED')
      }
      if (text.includes('WORKER_TASK')) { calls.worker += 1; return textResponse('WORKER KNOWLEDGE') }
      return textResponse('EXPERT KNOWLEDGE')
    })
    const expertId = (await ctx.agentTeams.spawnTeammate(lead, {
      name: 'expert', description: 'expert', prompt: [{ type: 'text', text: 'EXPERT_TASK' }], context: 'fresh', provider: 'spawn', signal: SIGNAL,
    })).member.id
    await waitCold(ctx, expertId)
    await spawnFrom({ source: 'expert', name: 'worker', description: 'worker', task: 'WORKER_TASK' })
    const workerId = ctx.agentTeams.listMembers(lead).find(m => m.name === 'worker')!.id
    await waitCold(ctx, workerId)

    const result = await spawnFrom({ source: 'worker', name: 'worker2', description: 'worker2', task: 'WORKER2_TASK' })
    expect(result).toMatchObject({ forked_from: 'worker', member: { target: 'worker2', provider: 'fork-from', context: 'fork' } })
    const worker2Id = ctx.agentTeams.listMembers(lead).find(m => m.name === 'worker2')!.id
    await vi.waitFor(() => { expect(calls.worker2).toBe(1) }, { timeout: 10_000 })
    await waitCold(ctx, worker2Id)
    await lead.whenIdle()

    const worker = await storedEvents(ctx, workerId)
    const worker2 = await storedEvents(ctx, worker2Id)
    const workerCut = lastTurnEndIndex(worker.events)
    // worker2 inherits worker's whole completed log, which itself starts with expert's prefix.
    expect(worker2.inherited).toBe(workerCut + 1)
    expect(JSON.parse(JSON.stringify(worker2.events.slice(0, worker2.inherited)))).toEqual(JSON.parse(JSON.stringify(worker.events.slice(0, workerCut + 1))))
    expect(worker2.events.slice(0, worker2.inherited).some(e => e.type === 'session/end-seed')).toBe(true)
    // worker2's own suffix carries its own continuable descriptor; the Team classifies it by that.
    const ownDescriptors = worker2.events.slice(worker2.inherited).filter(e => e.type === 'subagent/descriptor')
    expect(ownDescriptors).toHaveLength(1)
    expect(JSON.stringify(ownDescriptors[0]!.data)).toContain('fork-from')
    const worker2Request = adapter.requests.find(r => r.sessionId === worker2Id)
    expect(JSON.stringify(worker2Request?.messages)).toContain('You are teammate \\"worker2\\".')
    expect(JSON.stringify(worker2Request?.messages)).toContain('WORKER KNOWLEDGE')
    expect(JSON.stringify(worker2Request?.messages)).toContain('EXPERT KNOWLEDGE')
    expect(worker2Request?.tools?.some(t => t.name === 'spawn_teammate_from')).toBe(true)

    // Cold resume of the nested child after the plugin is gone.
    await pluginFiber.dispose()
    await ctx.agentTeams.sendMessage(lead, { target: 'worker2', content: [{ type: 'text', text: 'RESUME2_PING' }], signal: SIGNAL })
    await vi.waitFor(() => { expect(calls.worker2).toBe(2) }, { timeout: 10_000 })
    await waitCold(ctx, worker2Id)
    const resumed = (await storedEvents(ctx, worker2Id)).events
    expect(resumed.some(e => JSON.stringify(e.data).includes('RESUME2_PING'))).toBe(true)
    expect(resumed.some(e => JSON.stringify(e.data).includes('WORKER2 RESUMED'))).toBe(true)
    const roster = ctx.agentTeams.listMembers(lead)
    expect(roster.find(m => m.name === 'worker2')).toMatchObject({ role: 'teammate', provider: 'fork-from' })
    expect(roster.filter(m => m.status === 'failed')).toEqual([])
  })
})
