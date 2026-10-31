import { describe, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SpawnTeammateRequest, SpawnTeammateResult, TeamMemberView } from '@deepseek-ai/dsh-experimental-agent-team'
import { SessionId } from '@deepseek-ai/dsh-session'
import { HandoffRegistry } from '../src/handoff.js'
import {
  executeSpawnFrom,
  forkPromptText,
  identityReminder,
  SPAWN_FROM_PARAMETERS,
  spawnTeammateFromTool,
  TOOL_DESCRIPTION,
  TOOL_NAME,
  type SpawnFromDeps,
  type TeamPort,
} from '../src/tool.js'
import type { LineageRecord } from '../src/types.js'
import { fakeAgent } from './helpers.js'

const LEAD = fakeAgent('lead')
const MATE = fakeAgent('mate')
const SIGNAL = new AbortController().signal
const ARGS = { source: 'expert', name: 'worker', description: 'parallel worker', task: 'Work in /repo/wt-a on X.' }

function member(name: string, status: TeamMemberView['status'], role: TeamMemberView['role'] = 'teammate'): TeamMemberView {
  return { id: SessionId(`${name}-id`), name, role, status, diagnostics: [] }
}

const ROSTER: TeamMemberView[] = [
  member('lead', 'running', 'lead'),
  member('expert', 'inactive'),
  member('broken', 'failed'),
  member('pending', 'provisioning'),
  member('busy', 'running'),
]

function setup(spawnImpl?: (caller: Agent, request: SpawnTeammateRequest, handoff: HandoffRegistry) => Promise<SpawnTeammateResult>) {
  const handoff = new HandoffRegistry()
  const lineage: LineageRecord[] = []
  const spawnTeammate = vi.fn((caller: Agent, request: SpawnTeammateRequest) => {
    if (spawnImpl !== undefined) return spawnImpl(caller, request, handoff)
    // Simulate TeamService → SubagentService → our provider taking the handoff.
    handoff.take(caller.id).resolveCut(17)
    return Promise.resolve({
      member: {
        id: SessionId('worker-id'), name: request.name, role: 'teammate', status: 'running',
        description: request.description, provider: request.provider, context: request.context, model: 'm', diagnostics: [],
      } satisfies TeamMemberView,
    })
  })
  const agentTeams: TeamPort = {
    membership: vi.fn((agent: Agent) => ({ root: LEAD, id: 'team' as never, role: agent === LEAD ? 'lead' as const : 'teammate' as const, name: agent === LEAD ? 'lead' : 'mate' })),
    listMembers: vi.fn(() => ROSTER),
    spawnTeammate,
  }
  const appendLineage = vi.fn((_lead: Agent, record: LineageRecord) => { lineage.push(record) })
  const deps: SpawnFromDeps = { agentTeams, handoff, providerName: 'fork-from', appendLineage }
  return { deps, handoff, spawnTeammate, lineage, appendLineage }
}

describe('spawn_teammate_from execute', () => {
  it('rejects a non-Lead caller before touching the roster', async () => {
    const { deps, spawnTeammate } = setup()
    await expect(executeSpawnFrom(deps, ARGS, { agent: MATE, signal: SIGNAL })).rejects.toThrow('only the Team Lead can spawn teammates')
    expect(spawnTeammate).not.toHaveBeenCalled()
  })

  it('rejects a missing calling Agent', async () => {
    const { deps } = setup()
    await expect(executeSpawnFrom(deps, ARGS, { signal: SIGNAL })).rejects.toMatchObject({ code: 'FORK_NO_CALLER' })
  })

  it.each([
    ['nobody', 'FORK_SOURCE_NOT_FOUND'],
    ['lead', 'FORK_SOURCE_IS_LEAD'],
    ['broken', 'FORK_SOURCE_UNAVAILABLE'],
    ['pending', 'FORK_SOURCE_UNAVAILABLE'],
  ])('rejects source %s with %s', async (source, code) => {
    const { deps, spawnTeammate, handoff } = setup()
    await expect(executeSpawnFrom(deps, { ...ARGS, source }, { agent: LEAD, signal: SIGNAL })).rejects.toMatchObject({ code })
    expect(spawnTeammate).not.toHaveBeenCalled()
    expect(handoff.has('lead')).toBe(false)
  })

  it('accepts a running source', async () => {
    const { deps } = setup()
    await expect(executeSpawnFrom(deps, { ...ARGS, source: 'busy' }, { agent: LEAD, signal: SIGNAL })).resolves.toMatchObject({ forked_from: 'busy' })
  })

  it('spawns a fork-context teammate through the configured provider and records lineage', async () => {
    const { deps, spawnTeammate, lineage, handoff } = setup()
    const value = await executeSpawnFrom(deps, ARGS, { agent: LEAD, signal: SIGNAL })
    expect(spawnTeammate).toHaveBeenCalledOnce()
    const [caller, request] = spawnTeammate.mock.calls[0]!
    expect(caller).toBe(LEAD)
    expect(request).toEqual({
      name: 'worker',
      description: 'parallel worker',
      prompt: [{ type: 'text', text: forkPromptText('worker', 'expert', ARGS.task) }],
      context: 'fork',
      provider: 'fork-from',
      signal: SIGNAL,
    })
    expect(value).toEqual({
      member: {
        target: 'worker', role: 'teammate', status: 'running', description: 'parallel worker',
        provider: 'fork-from', context: 'fork', model: 'm', diagnostics: [],
      },
      forked_from: 'expert',
    })
    expect(lineage).toEqual([{
      version: 1, childId: 'worker-id', childName: 'worker', sourceId: 'expert-id', sourceName: 'expert', cutSeq: 17,
    }])
    expect(handoff.has('lead')).toBe(false)
    expect(handoff.lockedLeads).toBe(0)
  })

  it('clears the handoff and records no lineage when spawn fails', async () => {
    const { deps, handoff, appendLineage } = setup(() => Promise.reject(new Error('TEAM_MEMBER_NAME_TAKEN')))
    await expect(executeSpawnFrom(deps, ARGS, { agent: LEAD, signal: SIGNAL })).rejects.toThrow('TEAM_MEMBER_NAME_TAKEN')
    expect(handoff.has('lead')).toBe(false)
    expect(appendLineage).not.toHaveBeenCalled()
    expect(handoff.lockedLeads).toBe(0)
  })

  it('clears a staged entry the provider never took', async () => {
    const { deps, handoff, appendLineage } = setup((_caller, request) => Promise.resolve({
      member: { id: SessionId('w'), name: request.name, role: 'teammate', status: 'inactive', diagnostics: [] },
    }))
    const value = await executeSpawnFrom(deps, ARGS, { agent: LEAD, signal: SIGNAL })
    expect(handoff.has('lead')).toBe(false)
    expect(appendLineage).not.toHaveBeenCalled()
    expect(value.member.diagnostics).toEqual(['lineage not recorded: provider "fork-from" did not report a seed cut'])
  })

  it('reports a lineage append failure as a diagnostic instead of failing the created teammate', async () => {
    const { deps } = setup()
    const failing: SpawnFromDeps = { ...deps, appendLineage: () => { throw new Error('session closed') } }
    const value = await executeSpawnFrom(failing, ARGS, { agent: LEAD, signal: SIGNAL })
    expect(value.member.diagnostics).toEqual(['lineage not recorded: session closed'])
  })

  it('serializes concurrent calls for one Lead so each spawn sees its own source', async () => {
    const seen: string[] = []
    const { deps } = setup(async (caller, request, handoff) => {
      await new Promise(resolve => setTimeout(resolve, 5))
      const taken = handoff.take(caller.id)
      seen.push(`${request.name}<-${taken.sourceName}`)
      taken.resolveCut(1)
      return { member: { id: SessionId(request.name), name: request.name, role: 'teammate', status: 'running', diagnostics: [] } }
    })
    await Promise.all([
      executeSpawnFrom(deps, { ...ARGS, name: 'w1', source: 'expert' }, { agent: LEAD, signal: SIGNAL }),
      executeSpawnFrom(deps, { ...ARGS, name: 'w2', source: 'busy' }, { agent: LEAD, signal: SIGNAL }),
    ])
    expect(seen).toEqual(['w1<-expert', 'w2<-busy'])
  })
})

describe('prompt text', () => {
  it('pins the identity reminder and fork notice verbatim', () => {
    expect(identityReminder('worker')).toBe(
      '<system-reminder>\n'
      + 'You are teammate "worker".\n'
      + 'Your Team Lead is named "lead".\n'
      + 'To message your Team Lead, use send_message({ target: "lead", message: "..." }).\n'
      + 'Use list_agents({}) to find your teammates and their names.\n'
      + 'To message another teammate, use send_message({ target: "<teammate name>", message: "..." }).\n'
      + '</system-reminder>\n\n',
    )
    expect(forkPromptText('worker', 'expert', 'Do it.')).toMatchInlineSnapshot(`
      "<system-reminder>
      You are teammate "worker".
      Your Team Lead is named "lead".
      To message your Team Lead, use send_message({ target: "lead", message: "..." }).
      Use list_agents({}) to find your teammates and their names.
      To message another teammate, use send_message({ target: "<teammate name>", message: "..." }).
      </system-reminder>

      The conversation above belongs to teammate "expert". Its identity, task and working directory no longer apply to you. You are a new teammate forked from its context.

      Do it."
    `)
  })
})

describe('tool definition', () => {
  it('declares name, parameters, and guidance', () => {
    const { deps } = setup()
    const tool = spawnTeammateFromTool(deps)
    expect(tool.name).toBe(TOOL_NAME)
    expect(tool.description).toBe(TOOL_DESCRIPTION)
    expect(TOOL_DESCRIPTION).toMatch(/spawn_teammate/)
    expect(TOOL_DESCRIPTION).toMatch(/working directory/)
    expect(Object.keys(SPAWN_FROM_PARAMETERS)).toEqual(['source', 'name', 'description', 'task'])
    expect(Object.values(SPAWN_FROM_PARAMETERS).every(p => p.required)).toBe(true)
  })

  it('renders compact JSON', () => {
    const { deps } = setup()
    const tool = spawnTeammateFromTool(deps)
    const value = { member: { target: 'w', role: 'teammate', status: 'running', diagnostics: [] }, forked_from: 'expert' }
    expect(tool.output.render(ARGS, value)).toEqual([{ type: 'text', text: JSON.stringify(value) }])
  })
})
