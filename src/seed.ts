/**
 * Pure seed helpers: cut a source Session log to a completed-turn prefix.
 * A seed must be contiguous from seq 0, lossless JSON, and balanced (no open turn).
 *
 * The cut must also leave the source's durable inbox empty. The `inbox` projection folds every
 * `agent/inbox/spliced` event of the seed, so a message queued for the source but not yet claimed
 * at the cut (for example a follow-up queued while the source was running, claimed by its next
 * turn) would otherwise become a pending prompt of the child and run as the child's own turn.
 */
import type { SessionEvent } from '@deepseek-ai/dsh-session'

/** Stable reasons raised by {@link ForkSeedError}. */
export type ForkSeedErrorCode = 'FORK_NO_COMPLETED_TURN' | 'FORK_NON_CONTIGUOUS_LOG' | 'FORK_PENDING_INBOX'

/** Raised when a source log cannot produce a valid fork seed. */
export class ForkSeedError extends Error {
  override readonly name = 'ForkSeedError'
  /**
   * @param message - human-readable reason.
   * @param code - stable machine-readable reason.
   */
  constructor(message: string, readonly code: ForkSeedErrorCode) {
    super(message)
  }
}

/** One chosen fork cut. */
export interface ForkCut {
  /** Events up to and including the chosen `turn/end` (shared, not cloned). */
  readonly seed: SessionEvent[]
  /** Later `turn/end` events skipped because the source inbox was not empty there. */
  readonly skippedTurnEnds: number
}

/**
 * Index of the last `turn/end` event, or -1 when none exists.
 * @param events - a Session log in seq order.
 * @returns the array index of the last `turn/end`.
 */
export function lastTurnEndIndex(events: readonly SessionEvent[]): number {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index]?.type === 'turn/end') return index
  }
  return -1
}

/** Mutable placeholder fold of the two durable inbox lists (only their lengths matter). */
interface InboxFold {
  'next-turn': unknown[]
  'next-step': unknown[]
}

/** Apply one event to the inbox fold, mirroring the `inbox` projection's splice semantics. */
function applyInbox(fold: InboxFold, event: SessionEvent): void {
  if (event.type !== 'agent/inbox/spliced') return
  const { target, start, removedCount, inserted } = event.data
  fold[target].splice(start, removedCount ?? 0, ...inserted)
}

/**
 * Number of inbox messages still pending after folding `events` from the start.
 * @param events - a Session log prefix in seq order.
 * @returns pending next-turn plus next-step messages.
 */
export function pendingInboxCount(events: readonly SessionEvent[]): number {
  const fold: InboxFold = { 'next-turn': [], 'next-step': [] }
  for (const event of events) applyInbox(fold, event)
  return fold['next-turn'].length + fold['next-step'].length
}

/**
 * Choose the latest `turn/end` at which the source inbox is empty and cut the log there.
 * @param events - complete source log, contiguous from seq 0.
 * @returns the seed and how many later `turn/end` boundaries were skipped.
 * @throws {ForkSeedError} `FORK_NO_COMPLETED_TURN` when the log has no `turn/end`;
 *   `FORK_PENDING_INBOX` when every `turn/end` leaves an unclaimed inbox message;
 *   `FORK_NON_CONTIGUOUS_LOG` when the kept slice is not contiguous from seq 0.
 */
export function forkCut(events: readonly SessionEvent[]): ForkCut {
  const fold: InboxFold = { 'next-turn': [], 'next-step': [] }
  let clean = -1
  let turnEnds = 0
  let turnEndsAtClean = 0
  for (const [index, event] of events.entries()) {
    applyInbox(fold, event)
    if (event.type !== 'turn/end') continue
    turnEnds += 1
    if (fold['next-turn'].length + fold['next-step'].length === 0) {
      clean = index
      turnEndsAtClean = turnEnds
    }
  }
  if (turnEnds === 0) {
    throw new ForkSeedError('fork-from: the source teammate has no completed turn to fork from', 'FORK_NO_COMPLETED_TURN')
  }
  if (clean < 0) {
    throw new ForkSeedError(
      'fork-from: every completed turn of the source teammate leaves an unclaimed inbox message that the new teammate would inherit; retry after the source finishes its current turn',
      'FORK_PENDING_INBOX',
    )
  }
  const seed = events.slice(0, clean + 1)
  for (const [index, event] of seed.entries()) {
    if (event.seq !== index) {
      throw new ForkSeedError(
        `fork-from: source log is not contiguous from seq 0 (index ${index} has seq ${event.seq})`,
        'FORK_NON_CONTIGUOUS_LOG',
      )
    }
  }
  return { seed, skippedTurnEnds: turnEnds - turnEndsAtClean }
}

/**
 * Cut a Session log to its latest completed-turn prefix whose inbox is empty (see {@link forkCut}).
 * @param events - complete source log, contiguous from seq 0.
 * @returns a new array holding the prefix (events are shared, not cloned).
 * @throws {ForkSeedError} see {@link forkCut}.
 */
export function completedTurnPrefix(events: readonly SessionEvent[]): SessionEvent[] {
  return forkCut(events).seed
}

/**
 * Seq of the last event of a seed produced by {@link completedTurnPrefix}.
 * @param seed - a non-empty completed-turn prefix.
 * @returns the seq of its final `turn/end`.
 */
export function cutSeqOf(seed: readonly SessionEvent[]): number {
  const last = seed.at(-1)
  if (last === undefined) throw new ForkSeedError('fork-from: empty seed has no cut', 'FORK_NO_COMPLETED_TURN')
  return last.seq
}
