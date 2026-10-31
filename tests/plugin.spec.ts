import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { SubagentProvider } from '@deepseek-ai/dsh-subagent'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { SessionId } from '@deepseek-ai/dsh-session'
import * as plugin from '../src/index.js'
import { LINEAGE_RECORD_TYPE, lineageOf } from '../src/lineage.js'
import { fakeAgent } from './helpers.js'

type Listener = (payload: { agent: ReturnType<typeof fakeAgent> }) => unknown

/** Fake Cordis context with just enough surface for `apply`. */
function fakeCtx(members: Set<string>) {
  const providers = new Map<string, SubagentProvider>()
  const listeners = new Map<string, Listener[]>()
  const effects: Array<() => void> = []
  const toolsByAgent = new Map<string, ToolDefinition[]>()
  const agentWith = (id: string) => fakeAgent(id, {
    ctx: {
      tools: {
        register: (tool: ToolDefinition) => {
          const list = toolsByAgent.get(id) ?? []
          list.push(tool)
          toolsByAgent.set(id, list)
          return () => { toolsByAgent.set(id, (toolsByAgent.get(id) ?? []).filter(t => t !== tool)) }
        },
      },
    },
  })
  const live = [agentWith('lead'), agentWith('plain-subagent')]
  const ctx = {
    subagents: {
      registerProvider: vi.fn((provider: SubagentProvider) => {
        providers.set(provider.name, provider)
        return () => providers.delete(provider.name)
      }),
    },
    sessionQuery: { observeSession: vi.fn() },
    agentTeams: {
      tryMembership: (agent: { id: string }) => (members.has(agent.id) ? { role: 'lead' } : undefined),
    },
    agents: { list: () => live },
    on: (name: string, listener: Listener) => {
      listeners.set(name, [...listeners.get(name) ?? [], listener])
      return () => undefined
    },
    effect: (fn: () => () => void) => { effects.push(fn()) },
  }
  const emit = (name: string, agent: ReturnType<typeof fakeAgent>) => {
    for (const listener of listeners.get(name) ?? []) listener({ agent })
  }
  return { ctx: ctx as unknown as Context, providers, toolsByAgent, effects, emit, agentWith, live }
}

describe('plugin entry', () => {
  it('exports name, inject, and a Config schema with the fork-from default', () => {
    expect(plugin.name).toBe('agent-team-member-fork')
    expect(plugin.inject).toEqual(['agents', 'agentTeams', 'subagents', 'tools', 'sessionQuery'])
    expect(plugin.Config({} as never)).toEqual({ providerName: 'fork-from' })
    expect(plugin.Config({ providerName: 'x' })).toEqual({ providerName: 'x' })
    expect(() => plugin.Config({ providerName: 1 } as never)).toThrow()
  })

  it('registers the provider and installs the tool on Team members only, then disposes', () => {
    const f = fakeCtx(new Set(['lead', 'mate']))
    plugin.apply(f.ctx, { providerName: 'from' })
    expect([...f.providers.keys()]).toEqual(['from'])
    expect(f.toolsByAgent.get('lead')?.map(t => t.name)).toEqual(['spawn_teammate_from'])
    expect(f.toolsByAgent.get('plain-subagent')).toBeUndefined()

    const mate = f.agentWith('mate')
    f.emit('agent/created', mate)
    f.emit('agent/created', mate)
    expect(f.toolsByAgent.get('mate')?.map(t => t.name)).toEqual(['spawn_teammate_from'])
    // identical schema for Lead and teammates
    expect(f.toolsByAgent.get('mate')?.[0]?.parameters).toEqual(f.toolsByAgent.get('lead')?.[0]?.parameters)

    f.emit('agent/disposed', mate)
    expect(f.toolsByAgent.get('mate')).toEqual([])

    for (const cleanup of f.effects) cleanup()
    expect(f.toolsByAgent.get('lead')).toEqual([])
  })

  it('defaults the provider name', () => {
    const f = fakeCtx(new Set())
    plugin.apply(f.ctx)
    expect([...f.providers.keys()]).toEqual(['fork-from'])
  })
})

describe('lineageOf', () => {
  const record = (data: unknown, type: string = LINEAGE_RECORD_TYPE): SessionEvent =>
    ({ type, seq: 3, time: 0, ignorable: true, data } as unknown as SessionEvent)
  const valid = { version: 1, childId: 'c', childName: 'worker', sourceId: 's', sourceName: 'expert', cutSeq: 9 }

  it('reads a valid record', () => {
    expect(lineageOf(record(valid))).toEqual({ ...valid, childId: SessionId('c'), sourceId: SessionId('s') })
  })

  it.each([
    ['other type', record(valid, 'plugin:someone-else/x')],
    ['null data', record(null)],
    ['bad version', record({ ...valid, version: 2 })],
    ['bad child', record({ ...valid, childId: 1 })],
    ['bad source', record({ ...valid, sourceName: undefined })],
    ['negative cut', record({ ...valid, cutSeq: -1 })],
    ['non-integer cut', record({ ...valid, cutSeq: 1.5 })],
  ])('rejects %s', (_label, event) => {
    expect(lineageOf(event)).toBeUndefined()
  })
})
