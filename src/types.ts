/** Types shared by the fork-from provider, the handoff registry, and the `spawn_teammate_from` tool. */
import type { SessionId } from '@deepseek-ai/dsh-session'

/** Plugin configuration. */
export interface Config {
  /** Subagent provider name registered on `ctx.subagents` (default `fork-from`). */
  providerName: string
}

/** The existing teammate a pending `spawn_teammate_from` call forks from. */
export interface StagedSource {
  /** Session id of the source teammate. */
  readonly sourceId: SessionId
  /** Team member name of the source teammate. */
  readonly sourceName: string
}

/** What the provider receives when it consumes a staged source. */
export interface TakenSource extends StagedSource {
  /**
   * Report the seq of the last event copied into the child seed.
   * @param cutSeq - seq of the source's `turn/end` that ends the seed.
   * @param diagnostics - optional model-facing notes about the cut (for example skipped turns).
   */
  resolveCut(cutSeq: number, diagnostics?: readonly string[]): void
}

/** Tool-side view of one staged source while its spawn is in flight. */
export interface StageTicket {
  /** Seq reported by the provider through {@link TakenSource.resolveCut}, or undefined before preparation. */
  readonly cutSeq: number | undefined
  /** Diagnostics reported with the cut. */
  readonly diagnostics: readonly string[]
  /** Whether the provider consumed the staged source. */
  readonly taken: boolean
  /**
   * Run `fn` inside this staging operation's scope. Only provider preparations whose async
   * context descends from this call may take the staged source.
   * @param fn - operation that triggers the provider (the `spawnTeammate` call).
   * @returns the result of `fn`.
   */
  run<T>(fn: () => T): T
}

/** Data of the `plugin:dsh-agent-team-member-fork/lineage` record appended to the Lead Session. */
export interface LineageRecord {
  readonly version: 1
  readonly childId: SessionId
  readonly childName: string
  readonly sourceId: SessionId
  readonly sourceName: string
  readonly cutSeq: number
}
