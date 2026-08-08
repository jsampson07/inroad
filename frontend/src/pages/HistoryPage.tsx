import { useQuery } from '@tanstack/react-query'
import { useEffect, useMemo, useRef, useState } from 'react'

import { AppHeader } from '../components/AppHeader'
import { HistoryEmailRow } from '../components/HistoryEmailRow'
import {
  HistoryFilter,
  type HistoryFilterValue,
} from '../components/HistoryFilter'
import { HistoryToast } from '../components/HistoryToast'
import {
  HistoryListFeedbackProvider,
  type HistoryListFeedback,
} from '../context/HistoryListFeedbackContext'
import { useAuth } from '../context/AuthContext'
import { ApiError } from '../lib/apiClient'
import { listGeneratedEmails } from '../lib/generatedEmailApi'
import { groupOutcomesByEmailId } from '../lib/groupOutcomesByEmailId'
import {
  HISTORY_ROW_FADE_OUT_MS,
  HISTORY_TOAST_DISMISS_MS,
  logSuccessToastMessage,
  retractSuccessToastMessage,
} from '../lib/historyFeedback'
import { listOutcomes } from '../lib/outcomeApi'
import {
  GENERATED_EMAILS_QUERY_KEY,
  OUTCOMES_QUERY_KEY,
} from '../lib/queryKeys'

/**
 * /history — browse past generated emails, see logged outcomes, log any event
 * type, retract mistaken logs.
 *
 * Deliberately does NOT use sessionStorage (contrast with /'s discoveryFlow):
 * GET /generated-emails and GET /outcomes are free, idempotent reads; refetch
 * on mount/refresh is correct. sessionStorage on / exists to avoid re-spending
 * LLM/provider credits — that concern does not apply here.
 */
export function HistoryPage() {
  const { logout } = useAuth()
  const [filter, setFilter] = useState<HistoryFilterValue>('logged')
  /** At most one expanded row; null = all collapsed. Reset on filter change. */
  const [expandedId, setExpandedId] = useState<number | null>(null)
  /**
   * Rows fading out of the active filter after a membership-changing log/retract.
   * Keeps the row mounted through the CSS fade while query invalidation updates
   * underlying data; cleared after HISTORY_ROW_FADE_OUT_MS.
   */
  const [leavingIds, setLeavingIds] = useState<Set<number>>(() => new Set())
  const [toastMessage, setToastMessage] = useState<string | null>(null)
  const toastTimerRef = useRef<number | null>(null)
  const leavingTimersRef = useRef<Map<number, number>>(new Map())

  useEffect(() => {
    return () => {
      if (toastTimerRef.current != null) {
        window.clearTimeout(toastTimerRef.current)
      }
      for (const timerId of leavingTimersRef.current.values()) {
        window.clearTimeout(timerId)
      }
    }
  }, [])

  const emailsQuery = useQuery({
    queryKey: GENERATED_EMAILS_QUERY_KEY,
    queryFn: listGeneratedEmails,
  })

  const outcomesQuery = useQuery({
    queryKey: OUTCOMES_QUERY_KEY,
    queryFn: () => listOutcomes(),
  })

  const outcomesByEmail = useMemo(
    () => groupOutcomesByEmailId(outcomesQuery.data ?? []),
    [outcomesQuery.data],
  )

  function showToast(message: string) {
    setToastMessage(message)
    if (toastTimerRef.current != null) {
      window.clearTimeout(toastTimerRef.current)
    }
    toastTimerRef.current = window.setTimeout(() => {
      setToastMessage(null)
      toastTimerRef.current = null
    }, HISTORY_TOAST_DISMISS_MS)
  }

  function markLeaving(emailId: number) {
    setLeavingIds((prev) => {
      const next = new Set(prev)
      next.add(emailId)
      return next
    })
    const existing = leavingTimersRef.current.get(emailId)
    if (existing != null) {
      window.clearTimeout(existing)
    }
    const timerId = window.setTimeout(() => {
      leavingTimersRef.current.delete(emailId)
      setLeavingIds((prev) => {
        if (!prev.has(emailId)) return prev
        const next = new Set(prev)
        next.delete(emailId)
        return next
      })
    }, HISTORY_ROW_FADE_OUT_MS)
    leavingTimersRef.current.set(emailId, timerId)
  }

  const listFeedback = useMemo<HistoryListFeedback>(
    () => ({
      onLogSuccess: ({ generatedEmailId, eventType, activeCountBefore }) => {
        showToast(logSuccessToastMessage(eventType))
        // Only "Not yet logged" + first outcome changes filter membership.
        if (filter === 'unlogged' && activeCountBefore === 0) {
          markLeaving(generatedEmailId)
        }
      },
      onRetractSuccess: ({
        generatedEmailId,
        eventType,
        willLeaveZeroActive,
      }) => {
        showToast(retractSuccessToastMessage(eventType))
        // Only "Logged" + last-outcome retract changes filter membership.
        if (filter === 'logged' && willLeaveZeroActive) {
          markLeaving(generatedEmailId)
        }
      },
    }),
    [filter],
  )

  const filteredEmails = useMemo(() => {
    const emails = emailsQuery.data ?? []
    return emails.filter((email) => {
      // Keep fading rows mounted until the leaving timer clears them.
      if (leavingIds.has(email.id)) return true
      const count = outcomesByEmail.get(email.id)?.length ?? 0
      if (filter === 'all') return true
      if (filter === 'logged') return count > 0
      return count === 0
    })
  }, [emailsQuery.data, filter, outcomesByEmail, leavingIds])

  function handleFilterChange(value: HistoryFilterValue) {
    setFilter(value)
    setExpandedId(null)
  }

  function handleRowToggle(emailId: number) {
    setExpandedId((current) => (current === emailId ? null : emailId))
  }

  const loading = emailsQuery.isPending || outcomesQuery.isPending
  const loadError =
    emailsQuery.error instanceof ApiError
      ? emailsQuery.error.user_message
      : outcomesQuery.error instanceof ApiError
        ? outcomesQuery.error.user_message
        : emailsQuery.isError || outcomesQuery.isError
          ? 'Something went wrong. Please try again.'
          : null

  return (
    <HistoryListFeedbackProvider value={listFeedback}>
      <main className="home-page discovery-page history-page">
        <AppHeader
          actions={
            <button type="button" onClick={() => void logout()}>
              Log out
            </button>
          }
        />

        <h1 className="history-heading">Outreach history</h1>
        <p className="discovery-lead">
          Past generated emails and their outcome logs. Filter locally — lists
          reload from the server on each visit (no session cache).
        </p>

        <HistoryFilter value={filter} onChange={handleFilterChange} />

        {loading ? (
          <p className="discovery-muted" role="status">
            Loading history…
          </p>
        ) : null}

        {loadError ? (
          <p className="auth-error" role="alert">
            {loadError}
          </p>
        ) : null}

        {!loading && !loadError ? (
          filteredEmails.length === 0 ? (
            <p className="discovery-muted" role="status">
              {filter === 'logged'
                ? 'No emails with logged outcomes yet.'
                : filter === 'unlogged'
                  ? 'Every email already has at least one outcome.'
                  : 'No generated emails yet.'}
            </p>
          ) : (
            <ul className="history-email-list">
              {filteredEmails.map((email) => (
                <li key={email.id}>
                  <HistoryEmailRow
                    email={email}
                    outcomes={outcomesByEmail.get(email.id) ?? []}
                    expanded={expandedId === email.id}
                    leaving={leavingIds.has(email.id)}
                    onToggle={() => handleRowToggle(email.id)}
                  />
                </li>
              ))}
            </ul>
          )
        ) : null}

        <HistoryToast message={toastMessage} />
      </main>
    </HistoryListFeedbackProvider>
  )
}
