import { useQuery } from '@tanstack/react-query'

import { ApiError } from '../lib/apiClient'
import { getGeneratedEmailById } from '../lib/generatedEmailApi'
import {
  OUTCOME_STAGE_LABELS,
  sortOutcomesChronologically,
} from '../lib/outcomeStage'
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

function formatOccurredAt(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return date.toLocaleString()
}

/**
 * Expanded row content: full subject/body (fetched once on expand, cached by
 * TanStack Query) + chronological outcome timeline from already-loaded
 * outcomes (no refetch). Timeline is a horizontal connected flow; each node
 * keeps its own retract control.
 */
export function HistoryEmailDetail({ emailId, outcomes, enabled }: Props) {
  const detailQuery = useQuery({
    queryKey: generatedEmailDetailQueryKey(emailId),
    queryFn: () => getGeneratedEmailById(emailId),
    enabled,
  })

  const chronological = sortOutcomesChronologically(outcomes)

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
        {chronological.length === 0 ? (
          <p className="discovery-muted">No outcomes logged yet.</p>
        ) : (
          <ol className="history-outcome-flow">
            {chronological.map((outcome, index) => (
              <li key={outcome.id} className="history-outcome-step">
                <div className="history-outcome-step-rail" aria-hidden="true">
                  <span className="history-outcome-dot" />
                  {index < chronological.length - 1 ? (
                    <span className="history-outcome-connector" />
                  ) : null}
                </div>
                <div className="history-outcome-step-body">
                  <span className="history-outcome-event">
                    {OUTCOME_STAGE_LABELS[outcome.event_type]}
                  </span>
                  <span className="history-outcome-when">
                    {formatOccurredAt(outcome.occurred_at)}
                  </span>
                  <RetractOutcomeButton
                    outcomeId={outcome.id}
                    generatedEmailId={emailId}
                    eventType={outcome.event_type}
                    hasOtherNonVoidedOutcomes={chronological.length > 1}
                  />
                </div>
              </li>
            ))}
          </ol>
        )}
      </div>

      <LogOutcomeForm generatedEmailId={emailId} outcomes={outcomes} />
    </div>
  )
}
