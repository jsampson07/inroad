import type { OutcomeEventType } from './outcomeTypes'

/** Match accordion-ish timing; leaving-set clear + CSS fade-out share this. */
export const HISTORY_ROW_FADE_OUT_MS = 280

/** Toast auto-dismiss duration (~3s). */
export const HISTORY_TOAST_DISMISS_MS = 3000

/** Event-type labels for history toast copy (exact product wording). */
export const OUTCOME_TOAST_LABELS: Record<OutcomeEventType, string> = {
  sent: 'Sent',
  no_response: 'No Response',
  replied: 'Replied',
  interview: 'Interview',
}

export function logSuccessToastMessage(eventType: OutcomeEventType): string {
  return `Marked as ${OUTCOME_TOAST_LABELS[eventType]}`
}

export function retractSuccessToastMessage(
  eventType: OutcomeEventType,
): string {
  return `Retracted: ${OUTCOME_TOAST_LABELS[eventType]}`
}
