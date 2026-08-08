import { createContext, useContext } from 'react'

import type { OutcomeEventType } from '../lib/outcomeTypes'

/**
 * Page-scoped callbacks for /history log + retract success side effects
 * (toast + optional fade-and-remove). Provided by HistoryPage so mutations
 * in nested forms can report success without prop-drilling through the
 * accordion tree.
 */
export type HistoryListFeedback = {
  /**
   * Successful log. Parent shows a toast; may mark the row as leaving when
   * the active filter is "Not yet logged" and this was the first outcome.
   */
  onLogSuccess: (args: {
    generatedEmailId: number
    eventType: OutcomeEventType
    /** Non-voided outcome count for this email immediately before the log. */
    activeCountBefore: number
  }) => void
  /**
   * Successful retract. Parent shows a toast; may mark the row as leaving
   * when the active filter is "Logged" and this retract leaves zero actives.
   */
  onRetractSuccess: (args: {
    generatedEmailId: number
    eventType: OutcomeEventType
    /** True when this retract (including SENT cascade) leaves zero actives. */
    willLeaveZeroActive: boolean
  }) => void
}

const HistoryListFeedbackContext = createContext<HistoryListFeedback | null>(
  null,
)

export const HistoryListFeedbackProvider = HistoryListFeedbackContext.Provider

export function useHistoryListFeedback(): HistoryListFeedback {
  const ctx = useContext(HistoryListFeedbackContext)
  if (!ctx) {
    throw new Error(
      'useHistoryListFeedback must be used under HistoryPage feedback provider',
    )
  }
  return ctx
}
