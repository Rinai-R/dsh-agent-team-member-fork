import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { completedTurnPrefix, cutSeqOf, forkCut, ForkSeedError, lastTurnEndIndex, pendingInboxCount } from '../src/seed.js'
import { events, fakeEvent } from './helpers.js'

describe('completedTurnPrefix', () => {
  it('cuts through the last turn/end inclusive', () => {
    const log = events(['session/start', 'turn/start', 'turn/end', 'turn/start', 'turn/end', 'turn/start', 'step/start'])
    const seed = completedTurnPrefix(log)
    expect(seed.map(e => e.seq)).toEqual([0, 1, 2, 3, 4])
    expect(seed.at(-1)?.type).toBe('turn/end')
    expect(cutSeqOf(seed)).toBe(4)
  })

  it('keeps the whole log when it ends with turn/end and returns a new array', () => {
    const log = events(['a', 'turn/end'])
    const seed = completedTurnPrefix(log)
    expect(seed).toEqual(log)
    expect(seed).not.toBe(log)
    expect(seed[0]).toBe(log[0])
  })

  it('rejects a log without a completed turn', () => {
    expect(() => completedTurnPrefix(events(['session/start', 'turn/start']))).toThrow(ForkSeedError)
    expect(() => completedTurnPrefix([])).toThrow(expect.objectContaining({ code: 'FORK_NO_COMPLETED_TURN' }))
  })

  it('rejects a non-contiguous kept slice', () => {
    const log = [fakeEvent('a', 0), fakeEvent('b', 2), fakeEvent('turn/end', 3)]
    expect(() => completedTurnPrefix(log)).toThrow(expect.objectContaining({ code: 'FORK_NON_CONTIGUOUS_LOG' }))
  })

  it('rejects a slice that does not start at seq 0', () => {
    const log = [fakeEvent('a', 1), fakeEvent('turn/end', 2)]
    expect(() => completedTurnPrefix(log)).toThrow(expect.objectContaining({ code: 'FORK_NON_CONTIGUOUS_LOG' }))
  })

  it('ignores gaps after the cut', () => {
    const log = [fakeEvent('a', 0), fakeEvent('turn/end', 1), fakeEvent('x', 7)]
    expect(completedTurnPrefix(log).map(e => e.seq)).toEqual([0, 1])
  })
})

describe('lastTurnEndIndex / cutSeqOf', () => {
  it('finds the last turn/end', () => {
    expect(lastTurnEndIndex(events(['turn/end', 'x', 'turn/end', 'y']))).toBe(2)
    expect(lastTurnEndIndex(events(['x']))).toBe(-1)
  })

  it('rejects an empty seed', () => {
    expect(() => cutSeqOf([])).toThrow(ForkSeedError)
  })
})

function splice(seq: number, target: 'next-turn' | 'next-step', start: number, removedCount: number, inserted: number): SessionEvent {
  const data = { target, start, ...(removedCount === 0 ? {} : { removedCount }), inserted: Array.from({ length: inserted }, (_, i) => ({ id: `m${seq}-${i}` })) }
  return { type: 'agent/inbox/spliced', seq, time: 0, data } as unknown as SessionEvent
}

describe('inbox-aware cut', () => {
  it('folds splices like the inbox projection', () => {
    const log = [splice(0, 'next-turn', 0, 0, 2), splice(1, 'next-step', 0, 0, 1), splice(2, 'next-turn', 0, 1, 0), splice(3, 'next-step', 0, 1, 0)]
    expect(pendingInboxCount(log.slice(0, 2))).toBe(3)
    expect(pendingInboxCount(log)).toBe(1)
  })

  it('keeps the last turn/end when the inbox is empty there', () => {
    const log = [fakeEvent('turn/start', 0), splice(1, 'next-step', 0, 0, 1), splice(2, 'next-step', 0, 1, 0), fakeEvent('turn/end', 3)]
    expect(forkCut(log)).toMatchObject({ skippedTurnEnds: 0 })
    expect(forkCut(log).seed).toHaveLength(4)
  })

  it('falls back to the latest turn/end whose inbox is empty', () => {
    const log = [
      fakeEvent('turn/start', 0), fakeEvent('turn/end', 1),
      fakeEvent('turn/start', 2), splice(3, 'next-turn', 0, 0, 1), fakeEvent('turn/end', 4),
      splice(5, 'next-turn', 0, 1, 0), fakeEvent('turn/start', 6),
    ]
    const cut = forkCut(log)
    expect(cut.seed.map(e => e.seq)).toEqual([0, 1])
    expect(cut.skippedTurnEnds).toBe(1)
    expect(completedTurnPrefix(log).map(e => e.seq)).toEqual([0, 1])
  })

  it('rejects when every completed turn leaves a pending message', () => {
    const log = [fakeEvent('turn/start', 0), splice(1, 'next-turn', 0, 0, 1), fakeEvent('turn/end', 2), fakeEvent('turn/start', 3)]
    expect(() => forkCut(log)).toThrow(expect.objectContaining({ code: 'FORK_PENDING_INBOX' }))
  })
})
