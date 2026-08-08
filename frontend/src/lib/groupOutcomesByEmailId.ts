import type { OutcomeOut } from './outcomeTypes'

/**
 * Group a flat outcomes list by generated_email_id for O(1) per-row lookups.
 * Used by /history so one GET /outcomes drives both stage badges and
 * per-row timelines — not one fetch per email.
 */
export function groupOutcomesByEmailId(
  outcomes: OutcomeOut[],
): Map<number, OutcomeOut[]> {
  const byEmail = new Map<number, OutcomeOut[]>()
  for (const outcome of outcomes) {
    const existing = byEmail.get(outcome.generated_email_id)
    if (existing) {
      existing.push(outcome)
    } else {
      byEmail.set(outcome.generated_email_id, [outcome])
    }
  }
  return byEmail
}
