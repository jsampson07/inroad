import type { OutcomeEventType, OutcomeOut } from './outcomeTypes'

/**
 * Fixed badge precedence for the highest-tier non-voided outcome on an email.
 * Interview wins over everything; empty list → no stage (badge stays "Not logged").
 */
const TIER_RANK: Record<OutcomeEventType, number> = {
  interview: 4,
  replied: 3,
  no_response: 2,
  sent: 1,
}

/** Display labels shared by the row badge (and reusable elsewhere). */
export const OUTCOME_STAGE_LABELS: Record<OutcomeEventType, string> = {
  sent: 'Sent',
  no_response: 'No response',
  replied: 'Replied',
  interview: 'Interview',
}

/**
 * Highest-tier non-voided outcome for an email, by fixed precedence:
 * Interview > Replied > No Response > Sent.
 * Returns null when there are no non-voided outcomes.
 * Tie-break among the same event_type: earliest occurred_at (stable, deterministic).
 */
export function highestTierOutcome(
  outcomes: OutcomeOut[],
): OutcomeOut | null {
  let best: OutcomeOut | null = null
  let bestRank = 0

  for (const outcome of outcomes) {
    if (outcome.voided) continue
    const rank = TIER_RANK[outcome.event_type]
    if (rank > bestRank) {
      best = outcome
      bestRank = rank
      continue
    }
    if (
      rank === bestRank &&
      best != null &&
      outcome.occurred_at < best.occurred_at
    ) {
      best = outcome
    }
  }

  return best
}

/** Badge text for a row: stage label or "Not logged". */
export function outcomeStageBadgeLabel(outcomes: OutcomeOut[]): string {
  const top = highestTierOutcome(outcomes)
  return top ? OUTCOME_STAGE_LABELS[top.event_type] : 'Not logged'
}

/**
 * Non-voided outcomes ordered by occurred_at ascending (chronological timeline).
 * Does not use badge precedence order.
 */
export function sortOutcomesChronologically(
  outcomes: OutcomeOut[],
): OutcomeOut[] {
  return outcomes
    .filter((outcome) => !outcome.voided)
    .slice()
    .sort((a, b) => {
      if (a.occurred_at < b.occurred_at) return -1
      if (a.occurred_at > b.occurred_at) return 1
      return a.id - b.id
    })
}
