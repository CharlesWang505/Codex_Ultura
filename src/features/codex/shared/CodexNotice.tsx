import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
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
  const [viewport, setViewport] = useState<HTMLElement | null>(null)

  useEffect(() => {
    onDismissRef.current = onDismiss
  }, [onDismiss])

  useEffect(() => {
    let element = document.getElementById('codex-notice-viewport')
    if (!element) {
      element = document.createElement('div')
      element.id = 'codex-notice-viewport'
      element.className = 'codex-notice-viewport'
      element.setAttribute('aria-live', 'polite')
      document.body.appendChild(element)
    }
    setViewport(element)
  }, [])

  useEffect(() => {
    const timer = window.setTimeout(() => onDismissRef.current(), AUTO_DISMISS_MS[tone])
    return () => window.clearTimeout(timer)
  }, [text, tone])

  const notice = (
    <div className={`codex-notice ${tone}`} role={tone === 'error' ? 'alert' : 'status'}>
      <span>{text}</span>
      <button type="button" aria-label="关闭通知" onClick={onDismiss}>×</button>
    </div>
  )
  return viewport ? createPortal(notice, viewport) : null
}
