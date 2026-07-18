import { useState } from 'react'
import {
  Clock3,
  KeyRound,
  MonitorSmartphone,
  RefreshCw,
  Send,
  ShieldCheck,
  Smartphone,
  X,
} from 'lucide-react'
import {
  getRemoteStatus,
  inviteRelayMobile,
  refreshRelayMobiles,
  rejectRelayPairing,
} from './api'
import type { RemoteControlSnapshot } from './types'
import { useLanguage } from '../../lib/i18n'

type RelayPairingPanelProps = {
  snapshot: RemoteControlSnapshot
  onSnapshot: (snapshot: RemoteControlSnapshot) => void
  onError: (message: string) => void
  onNotice: (message: string) => void
}

function formatTime(value: number | undefined, language: 'zh-CN' | 'en-US') {
  return value
    ? new Date(value).toLocaleString(language, { hour12: false })
    : language === 'en-US' ? 'No record' : '尚无记录'
}

function formatRemaining(expiresAt: number | undefined, language: 'zh-CN' | 'en-US') {
  if (!expiresAt) return language === 'en-US' ? 'Not created' : '尚未创建'
  const seconds = Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000))
  if (seconds <= 0) return language === 'en-US' ? 'Expired' : '已失效'
  return language === 'en-US' ? `Expires in ${seconds} seconds` : `${seconds} 秒后失效`
}

export function RelayPairingPanel({
  snapshot,
  onSnapshot,
  onError,
  onNotice,
}: RelayPairingPanelProps) {
  const { language, t } = useLanguage()
  const [busy, setBusy] = useState('')
  const relayPairing = snapshot.relayPairing
  const pendingDeviceIds = new Set(
    relayPairing.pendingRequests.map((request) => request.remoteDeviceId),
  )
  const canDiscover = snapshot.settings.enabled
    && !snapshot.settings.paused
    && snapshot.connection === 'connected'

  async function run(name: string, operation: () => Promise<void>) {
    setBusy(name)
    onError('')
    try {
      await operation()
    } catch (reason) {
      onError(t(String(reason)))
    } finally {
      setBusy('')
    }
  }

  function refresh() {
    void run('refresh', async () => {
      onSnapshot(await refreshRelayMobiles())
    })
  }

  function invite(deviceId: string, deviceName: string) {
    void run(`invite-${deviceId}`, async () => {
      const invitation = await inviteRelayMobile(deviceId)
      onSnapshot(await getRemoteStatus())
      onNotice(language === 'en-US'
        ? `Pairing invitation sent to ${deviceName}. Enter desktop pairing code ${invitation.code} on the mobile.`
        : `已向 ${deviceName} 发出配对邀请，请让手机输入电脑端显示的配对码 ${invitation.code}。`)
    })
  }

  function reject(pairingId: string) {
    void run(`reject-${pairingId}`, async () => {
      onSnapshot(await rejectRelayPairing(pairingId))
      onNotice(t('已取消这次公网设备配对。'))
    })
  }

  return (
    <section className="remote-panel remote-relay-pairing-panel">
      <header>
        <MonitorSmartphone size={17} />
        <h2>{t('公网在线设备配对')}</h2>
        <span className={`remote-relay-presence ${canDiscover ? 'online' : ''}`}>
          <span />
          {canDiscover
            ? language === 'en-US'
              ? `${relayPairing.onlineMobiles.length} mobiles online`
              : `${relayPairing.onlineMobiles.length} 台手机在线`
            : t('中继未就绪')}
        </span>
        <button
          className="remote-header-action"
          type="button"
          title={t('刷新在线手机')}
          disabled={!canDiscover || busy === 'refresh'}
          onClick={refresh}
        >
          <RefreshCw className={busy === 'refresh' ? 'spin' : ''} size={15} />
        </button>
      </header>

      <div className="remote-panel-body remote-relay-pairing-layout">
        <div className="remote-relay-mobiles">
          <div className="remote-relay-section-head">
            <div>
              <strong>{t('已打开网站的手机')}</strong>
              <span>{t('手机访问你的中继网站后会自动出现在这里。')}</span>
            </div>
            <b>{relayPairing.onlineMobiles.length}</b>
          </div>
          {!canDiscover ? (
            <div className="remote-empty">{t('请先开启手机远控并连接自建中继服务器')}</div>
          ) : relayPairing.onlineMobiles.length === 0 ? (
            <div className="remote-empty">{t('尚未发现打开网站的手机')}</div>
          ) : relayPairing.onlineMobiles.map((mobile) => {
            const pending = pendingDeviceIds.has(mobile.deviceId)
            const inviting = busy === `invite-${mobile.deviceId}`
            return (
              <article key={mobile.deviceId} className="remote-relay-mobile-row">
                <div className="remote-relay-mobile-icon"><Smartphone size={18} /></div>
                <div className="remote-relay-mobile-copy">
                  <strong>{mobile.deviceName}</strong>
                  <span>{mobile.platform} · {mobile.browser}</span>
                  <small>
                    <Clock3 size={11} />
                    {language === 'en-US'
                      ? `Last seen ${formatTime(mobile.lastSeenAt, language)}`
                      : `最近在线 ${formatTime(mobile.lastSeenAt, language)}`}
                  </small>
                </div>
                <button
                  type="button"
                  disabled={pending || inviting}
                  onClick={() => invite(mobile.deviceId, mobile.deviceName)}
                >
                  {pending ? <ShieldCheck size={15} /> : <Send size={15} />}
                  {pending ? t('等待输入配对码') : t('邀请配对')}
                </button>
              </article>
            )
          })}
        </div>

        <div className="remote-relay-requests">
          <div className="remote-relay-section-head">
            <div>
              <strong>{t('待完成的公网配对')}</strong>
              <span>{t('配对码只显示在电脑端，手机输入正确后才会取得加密连接凭据。')}</span>
            </div>
            <b>{relayPairing.pendingRequests.length}</b>
          </div>
          {relayPairing.pendingRequests.length === 0 ? (
            <div className="remote-empty">{t('尚无公网配对请求')}</div>
          ) : relayPairing.pendingRequests.map((request) => (
            <article key={request.pairingId} className="remote-relay-request-row">
              <div className="remote-relay-request-main">
                <div>
                  <strong>{request.deviceName}</strong>
                  <span>{request.platform} · {request.browser}</span>
                  <small>
                    {request.mode === 'mobile_request' ? t('手机主动请求') : t('电脑主动邀请')}
                    {' · '}
                    {formatTime(request.requestedAt, language)}
                  </small>
                </div>
                <div className="remote-relay-code">
                  <span><KeyRound size={11} />{t('电脑端配对码')}</span>
                  <strong>{request.code}</strong>
                  <em>{formatRemaining(request.expiresAt, language)}</em>
                </div>
              </div>
              <button
                type="button"
                className="remote-reject"
                title={t('取消配对')}
                disabled={busy === `reject-${request.pairingId}`}
                onClick={() => reject(request.pairingId)}
              >
                <X size={15} />{t('取消')}
              </button>
            </article>
          ))}
          {relayPairing.lastError && (
            <p className="remote-inline-error">{t(relayPairing.lastError)}</p>
          )}
        </div>
      </div>
    </section>
  )
}
