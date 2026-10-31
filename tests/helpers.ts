/** Shared fakes for unit tests. */
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'

/** Build a structurally minimal event; only `type` and `seq` matter to the code under test. */
export function fakeEvent(type: string, seq: number): SessionEvent {
  return { type, seq, time: 0, data: {} } as unknown as SessionEvent
}

/** Contiguous events from seq 0. */
export function events(types: readonly string[]): SessionEvent[] {
  return types.map((type, seq) => fakeEvent(type, seq))
}

/** A fake Agent exposing only the fields the plugin reads. */
export function fakeAgent(id: string, extra: Record<string, unknown> = {}): Agent {
  return {
    id: SessionId(id),
    session: { id: SessionId(id), header: { id: SessionId(id) } },
    ...extra,
  } as unknown as Agent
}
