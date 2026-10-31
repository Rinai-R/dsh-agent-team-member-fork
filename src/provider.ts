/** The `fork-from` continuable subagent provider: seeds a child with a source teammate's completed turns. */
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionQueryEngine } from '@deepseek-ai/dsh-session-query'
import type { ContinuableCreateRequest, ContinuableCreateSpec, SubagentProvider } from '@deepseek-ai/dsh-subagent'
import type { HandoffRegistry } from './handoff.js'
import { cutSeqOf, forkCut } from './seed.js'

/** Reads one source Session log, live or cold. */
export type SourceEventReader = (sourceId: SessionId, signal: AbortSignal) => Promise<{
  readonly parentSession: SessionId | undefined
  readonly events: readonly SessionEvent[]
}>

/**
 * Build a reader over `ctx.sessionQuery.observeSession()` (live-preferred, no writer lock).
 * The observation lease is disposed before returning.
 * @param sessionQuery - the Session query service.
 * @returns a reader returning a detached copy of the event array and the header's parent Session.
 */
export function sessionQueryReader(sessionQuery: Pick<SessionQueryEngine, 'observeSession'>): SourceEventReader {
  return async (sourceId, signal) => {
    const observation = await sessionQuery.observeSession(sourceId, { signal, projectionMode: 'none' })
    try {
      return { parentSession: observation.header.parentSession, events: [...observation.events] }
    } finally {
      observation[Symbol.dispose]()
    }
  }
}

/** Dependencies of {@link createForkFromProvider}. */
export interface ForkFromProviderOptions {
  /** Registry name. */
  readonly name: string
  /** Handoff registry shared with the tool. */
  readonly handoff: HandoffRegistry
  /** Source log reader. */
  readonly readSource: SourceEventReader
}

/**
 * Create the provider. `prepareContinuable` never falls back to the Lead's context: without a
 * staged source, or with a source that has no completed turn, it rejects so that TeamService
 * records the member as failed.
 * @param options - name, handoff registry, and source reader.
 * @returns a continuable-only subagent provider.
 */
export function createForkFromProvider(options: ForkFromProviderOptions): SubagentProvider {
  const { handoff, readSource } = options
  return {
    name: options.name,
    capabilities: { agentOptions: true, agentPreset: false, outputSchema: true, depthLimit: true },
    inheritsParentContext: true,
    async prepareContinuable(request: ContinuableCreateRequest): Promise<ContinuableCreateSpec> {
      const staged = handoff.take(request.parent.id)
      request.signal.throwIfAborted()
      const source = await readSource(staged.sourceId, request.signal)
      const leadId = request.parent.session.header.id
      if (source.parentSession !== leadId) {
        throw new Error(`fork-from: source teammate "${staged.sourceName}" is not a direct child of this Team Lead`)
      }
      const { seed, skippedTurnEnds } = forkCut(source.events)
      const cutSeq = cutSeqOf(seed)
      staged.resolveCut(cutSeq, skippedTurnEnds === 0
        ? []
        : [`forked at seq ${cutSeq}: skipped the source's last ${skippedTurnEnds} completed turn(s) because they left an unclaimed inbox message`])
      return { seed }
    },
  }
}
