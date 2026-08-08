import { describe, expect, it } from 'vitest'

import {
  highestTierOutcome,
  outcomeStageBadgeLabel,
  sortOutcomesChronologically,
} from './outcomeStage'
import type { OutcomeOut } from './outcomeTypes'

function outcome(
  partial: Pick<OutcomeOut, 'id' | 'event_type' | 'occurred_at'> &
    Partial<OutcomeOut>,
): OutcomeOut {
  return {
    generated_email_id: 1,
    voided: false,
    ...partial,
  }
}

describe('highestTierOutcome / outcomeStageBadgeLabel', () => {
  it('returns null / Not logged for an empty list', () => {
    expect(highestTierOutcome([])).toBeNull()
    expect(outcomeStageBadgeLabel([])).toBe('Not logged')
  })

  it('ignores voided rows', () => {
    expect(
      highestTierOutcome([
        outcome({
          id: 1,
          event_type: 'interview',
          occurred_at: '2026-08-01T12:00:00Z',
          voided: true,
        }),
      ]),
    ).toBeNull()
    expect(
      outcomeStageBadgeLabel([
        outcome({
          id: 1,
          event_type: 'sent',
          occurred_at: '2026-08-01T12:00:00Z',
          voided: true,
        }),
      ]),
    ).toBe('Not logged')
  })

  it('labels each single-outcome case correctly', () => {
    expect(
      outcomeStageBadgeLabel([
        outcome({
          id: 1,
          event_type: 'sent',
          occurred_at: '2026-08-01T12:00:00Z',
        }),
      ]),
    ).toBe('Sent')
    expect(
      outcomeStageBadgeLabel([
        outcome({
          id: 1,
          event_type: 'no_response',
          occurred_at: '2026-08-01T12:00:00Z',
        }),
      ]),
    ).toBe('No response')
    expect(
      outcomeStageBadgeLabel([
        outcome({
          id: 1,
          event_type: 'replied',
          occurred_at: '2026-08-01T12:00:00Z',
        }),
      ]),
    ).toBe('Replied')
    expect(
      outcomeStageBadgeLabel([
        outcome({
          id: 1,
          event_type: 'interview',
          occurred_at: '2026-08-01T12:00:00Z',
        }),
      ]),
    ).toBe('Interview')
  })

  it('Sent + No Response → No response', () => {
    const sent = outcome({
      id: 1,
      event_type: 'sent',
      occurred_at: '2026-08-01T12:00:00Z',
    })
    const noResponse = outcome({
      id: 2,
      event_type: 'no_response',
      occurred_at: '2026-08-05T12:00:00Z',
    })
    expect(highestTierOutcome([sent, noResponse])).toEqual(noResponse)
    expect(outcomeStageBadgeLabel([sent, noResponse])).toBe('No response')
  })

  it('Sent + No Response + Replied → Replied', () => {
    const outcomes = [
      outcome({
        id: 1,
        event_type: 'sent',
        occurred_at: '2026-08-01T12:00:00Z',
      }),
      outcome({
        id: 2,
        event_type: 'no_response',
        occurred_at: '2026-08-05T12:00:00Z',
      }),
      outcome({
        id: 3,
        event_type: 'replied',
        occurred_at: '2026-08-06T12:00:00Z',
      }),
    ]
    expect(highestTierOutcome(outcomes)?.event_type).toBe('replied')
    expect(outcomeStageBadgeLabel(outcomes)).toBe('Replied')
  })

  it('Interview always wins regardless of other non-voided rows', () => {
    const outcomes = [
      outcome({
        id: 1,
        event_type: 'sent',
        occurred_at: '2026-08-01T12:00:00Z',
      }),
      outcome({
        id: 2,
        event_type: 'no_response',
        occurred_at: '2026-08-02T12:00:00Z',
      }),
      outcome({
        id: 3,
        event_type: 'replied',
        occurred_at: '2026-08-03T12:00:00Z',
      }),
      outcome({
        id: 4,
        event_type: 'interview',
        occurred_at: '2026-08-04T12:00:00Z',
      }),
    ]
    expect(highestTierOutcome(outcomes)?.event_type).toBe('interview')
    expect(outcomeStageBadgeLabel(outcomes)).toBe('Interview')
  })

  it('Replied beats Sent even when Sent occurred later (precedence, not time)', () => {
    const replied = outcome({
      id: 1,
      event_type: 'replied',
      occurred_at: '2026-08-01T12:00:00Z',
    })
    const sent = outcome({
      id: 2,
      event_type: 'sent',
      occurred_at: '2026-08-10T12:00:00Z',
    })
    expect(highestTierOutcome([replied, sent])).toEqual(replied)
  })
})

describe('sortOutcomesChronologically', () => {
  it('orders by occurred_at ascending, not insertion or precedence order', () => {
    const interview = outcome({
      id: 10,
      event_type: 'interview',
      occurred_at: '2026-08-03T12:00:00Z',
    })
    const sent = outcome({
      id: 1,
      event_type: 'sent',
      occurred_at: '2026-08-01T12:00:00Z',
    })
    const replied = outcome({
      id: 5,
      event_type: 'replied',
      occurred_at: '2026-08-02T12:00:00Z',
    })
    // Insertion order deliberately wrong (interview first, then sent).
    expect(
      sortOutcomesChronologically([interview, sent, replied]).map((o) => o.id),
    ).toEqual([1, 5, 10])
  })

  it('excludes voided rows', () => {
    expect(
      sortOutcomesChronologically([
        outcome({
          id: 1,
          event_type: 'sent',
          occurred_at: '2026-08-01T12:00:00Z',
          voided: true,
        }),
        outcome({
          id: 2,
          event_type: 'replied',
          occurred_at: '2026-08-02T12:00:00Z',
        }),
      ]).map((o) => o.id),
    ).toEqual([2])
  })
})
