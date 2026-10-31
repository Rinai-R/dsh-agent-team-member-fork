/**
 * dsh-agent-team-member-fork: lets the Agent Teams Lead create a teammate forked from an existing
 * teammate's conversation. Registers the `fork-from` subagent provider and installs the Lead-only
 * `spawn_teammate_from` tool in every Team member scope.
 * @module dsh-agent-team-member-fork
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-experimental-agent-team'
import type {} from '@deepseek-ai/dsh-session-query'
import type {} from '@deepseek-ai/dsh-subagent'
import z from '@deepseek-ai/schemastery'
import { HandoffRegistry } from './handoff.js'
import { appendLineage } from './lineage.js'
import { createForkFromProvider, sessionQueryReader } from './provider.js'
import { spawnTeammateFromTool, type SpawnFromDeps } from './tool.js'
import type { Config as PluginConfig } from './types.js'

export type * from './types.js'
export { HandoffError, HandoffRegistry, type HandoffErrorCode } from './handoff.js'
export { completedTurnPrefix, cutSeqOf, forkCut, ForkSeedError, lastTurnEndIndex, pendingInboxCount, type ForkCut, type ForkSeedErrorCode } from './seed.js'
export { createForkFromProvider, sessionQueryReader, type ForkFromProviderOptions, type SourceEventReader } from './provider.js'
export { LINEAGE_RECORD_TYPE, appendLineage, lineageOf } from './lineage.js'
export {
  TOOL_NAME,
  TOOL_DESCRIPTION,
  SpawnFromError,
  executeSpawnFrom,
  forkPromptText,
  identityReminder,
  spawnTeammateFromTool,
  type SpawnFromArgs,
  type SpawnFromDeps,
  type SpawnFromValue,
  type TeamPort,
} from './tool.js'

/** Cordis plugin name. */
export const name = 'agent-team-member-fork'

/** Services required by the plugin. */
export const inject: string[] = ['agents', 'agentTeams', 'subagents', 'tools', 'sessionQuery']

/** Plugin configuration. */
export type Config = PluginConfig

/** Default provider name. */
export const DEFAULT_PROVIDER_NAME = 'fork-from'

/** Loader schema. */
export const Config: z<Config> = z.object({
  providerName: z.string().default(DEFAULT_PROVIDER_NAME).description('Subagent provider name registered on ctx.subagents.'),
})

/**
 * Register the provider and install `spawn_teammate_from` on every live and future Team member.
 * Every registration is disposed with the plugin.
 * @param ctx - plugin context.
 * @param config - plugin configuration.
 */
export function apply(ctx: Context, config: Partial<Config> = {}): void {
  const providerName = config.providerName ?? DEFAULT_PROVIDER_NAME
  const handoff = new HandoffRegistry()

  ctx.subagents.registerProvider(createForkFromProvider({
    name: providerName,
    handoff,
    readSource: sessionQueryReader(ctx.sessionQuery),
  }))

  const deps: SpawnFromDeps = {
    agentTeams: ctx.agentTeams,
    handoff,
    providerName,
    appendLineage: (lead, record) => { appendLineage(lead.session, record) },
  }
  const installed = new Map<Agent, () => void>()
  const maybeInstall = (agent: Agent): void => {
    if (installed.has(agent) || ctx.agentTeams.tryMembership(agent) === undefined) return
    installed.set(agent, agent.ctx.tools.register(spawnTeammateFromTool(deps)))
  }
  for (const agent of ctx.agents.list()) maybeInstall(agent)
  ctx.on('agent/created', ({ agent }) => {
    maybeInstall(agent)
    return undefined
  })
  ctx.on('agent/disposed', ({ agent }) => {
    installed.get(agent)?.()
    installed.delete(agent)
  })
  ctx.effect(() => () => {
    for (const dispose of installed.values()) dispose()
    installed.clear()
    handoff.clearAll()
  }, 'agent-team-member-fork.scopedTools()')
}
