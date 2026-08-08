import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'

import { useHistoryListFeedback } from '../context/HistoryListFeedbackContext'
import { ApiError } from '../lib/apiClient'
import { createOutcome } from '../lib/outcomeApi'
import type { OutcomeEventType, OutcomeOut } from '../lib/outcomeTypes'
import { OUTCOMES_QUERY_KEY } from '../lib/queryKeys'

type Props = {
  generatedEmailId: number
  /** Non-voided outcomes for this email — from the page-level in-memory group. */
  outcomes: OutcomeOut[]
}

const EVENT_OPTIONS: { value: OutcomeEventType; label: string }[] = [
  { value: 'sent', label: 'Sent' },
  { value: 'no_response', label: 'No response' },
  { value: 'replied', label: 'Replied' },
  { value: 'interview', label: 'Interview' },
]

function hasNonVoidedSent(outcomes: OutcomeOut[]): boolean {
  return outcomes.some((outcome) => outcome.event_type === 'sent')
}

function isOptionDisabled(
  value: OutcomeEventType,
  sentExists: boolean,
): boolean {
  if (value === 'sent') return sentExists
  return !sentExists
}

/**
 * Log any OutcomeEventType against a past email (Slice 2b).
 * Reuses createOutcome — does not hardcode "sent" the way FRAME 6 does.
 *
 * Options respect the SENT gate from already-fetched outcomes: Sent is
 * disabled once a non-voided Sent exists; other types stay disabled until
 * Sent exists. No extra fetch.
 *
 * On success: notify HistoryPage (toast + optional fade) using in-memory
 * counts *before* invalidating OUTCOMES_QUERY_KEY.
 */
export function LogOutcomeForm({ generatedEmailId, outcomes }: Props) {
  const queryClient = useQueryClient()
  const { onLogSuccess } = useHistoryListFeedback()
  const sentExists = hasNonVoidedSent(outcomes)
  const [eventType, setEventType] = useState<OutcomeEventType>(
    sentExists ? 'replied' : 'sent',
  )
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (sentExists && eventType === 'sent') {
      setEventType('replied')
    } else if (!sentExists && eventType !== 'sent') {
      setEventType('sent')
    }
  }, [sentExists, eventType])

  const mutation = useMutation({
    mutationFn: () =>
      createOutcome({
        generated_email_id: generatedEmailId,
        event_type: eventType,
      }),
    onSuccess: (created) => {
      setError(null)
      // Membership check uses pre-invalidate counts held in local memory.
      onLogSuccess({
        generatedEmailId,
        eventType: created.event_type,
        activeCountBefore: outcomes.length,
      })
      void queryClient.invalidateQueries({ queryKey: OUTCOMES_QUERY_KEY })
    },
    onError: (err) => {
      if (err instanceof ApiError) {
        setError(err.user_message)
      } else {
        setError('Something went wrong. Please try again.')
      }
    },
  })

  const selectedDisabled = isOptionDisabled(eventType, sentExists)

  return (
    <form
      className="log-outcome-form"
      aria-label="Log an outcome"
      onSubmit={(e) => {
        e.preventDefault()
        if (selectedDisabled) return
        setError(null)
        mutation.mutate()
      }}
    >
      <label>
        Event type
        <select
          value={eventType}
          onChange={(e) => setEventType(e.target.value as OutcomeEventType)}
          disabled={mutation.isPending}
        >
          {EVENT_OPTIONS.map((option) => (
            <option
              key={option.value}
              value={option.value}
              disabled={isOptionDisabled(option.value, sentExists)}
            >
              {option.label}
            </option>
          ))}
        </select>
      </label>
      <button
        type="submit"
        disabled={mutation.isPending || selectedDisabled}
      >
        {mutation.isPending ? 'Logging…' : error ? 'Retry' : 'Log outcome'}
      </button>
      {error ? (
        <p className="auth-error" role="alert">
          {error}
        </p>
      ) : null}
    </form>
  )
}
