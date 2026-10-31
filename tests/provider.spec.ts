import { describe, expect, it, vi } from 'vitest'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { SessionObservation } from '@deepseek-ai/dsh-session-query'
import { HandoffRegistry } from '../src/handoff.js'
import { createForkFromProvider, sessionQueryReader, type SourceEventReader } from '../src/provider.js'
import { events, fakeAgent } from './helpers.js'

const LEAD = fakeAgent('lead')
const SIGNAL = new AbortController().signal

function request() {
  return { cwd: '/w', sessionId: SessionId('child'), parent: LEAD, signal: SIGNAL }
}

function provider(readSource: SourceEventReader, handoff = new HandoffRegistry()) {
  return { handoff, provider: createForkFromProvider({ name: 'fork-from', handoff, readSource }) }
}

describe('fork-from provider', () => {
  it('declares the same capabilities as the official fork provider', () => {
    const { provider: p } = provider(vi.fn())
    expect(p.name).toBe('fork-from')
    expect(p.capabilities).toEqual({ agentOptions: true, agentPreset: false, outputSchema: true, depthLimit: true })
    expect(p.inheritsParentContext).toBe(true)
    expect(p.start).toBeUndefined()
  })

  it('throws without a staged source and never reads any log', async () => {
    const read = vi.fn<SourceEventReader>()
    const { provider: p } = provider(read)
    await expect(p.prepareContinuable!(request())).rejects.toMatchObject({ code: 'FORK_NO_STAGED_SOURCE' })
    expect(read).not.toHaveBeenCalled()
  })

  it('seeds with the source completed-turn prefix and reports the cut', async () => {
    const log = events(['session/start', 'turn/start', 'turn/end', 'turn/start'])
    const read = vi.fn<SourceEventReader>().mockResolvedValue({ parentSession: SessionId('lead'), events: log })
    const { provider: p, handoff } = provider(read)
    const ticket = handoff.stage('lead', { sourceId: SessionId('expert-id'), sourceName: 'expert' })
    const spec = await ticket.run(() => p.prepareContinuable!(request()))
    expect(read).toHaveBeenCalledWith('expert-id', SIGNAL)
    expect(spec.seed?.map(e => e.seq)).toEqual([0, 1, 2])
    expect(ticket.cutSeq).toBe(2)
    expect(handoff.has('lead')).toBe(false)
  })

  it('refuses a preparation outside the staging scope without consuming or reading', async () => {
    const read = vi.fn<SourceEventReader>()
    const { provider: p, handoff } = provider(read)
    const ticket = handoff.stage('lead', { sourceId: SessionId('x'), sourceName: 'x' })
    await expect(p.prepareContinuable!(request())).rejects.toMatchObject({ code: 'FORK_STAGED_FOR_ANOTHER_CALL' })
    expect(read).not.toHaveBeenCalled()
    expect(ticket.taken).toBe(false)
    expect(handoff.has('lead')).toBe(true)
  })

  it('cuts before an unclaimed inbox message and reports the skipped turn', async () => {
    const log = [
      ...events(['session/start', 'turn/start', 'turn/end', 'turn/start']),
      { type: 'agent/inbox/spliced', seq: 4, time: 0, data: { target: 'next-turn', start: 0, inserted: [{ id: 'm' }] } },
      ...events(['turn/end', 'turn/start']).map((e, i) => ({ ...e, seq: 5 + i })),
    ] as unknown as SessionEvent[]
    const read = vi.fn<SourceEventReader>().mockResolvedValue({ parentSession: SessionId('lead'), events: log })
    const { provider: p, handoff } = provider(read)
    const ticket = handoff.stage('lead', { sourceId: SessionId('x'), sourceName: 'x' })
    const spec = await ticket.run(() => p.prepareContinuable!(request()))
    expect(spec.seed?.map(e => e.seq)).toEqual([0, 1, 2])
    expect(ticket.cutSeq).toBe(2)
    expect(ticket.diagnostics).toEqual([expect.stringContaining('skipped the source\'s last 1 completed turn')])
  })

  it('rejects a source with no completed turn', async () => {
    const read = vi.fn<SourceEventReader>().mockResolvedValue({ parentSession: SessionId('lead'), events: events(['turn/start']) })
    const { provider: p, handoff } = provider(read)
    const ticket = handoff.stage('lead', { sourceId: SessionId('x'), sourceName: 'x' })
    await expect(ticket.run(() => p.prepareContinuable!(request()))).rejects.toMatchObject({ code: 'FORK_NO_COMPLETED_TURN' })
    expect(ticket.cutSeq).toBeUndefined()
  })

  it('rejects a source that is not a child of this Lead', async () => {
    const read = vi.fn<SourceEventReader>().mockResolvedValue({ parentSession: SessionId('other'), events: events(['turn/end']) })
    const { provider: p, handoff } = provider(read)
    const ticket = handoff.stage('lead', { sourceId: SessionId('x'), sourceName: 'x' })
    await expect(ticket.run(() => p.prepareContinuable!(request()))).rejects.toThrow(/not a direct child/)
  })

  it('honours an aborted signal after taking the source', async () => {
    const read = vi.fn<SourceEventReader>()
    const { provider: p, handoff } = provider(read)
    const ticket = handoff.stage('lead', { sourceId: SessionId('x'), sourceName: 'x' })
    const controller = new AbortController()
    controller.abort(new Error('stop'))
    await expect(ticket.run(() => p.prepareContinuable!({ ...request(), signal: controller.signal }))).rejects.toThrow('stop')
    expect(read).not.toHaveBeenCalled()
  })
})

describe('sessionQueryReader', () => {
  it('reads through observeSession with projectionMode none, copies events, and disposes the observation', async () => {
    const log: readonly SessionEvent[] = events(['a', 'turn/end'])
    const dispose = vi.fn()
    const observeSession = vi.fn().mockResolvedValue({
      header: { id: SessionId('expert'), parentSession: SessionId('lead') },
      events: log,
      [Symbol.dispose]: dispose,
    } as unknown as SessionObservation)
    const read = sessionQueryReader({ observeSession })
    const result = await read(SessionId('expert'), SIGNAL)
    expect(observeSession).toHaveBeenCalledWith('expert', { signal: SIGNAL, projectionMode: 'none' })
    expect(result.parentSession).toBe('lead')
    expect(result.events).toEqual(log)
    expect(result.events).not.toBe(log)
    expect(dispose).toHaveBeenCalledOnce()
  })

  it('disposes the observation even when reading events throws', async () => {
    const dispose = vi.fn()
    const observation = {
      header: { id: SessionId('expert') },
      get events(): never { throw new Error('read failed') },
      [Symbol.dispose]: dispose,
    }
    const read = sessionQueryReader({ observeSession: vi.fn().mockResolvedValue(observation) })
    await expect(read(SessionId('expert'), SIGNAL)).rejects.toThrow('read failed')
    expect(dispose).toHaveBeenCalledOnce()
  })
})
