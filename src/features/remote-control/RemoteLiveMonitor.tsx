import { useEffect, useRef, useState } from 'react'
import { listen } from '@tauri-apps/api/event'
import { Activity, FileCode2, MessageSquare, Smartphone, TerminalSquare } from 'lucide-react'
import { getRemoteMonitorSnapshot } from './api'
import type { RemoteMonitorActivity, RemoteMonitorSnapshot } from './types'
import { useLanguage, type AppLanguage } from '../../lib/i18n'

const statusLabelSources: Record<string, string> = {
  ready: '已连接',
  waiting: '等待响应',
  running: '执行中',
  completed: '已完成',
  stopped: '已停止',
  failed: '失败',
  disconnected: '已断开',
}

function activityIcon(activity: RemoteMonitorActivity) {
  if (activity.kind === 'command') return <TerminalSquare size={14} />
  if (activity.kind === 'file') return <FileCode2 size={14} />
  return <Activity size={14} />
}

function formatMonitorTime(value: number, language: AppLanguage) {
  return new Date(value).toLocaleTimeString(language, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  })
}

export function RemoteLiveMonitor() {
  const { language, t } = useLanguage()
  const [snapshot, setSnapshot] = useState<RemoteMonitorSnapshot>({ sequence: 0, sessions: [] })
  const [selectedId, setSelectedId] = useState('')
  const transcriptRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let disposed = false
    let removeListener: (() => void) | undefined

    void Promise.all([
      getRemoteMonitorSnapshot(),
      listen<RemoteMonitorSnapshot>('remote-control-monitor', (event) => {
        if (!disposed) setSnapshot(event.payload)
      }),
    ]).then(([initial, unlisten]) => {
      if (disposed) {
        unlisten()
        return
      }
      setSnapshot(initial)
      removeListener = unlisten
    })

    return () => {
      disposed = true
      removeListener?.()
    }
  }, [])

  useEffect(() => {
    if (snapshot.sessions.length === 0) {
      setSelectedId('')
      return
    }
    if (!snapshot.sessions.some((session) => session.sessionId === selectedId)) {
      setSelectedId(snapshot.sessions[0].sessionId)
    }
  }, [selectedId, snapshot.sessions])

  const selected = snapshot.sessions.find((session) => session.sessionId === selectedId)
  const statusLabel = (status: string) => t(statusLabelSources[status] || status)
  const sessionTitle = (title: string) => title && title !== '远程会话' ? title : t('远程会话')

  useEffect(() => {
    const transcript = transcriptRef.current
    if (transcript) transcript.scrollTop = transcript.scrollHeight
  }, [selected?.messages])

  return (
    <section className="remote-panel remote-monitor">
      <header>
        <Activity size={17} />
        <h2>{t('远程会话实时监控')}</h2>
        <span className="remote-monitor-count">
          {language === 'en-US'
            ? `${snapshot.sessions.length} recent sessions`
            : `${snapshot.sessions.length} 个最近会话`}
        </span>
      </header>
      {snapshot.sessions.length === 0 ? (
        <div className="remote-monitor-empty">
          <Smartphone size={28} />
          <strong>{t('等待手机发起任务')}</strong>
          <span>{t('手机输入、Codex 流式回复、命令和文件事件会实时显示在这里。')}</span>
        </div>
      ) : (
        <div className="remote-monitor-layout">
          <nav className="remote-monitor-sessions" aria-label={t('远程会话')}>
            {snapshot.sessions.map((session) => (
              <button
                className={session.sessionId === selectedId ? 'active' : ''}
                key={session.sessionId}
                onClick={() => setSelectedId(session.sessionId)}
                type="button"
              >
                <span className={`remote-monitor-state state-${session.status}`} aria-hidden="true" />
                <span>
                  <strong>{sessionTitle(session.title)}</strong>
                  <small>{session.workspace} · {formatMonitorTime(session.updatedAt, language)}</small>
                </span>
                <em>{statusLabel(session.status)}</em>
              </button>
            ))}
          </nav>

          {selected ? (
            <div className="remote-monitor-detail">
              <div className="remote-monitor-detail-head">
                <div>
                  <strong>{sessionTitle(selected.title)}</strong>
                  <span>
                    {selected.workspace} · {language === 'en-US' ? 'Mobile' : '手机'}{' '}
                    {selected.remoteDeviceId.slice(0, 8)}
                  </span>
                </div>
                <span className={`remote-monitor-status status-${selected.status}`}>
                  {statusLabel(selected.status)}
                </span>
              </div>

              <div className="remote-monitor-transcript" ref={transcriptRef}>
                {selected.messages.length === 0 ? (
                  <div className="remote-monitor-placeholder">
                    <MessageSquare size={20} />
                    {t('会话已连接，等待消息内容。')}
                  </div>
                ) : selected.messages.map((message) => (
                  <article className={`remote-monitor-message ${message.role}`} key={message.id}>
                    <header>
                      <strong>{message.role === 'user' ? t('手机') : message.role === 'assistant' ? 'Codex' : t('工具')}</strong>
                      <time>{formatMonitorTime(message.timestamp, language)}</time>
                    </header>
                    <pre>{message.text}</pre>
                  </article>
                ))}
              </div>

              <div className="remote-monitor-activities">
                {selected.activities.slice(-6).map((activity) => (
                  <div key={activity.id}>
                    {activityIcon(activity)}
                    <span>{t(activity.summary)}</span>
                    <time>{formatMonitorTime(activity.timestamp, language)}</time>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      )}
    </section>
  )
}
