/**
 * Per-Lead handoff between the `spawn_teammate_from` tool and the `fork-from` provider.
 *
 * `ctx.agentTeams.spawnTeammate()` cannot carry provider data, and the provider request only
 * names the Lead (`parent`). The tool therefore stages its source under the Lead id inside a
 * per-Lead mutex and runs `spawnTeammate` inside the ticket's operation scope
 * ({@link StageTicket.run}, an `AsyncLocalStorage` capability). The provider takes the staged
 * entry exactly once, and only from inside that scope, so a provider selection that does not
 * descend from the staging tool call (a parallel direct `spawnTeammate`/`startActivation` with
 * this provider name) cannot steal the staged source.
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import type { StagedSource, StageTicket, TakenSource } from './types.js'

/** Stable reasons raised by {@link HandoffRegistry}. */
export type HandoffErrorCode = 'FORK_NO_STAGED_SOURCE' | 'FORK_ALREADY_STAGED' | 'FORK_STAGED_FOR_ANOTHER_CALL'

/** Raised when the provider finds no usable staged source or the tool double-stages. */
export class HandoffError extends Error {
  override readonly name = 'HandoffError'
  /**
   * @param message - human-readable reason.
   * @param code - stable machine-readable reason.
   */
  constructor(message: string, readonly code: HandoffErrorCode) {
    super(message)
  }
}

interface Entry extends StagedSource {
  taken: boolean
  cutSeq: number | undefined
  diagnostics: readonly string[]
}

interface LeadLock {
  /** Settles once every participant queued so far has left its critical section. */
  tail: Promise<void>
  /** Participants (holder and waiters) that have not yet left `withLeadLock`. */
  participants: number
}

/** In-process registry of staged fork sources keyed by Lead Session id. */
export class HandoffRegistry {
  readonly #locks = new Map<string, LeadLock>()
  readonly #staged = new Map<string, Entry>()
  readonly #scope = new AsyncLocalStorage<Entry>()

  /**
   * Run `fn` while holding the mutex of one Lead. Calls for the same Lead run one at a time in
   * call order; calls for different Leads run concurrently. A waiter cancelled through `signal`
   * leaves the queue without releasing its predecessors: later callers still wait for every
   * earlier holder.
   * @param leadId - Lead Session id.
   * @param fn - critical section.
   * @param signal - optional cancellation while waiting for the mutex.
   * @returns the result of `fn`.
   */
  async withLeadLock<T>(leadId: string, fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted()
    let lock = this.#locks.get(leadId)
    if (lock === undefined) {
      lock = { tail: Promise.resolve(), participants: 0 }
      this.#locks.set(leadId, lock)
    }
    const previous = lock.tail
    const own = Promise.withResolvers<void>()
    // Never rejects: `own` is only resolved, and `previous` is an earlier tail of this chain.
    lock.tail = previous.then(() => own.promise)
    lock.participants += 1
    try {
      await waitOrAbort(previous, signal)
      return await fn()
    } finally {
      own.resolve()
      lock.participants -= 1
      // Drop the entry only when nobody holds or awaits it. A cancelled waiter whose predecessor
      // still runs keeps the entry, so the next caller chains behind that predecessor.
      if (lock.participants === 0 && this.#locks.get(leadId) === lock) this.#locks.delete(leadId)
    }
  }

  /**
   * Stage one source for the next provider preparation under this Lead.
   * @param leadId - Lead Session id.
   * @param source - source teammate.
   * @returns a ticket whose {@link StageTicket.run} scope may take the source and which observes
   *   whether the provider took it and where it cut.
   * @throws {HandoffError} `FORK_ALREADY_STAGED` when a source is already staged for the Lead.
   */
  stage(leadId: string, source: StagedSource): StageTicket {
    if (this.#staged.has(leadId)) {
      throw new HandoffError(`fork-from: a source is already staged for Lead ${leadId}`, 'FORK_ALREADY_STAGED')
    }
    const entry: Entry = { sourceId: source.sourceId, sourceName: source.sourceName, taken: false, cutSeq: undefined, diagnostics: [] }
    this.#staged.set(leadId, entry)
    const scope = this.#scope
    return {
      get cutSeq() { return entry.cutSeq },
      get diagnostics() { return entry.diagnostics },
      get taken() { return entry.taken },
      run: fn => scope.run(entry, fn),
    }
  }

  /**
   * Consume the staged source of one Lead. Only callers inside the staging ticket's
   * {@link StageTicket.run} scope may take it, and only once.
   * @param leadId - Lead Session id (the provider's `request.parent.id`).
   * @returns the source plus a callback to report the seed cut.
   * @throws {HandoffError} `FORK_NO_STAGED_SOURCE` when nothing is staged;
   *   `FORK_STAGED_FOR_ANOTHER_CALL` when the caller is outside the staging operation (the entry
   *   stays staged for its owner).
   */
  take(leadId: string): TakenSource {
    const entry = this.#staged.get(leadId)
    if (entry === undefined) {
      throw new HandoffError(
        'fork-from: no source staged for this Lead; use the spawn_teammate_from tool instead of selecting this provider directly',
        'FORK_NO_STAGED_SOURCE',
      )
    }
    if (this.#scope.getStore() !== entry) {
      throw new HandoffError(
        'fork-from: the staged source belongs to another spawn_teammate_from call; use that tool instead of selecting this provider directly',
        'FORK_STAGED_FOR_ANOTHER_CALL',
      )
    }
    this.#staged.delete(leadId)
    entry.taken = true
    return {
      sourceId: entry.sourceId,
      sourceName: entry.sourceName,
      resolveCut(cutSeq, diagnostics = []) {
        entry.cutSeq = cutSeq
        entry.diagnostics = [...diagnostics]
      },
    }
  }

  /**
   * Drop any staged source of one Lead.
   * @param leadId - Lead Session id.
   */
  clear(leadId: string): void {
    this.#staged.delete(leadId)
  }

  /**
   * Whether a source is currently staged for a Lead.
   * @param leadId - Lead Session id.
   * @returns true while staged and not yet taken or cleared.
   */
  has(leadId: string): boolean {
    return this.#staged.has(leadId)
  }

  /** Number of Leads whose mutex is held or awaited. */
  get lockedLeads(): number {
    return this.#locks.size
  }

  /** Drop every staged source (plugin disposal). */
  clearAll(): void {
    this.#staged.clear()
  }
}

/** Await `promise`, rejecting early with the signal's reason. */
async function waitOrAbort(promise: Promise<void>, signal: AbortSignal | undefined): Promise<void> {
  if (signal === undefined) return promise
  signal.throwIfAborted()
  const aborted = Promise.withResolvers<never>()
  const onAbort = (): void => { aborted.reject(signal.reason) }
  signal.addEventListener('abort', onAbort, { once: true })
  try {
    await Promise.race([promise, aborted.promise])
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}
