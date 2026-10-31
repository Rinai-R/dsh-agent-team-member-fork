/** Lineage plugin record written to the Lead Session after a successful fork. */
import { appendPluginRecord, pluginRecordOf, SessionId } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent, SessionSeq } from '@deepseek-ai/dsh-session'
import type { LineageRecord } from './types.js'

/** Record type of the lineage plugin record. */
export const LINEAGE_RECORD_TYPE = 'plugin:dsh-agent-team-member-fork/lineage'

declare module '@deepseek-ai/dsh-session/types' {
  interface PluginRecordMap {
    'plugin:dsh-agent-team-member-fork/lineage': LineageRecord
  }
}

/**
 * Append one lineage record (ignorable, never model-visible) to a Session log.
 * @param session - the Lead Session.
 * @param record - child, source, and cut.
 * @returns the committed seq.
 */
export function appendLineage(session: Session, record: LineageRecord): SessionSeq {
  return appendPluginRecord(session, LINEAGE_RECORD_TYPE, record)
}

/**
 * Read a lineage record back from one committed event, validating its data.
 * @param event - any Session event.
 * @returns the record, or undefined when the event is not a valid lineage record.
 */
export function lineageOf(event: SessionEvent): LineageRecord | undefined {
  const record = pluginRecordOf(event)
  if (record?.type !== LINEAGE_RECORD_TYPE) return undefined
  const data = record.data
  if (typeof data !== 'object' || data === null) return undefined
  const value = data as Record<string, unknown>
  const { version, childId, childName, sourceId, sourceName, cutSeq } = value
  if (version !== 1) return undefined
  if (typeof childId !== 'string' || typeof childName !== 'string') return undefined
  if (typeof sourceId !== 'string' || typeof sourceName !== 'string') return undefined
  if (typeof cutSeq !== 'number' || !Number.isSafeInteger(cutSeq) || cutSeq < 0) return undefined
  return { version: 1, childId: SessionId(childId), childName, sourceId: SessionId(sourceId), sourceName, cutSeq }
}
