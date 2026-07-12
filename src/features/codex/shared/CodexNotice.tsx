import { useEffect, useRef } from 'react'
import type { NoticeTone } from './CodexPanel'

const AUTO_DISMISS_MS: Record<NoticeTone, number> = {
  ok: 5_000,
  info: 6_000,
  warning: 8_000,
  error: 12_000,
}

export function CodexNotice({
  tone,
  text,
  onDismiss,
}: {
  tone: NoticeTone
  text: string
  onDismiss: () => void
}) {
  const onDismissRef = useRef(onDismiss)

  useEffect(() => {
    onDismissRef.current = onDismiss
  }, [onDismiss])

  useEffect(() => {
    const timer = window.setTimeout(() => onDismissRef.current(), AUTO_DISMISS_MS[tone])
    return () => window.clearTimeout(timer)
  }, [text, tone])

  return (
    <div className={`codex-notice ${tone}`} role={tone === 'error' ? 'alert' : 'status'}>
      <span>{text}</span>
      <button type="button" aria-label="关闭通知" onClick={onDismiss}>×</button>
    </div>
  )
}
