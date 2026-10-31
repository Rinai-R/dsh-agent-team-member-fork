import { describe, expect, it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { HandoffError, HandoffRegistry } from '../src/handoff.js'

const SRC = { sourceId: SessionId('src-1'), sourceName: 'expert' }

function deferred<T = void>() {
  return Promise.withResolvers<T>()
}

describe('HandoffRegistry staging', () => {
  it('takes a staged source exactly once and reports the cut through the ticket', () => {
    const handoff = new HandoffRegistry()
    const ticket = handoff.stage('lead', SRC)
    expect(ticket.taken).toBe(false)
    expect(handoff.has('lead')).toBe(true)
    const taken = ticket.run(() => handoff.take('lead'))
    expect(taken).toMatchObject(SRC)
    expect(ticket.taken).toBe(true)
    expect(ticket.cutSeq).toBeUndefined()
    taken.resolveCut(41)
    expect(ticket.cutSeq).toBe(41)
    expect(handoff.has('lead')).toBe(false)
    expect(() => ticket.run(() => handoff.take('lead'))).toThrow(expect.objectContaining({ code: 'FORK_NO_STAGED_SOURCE' }))
  })

  it('throws when nothing was staged', () => {
    expect(() => new HandoffRegistry().take('lead')).toThrow(HandoffError)
  })

  it('is keyed per Lead', () => {
    const handoff = new HandoffRegistry()
    const ticket = handoff.stage('lead-a', SRC)
    expect(() => ticket.run(() => handoff.take('lead-b'))).toThrow(HandoffError)
    expect(ticket.run(() => handoff.take('lead-a')).sourceName).toBe('expert')
  })

  it('rejects double staging for one Lead', () => {
    const handoff = new HandoffRegistry()
    handoff.stage('lead', SRC)
    expect(() => handoff.stage('lead', SRC)).toThrow(expect.objectContaining({ code: 'FORK_ALREADY_STAGED' }))
  })

  it('reports cut diagnostics through the ticket', () => {
    const handoff = new HandoffRegistry()
    const ticket = handoff.stage('lead', SRC)
    expect(ticket.diagnostics).toEqual([])
    ticket.run(() => handoff.take('lead')).resolveCut(3, ['skipped'])
    expect(ticket.cutSeq).toBe(3)
    expect(ticket.diagnostics).toEqual(['skipped'])
  })

  it('refuses a take outside the staging operation scope and leaves the entry for its owner', async () => {
    const handoff = new HandoffRegistry()
    const ticket = handoff.stage('lead', SRC)
    // A concurrent, unrelated async chain (e.g. a parallel direct provider selection).
    const thief = (async () => {
      await Promise.resolve()
      return handoff.take('lead')
    })()
    await expect(thief).rejects.toMatchObject({ code: 'FORK_STAGED_FOR_ANOTHER_CALL' })
    expect(handoff.has('lead')).toBe(true)
    expect(ticket.taken).toBe(false)
    // The owner's async continuation still takes it.
    const owner = await ticket.run(async () => {
      await new Promise(resolve => setTimeout(resolve, 1))
      return handoff.take('lead')
    })
    expect(owner.sourceName).toBe('expert')
    expect(ticket.taken).toBe(true)
  })

  it('does not let a stale scope take a later stage for the same Lead', () => {
    const handoff = new HandoffRegistry()
    const first = handoff.stage('lead', SRC)
    handoff.clear('lead')
    handoff.stage('lead', { sourceId: SessionId('src-2'), sourceName: 'other' })
    expect(() => first.run(() => handoff.take('lead'))).toThrow(expect.objectContaining({ code: 'FORK_STAGED_FOR_ANOTHER_CALL' }))
    expect(handoff.has('lead')).toBe(true)
  })

  it('clear and clearAll drop staged entries', () => {
    const handoff = new HandoffRegistry()
    handoff.stage('a', SRC)
    handoff.stage('b', SRC)
    handoff.clear('a')
    expect(handoff.has('a')).toBe(false)
    handoff.clearAll()
    expect(handoff.has('b')).toBe(false)
  })
})

describe('HandoffRegistry.withLeadLock', () => {
  it('serializes calls for the same Lead in call order', async () => {
    const handoff = new HandoffRegistry()
    const order: string[] = []
    const gate = deferred()
    const first = handoff.withLeadLock('lead', async () => {
      order.push('first:start')
      await gate.promise
      order.push('first:end')
      return 1
    })
    const second = handoff.withLeadLock('lead', async () => {
      order.push('second')
      return 2
    })
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(order).toEqual(['first:start'])
    gate.resolve()
    await expect(first).resolves.toBe(1)
    await expect(second).resolves.toBe(2)
    expect(order).toEqual(['first:start', 'first:end', 'second'])
    expect(handoff.lockedLeads).toBe(0)
  })

  it('runs different Leads concurrently', async () => {
    const handoff = new HandoffRegistry()
    const gate = deferred()
    const started: string[] = []
    const a = handoff.withLeadLock('a', async () => { started.push('a'); await gate.promise })
    const b = handoff.withLeadLock('b', async () => { started.push('b'); await gate.promise })
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(started.sort()).toEqual(['a', 'b'])
    gate.resolve()
    await Promise.all([a, b])
  })

  it('releases the lock after a throw', async () => {
    const handoff = new HandoffRegistry()
    await expect(handoff.withLeadLock('lead', () => Promise.reject(new Error('boom')))).rejects.toThrow('boom')
    await expect(handoff.withLeadLock('lead', () => Promise.resolve('next'))).resolves.toBe('next')
    expect(handoff.lockedLeads).toBe(0)
  })

  it('aborts while waiting without blocking later callers', async () => {
    const handoff = new HandoffRegistry()
    const gate = deferred()
    const holder = handoff.withLeadLock('lead', () => gate.promise)
    const controller = new AbortController()
    let ran = false
    const waiter = handoff.withLeadLock('lead', async () => { ran = true }, controller.signal)
    const third = handoff.withLeadLock('lead', () => Promise.resolve('third'))
    controller.abort(new Error('cancelled'))
    await expect(waiter).rejects.toThrow('cancelled')
    expect(ran).toBe(false)
    gate.resolve()
    await holder
    await expect(third).resolves.toBe('third')
  })

  it('keeps excluding later callers when the last waiter cancels while the holder still runs', async () => {
    const handoff = new HandoffRegistry()
    const releaseA = deferred()
    const events: string[] = []
    const a = handoff.withLeadLock('lead', async () => {
      events.push('A:start')
      await releaseA.promise
      events.push('A:end')
    })
    const controller = new AbortController()
    const b = handoff.withLeadLock('lead', async () => { events.push('B:ran') }, controller.signal)
    await new Promise(resolve => setTimeout(resolve, 5))
    controller.abort(new Error('B cancelled'))
    await expect(b).rejects.toThrow('B cancelled')
    expect(handoff.lockedLeads).toBe(1)
    // C arrives after B (the previous tail) left: it must still wait for A.
    const c = handoff.withLeadLock('lead', async () => { events.push('C:start') })
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(events).toEqual(['A:start'])
    releaseA.resolve()
    await a
    await c
    expect(events).toEqual(['A:start', 'A:end', 'C:start'])
    expect(handoff.lockedLeads).toBe(0)
  })

  it('keeps excluding later callers when a middle waiter cancels', async () => {
    const handoff = new HandoffRegistry()
    const releaseA = deferred()
    const events: string[] = []
    const a = handoff.withLeadLock('lead', async () => { events.push('A'); await releaseA.promise; events.push('A:end') })
    const controller = new AbortController()
    const b = handoff.withLeadLock('lead', async () => { events.push('B') }, controller.signal)
    const c = handoff.withLeadLock('lead', async () => { events.push('C') })
    controller.abort(new Error('B cancelled'))
    await expect(b).rejects.toThrow('B cancelled')
    const d = handoff.withLeadLock('lead', async () => { events.push('D') })
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(events).toEqual(['A'])
    releaseA.resolve()
    await Promise.all([a, c, d])
    expect(events).toEqual(['A', 'A:end', 'C', 'D'])
    expect(handoff.lockedLeads).toBe(0)
  })

  it('rejects immediately with an already aborted signal', async () => {
    const handoff = new HandoffRegistry()
    const controller = new AbortController()
    controller.abort(new Error('early'))
    await expect(handoff.withLeadLock('lead', () => Promise.resolve(1), controller.signal)).rejects.toThrow('early')
    expect(handoff.lockedLeads).toBe(0)
  })

  it('serializes stage/take/clear cycles so concurrent forks cannot swap sources', async () => {
    const handoff = new HandoffRegistry()
    const seen: string[] = []
    const run = (name: string) => handoff.withLeadLock('lead', async () => {
      const ticket = handoff.stage('lead', { sourceId: SessionId(name), sourceName: name })
      try {
        await ticket.run(async () => {
          await new Promise(resolve => setTimeout(resolve, 5))
          seen.push(handoff.take('lead').sourceName)
        })
      } finally {
        handoff.clear('lead')
      }
    })
    await Promise.all([run('a'), run('b'), run('c')])
    expect(seen).toEqual(['a', 'b', 'c'])
  })
})
