type Props = {
  message: string | null
}

/**
 * Single global snackbar for /history log + retract confirmations.
 * One message at a time — parent replaces `message` rather than queueing.
 * Auto-dismiss is owned by the parent (timer), not this presentational shell.
 */
export function HistoryToast({ message }: Props) {
  if (!message) return null
  return (
    <div className="history-toast" role="status" aria-live="polite">
      {message}
    </div>
  )
}
