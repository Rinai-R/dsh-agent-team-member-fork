/** The Lead-only `spawn_teammate_from` model tool. */
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SpawnTeammateResult, TeamMemberView, TeamService } from '@deepseek-ai/dsh-experimental-agent-team'
import { defineTool, type InferValue, type ToolDefinition, type ValueSchemaSpec } from '@deepseek-ai/dsh-tools'
import type { HandoffRegistry } from './handoff.js'
import type { LineageRecord } from './types.js'

/** Tool name. */
export const TOOL_NAME = 'spawn_teammate_from'

/** Model-facing tool description. */
export const TOOL_DESCRIPTION = [
  'Create one named, durable teammate whose context is forked from an EXISTING teammate\'s conversation (its completed turns), instead of from the Lead. Only the Team Lead may call this tool.',
  'Use it when a teammate has built up expertise or context that a new parallel task needs (for example a long-lived domain expert); use spawn_teammate with context "fork" to copy the Lead\'s own context, or context "fresh" for a clean start.',
  'The new teammate inherits the source teammate\'s whole history, including the working directory or worktree it used; restate the working directory, write scope, and any worktree in task.',
].join(' ')

/** One model-facing roster row (same fields as `spawn_teammate`). */
const MEMBER_VIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    target: { type: 'string', required: true },
    role: { type: 'string', required: true, enum: ['lead', 'teammate'] },
    status: { type: 'string', required: true, enum: ['running', 'inactive', 'provisioning', 'failed'] },
    description: { type: 'string' },
    provider: { type: 'string' },
    context: { type: 'string', enum: ['fresh', 'fork'] },
    model: { type: 'string' },
    diagnostics: { type: 'array', required: true, items: { type: 'string' } },
  },
} as const satisfies ValueSchemaSpec

/** Tool result: the `spawn_teammate` result plus the source name. */
export const SPAWN_FROM_VALUE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    member: { ...MEMBER_VIEW_SCHEMA, required: true },
    forked_from: { type: 'string', required: true },
  },
} as const satisfies ValueSchemaSpec

/** Tool parameters. */
export const SPAWN_FROM_PARAMETERS = {
  source: { type: 'string', required: true, description: 'Name (target) of the existing teammate whose conversation is copied.' },
  name: { type: 'string', required: true, description: 'Unique lower-kebab-case name for the new teammate.' },
  description: { type: 'string', required: true, description: 'Short description of the delegated responsibility (at most 200 characters).' },
  task: { type: 'string', required: true, description: 'Complete initial task for the new teammate, including its working directory and write scope.' },
} as const

/** Tool arguments after schema validation. */
export interface SpawnFromArgs {
  readonly source: string
  readonly name: string
  readonly description: string
  readonly task: string
}

/** Tool result value. */
export type SpawnFromValue = InferValue<typeof SPAWN_FROM_VALUE_SCHEMA>

/** Narrow TeamService surface the tool uses. */
export type TeamPort = Pick<TeamService, 'membership' | 'listMembers' | 'spawnTeammate'>

/** Dependencies of the tool. */
export interface SpawnFromDeps {
  readonly agentTeams: TeamPort
  readonly handoff: HandoffRegistry
  readonly providerName: string
  /** Persist lineage to the Lead Session. */
  readonly appendLineage: (lead: Agent, record: LineageRecord) => void
}

/** Raised for invalid `spawn_teammate_from` calls. */
export class SpawnFromError extends Error {
  override readonly name = 'SpawnFromError'
  /**
   * @param message - model-facing reason.
   * @param code - stable machine-readable reason.
   */
  constructor(message: string, readonly code: string) {
    super(message)
  }
}

/**
 * The identity reminder for one teammate. Its lines match the `team:identity` runtime context
 * that rc.5 `tool-agent-team` renders for teammates, framed as a `<system-reminder>` the way the
 * Agent Teams `spawn_teammate` tool framed it in its initial prompt.
 * @param name - new teammate name.
 * @returns the reminder text, ending with a blank line.
 */
export function identityReminder(name: string): string {
  return `<system-reminder>
You are teammate "${name}".
Your Team Lead is named "lead".
To message your Team Lead, use send_message({ target: "lead", message: "..." }).
Use list_agents({}) to find your teammates and their names.
To message another teammate, use send_message({ target: "<teammate name>", message: "..." }).
</system-reminder>

`
}

/**
 * The single text block delivered as the new teammate's initial prompt.
 * @param name - new teammate name.
 * @param source - source teammate name.
 * @param task - task text from the Lead.
 * @returns the prompt text.
 */
export function forkPromptText(name: string, source: string, task: string): string {
  return `${identityReminder(name)}The conversation above belongs to teammate "${source}". Its identity, task and working directory no longer apply to you. You are a new teammate forked from its context.

${task}`
}

/** Expose the member name as its model-facing target. */
function modelMember(member: TeamMemberView): SpawnFromValue['member'] {
  const { id: _id, name, diagnostics, ...details } = member
  return { target: name, ...details, diagnostics: [...diagnostics] }
}

/**
 * Execute `spawn_teammate_from` for one calling Agent.
 * @param deps - Team service, handoff registry, provider name, and lineage sink.
 * @param args - validated tool arguments.
 * @param exec - calling Agent and cancellation.
 * @returns the new member row plus `forked_from`.
 */
export async function executeSpawnFrom(
  deps: SpawnFromDeps,
  args: SpawnFromArgs,
  exec: { readonly agent?: Agent | undefined; readonly signal: AbortSignal },
): Promise<SpawnFromValue> {
  const lead = exec.agent
  if (lead === undefined) throw new SpawnFromError(`${TOOL_NAME} requires a calling Agent`, 'FORK_NO_CALLER')
  if (deps.agentTeams.membership(lead).role !== 'lead') {
    throw new SpawnFromError('only the Team Lead can spawn teammates', 'TEAM_LEAD_REQUIRED')
  }
  if (args.source === 'lead') {
    throw new SpawnFromError('source must be a teammate; to fork the Lead\'s own context use spawn_teammate with context "fork"', 'FORK_SOURCE_IS_LEAD')
  }
  const source = deps.agentTeams.listMembers(lead).find(member => member.role === 'teammate' && member.name === args.source)
  if (source === undefined) {
    throw new SpawnFromError(`teammate "${args.source}" not found; use list_agents to see existing teammates`, 'FORK_SOURCE_NOT_FOUND')
  }
  if (source.status === 'failed' || source.status === 'provisioning') {
    throw new SpawnFromError(`teammate "${args.source}" is ${source.status} and cannot be forked`, 'FORK_SOURCE_UNAVAILABLE')
  }
  const result = await deps.handoff.withLeadLock(lead.id, async (): Promise<{ spawned: SpawnTeammateResult; cutSeq: number | undefined; diagnostics: readonly string[] }> => {
    const ticket = deps.handoff.stage(lead.id, { sourceId: source.id, sourceName: source.name })
    try {
      const spawned = await ticket.run(() => deps.agentTeams.spawnTeammate(lead, {
        name: args.name,
        description: args.description,
        prompt: [{ type: 'text', text: forkPromptText(args.name, source.name, args.task) }],
        context: 'fork',
        provider: deps.providerName,
        signal: exec.signal,
      }))
      return { spawned, cutSeq: ticket.cutSeq, diagnostics: ticket.diagnostics }
    } finally {
      deps.handoff.clear(lead.id)
    }
  }, exec.signal)
  const member = modelMember(result.spawned.member)
  member.diagnostics.push(...result.diagnostics)
  if (result.cutSeq === undefined) {
    member.diagnostics.push(`lineage not recorded: provider "${deps.providerName}" did not report a seed cut`)
  } else {
    try {
      deps.appendLineage(lead, {
        version: 1,
        childId: result.spawned.member.id,
        childName: result.spawned.member.name,
        sourceId: source.id,
        sourceName: source.name,
        cutSeq: result.cutSeq,
      })
    } catch (error) {
      member.diagnostics.push(`lineage not recorded: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return { member, forked_from: source.name }
}

/**
 * Build the tool definition registered in every Team member scope (identical schema for all;
 * the Lead role is enforced at execute time).
 * @param deps - see {@link executeSpawnFrom}.
 * @returns the tool definition.
 */
export function spawnTeammateFromTool(deps: SpawnFromDeps): ToolDefinition {
  return defineTool({
    name: TOOL_NAME,
    description: TOOL_DESCRIPTION,
    parameters: SPAWN_FROM_PARAMETERS,
    output: {
      schema: SPAWN_FROM_VALUE_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    execute: (args, exec) => executeSpawnFrom(deps, args, exec),
  })
}
