import { useQuery } from '@tanstack/react-query'

import { ApiError } from '../lib/apiClient'
import { getGeneratedEmailById } from '../lib/generatedEmailApi'
import { generatedEmailDetailQueryKey } from '../lib/queryKeys'
import type { OutcomeOut } from '../lib/outcomeTypes'
import { LogOutcomeForm } from './LogOutcomeForm'
import { RetractOutcomeButton } from './RetractOutcomeButton'

type Props = {
  emailId: number
  /** Outcomes for this email only — filtered from the page-level list. */
  outcomes: OutcomeOut[]
  /** When false, skip the detail fetch (row collapsed). */
  enabled: boolean
}

const EVENT_LABELS: Record<OutcomeOut['event_type'], string> = {
  sent: 'Sent',
  no_response: 'No response',
  replied: 'Replied',
  interview: 'Interview',
}

function formatOccurredAt(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return date.toLocaleString()
}

/**
 * Expanded row content: full subject/body (fetched once on expand, cached by
 * TanStack Query) + outcome timeline from already-loaded outcomes (no refetch).
 */
export function HistoryEmailDetail({ emailId, outcomes, enabled }: Props) {
  const detailQuery = useQuery({
    queryKey: generatedEmailDetailQueryKey(emailId),
    queryFn: () => getGeneratedEmailById(emailId),
    enabled,
  })

  return (
    <div className="history-email-detail">
      {enabled && detailQuery.isPending ? (
        <p className="discovery-muted" role="status">
          Loading email…
        </p>
      ) : null}
      {detailQuery.isError ? (
        <p className="auth-error" role="alert">
          {detailQuery.error instanceof ApiError
            ? detailQuery.error.user_message
            : 'Could not load email details.'}
        </p>
      ) : null}
      {detailQuery.data ? (
        <div className="email-draft">
          <h3 className="discovery-subhead">Subject</h3>
          <p className="email-subject">{detailQuery.data.subject}</p>
          <h3 className="discovery-subhead">Body</h3>
          <pre className="email-body">{detailQuery.data.body}</pre>
        </div>
      ) : null}

      <div className="history-outcome-timeline">
        <h3 className="discovery-subhead">Outcome timeline</h3>
        {outcomes.length === 0 ? (
          <p className="discovery-muted">No outcomes logged yet.</p>
        ) : (
          <ul className="history-outcome-list">
            {outcomes.map((outcome) => (
              <li key={outcome.id} className="history-outcome-item">
                <span className="history-outcome-event">
                  {EVENT_LABELS[outcome.event_type]}
                </span>
                <span className="history-outcome-when">
                  {formatOccurredAt(outcome.occurred_at)}
                </span>
                <RetractOutcomeButton
                  outcomeId={outcome.id}
                  generatedEmailId={emailId}
                  eventType={outcome.event_type}
                  hasOtherNonVoidedOutcomes={outcomes.length > 1}
                />
              </li>
            ))}
          </ul>
        )}
      </div>

      <LogOutcomeForm generatedEmailId={emailId} outcomes={outcomes} />
    </div>
  )
}
