import { useCallback, useEffect, useRef, useState } from 'react'
import { listen } from '@tauri-apps/api/event'
import {
  Check,
  Copy,
  FolderPlus,
  Link2,
  Pause,
  Play,
  QrCode,
  Radio,
  RefreshCw,
  ShieldCheck,
  Smartphone,
  Trash2,
  Wifi,
  X,
} from 'lucide-react'
import QRCode from 'qrcode'
import {
  approveLanPairing,
  cancelLanPairing,
  createLanPairing,
  getPairingInfo,
  getRemoteStatus,
  importCodexProjects,
  reconnectRemote,
  removeRemoteWorkspace,
  rejectLanPairing,
  saveRemoteSettings,
  setRemotePaused,
  updateAllRemoteWorkspacePermissions,
  updateRemoteWorkspacePermissions,
} from './api'
import type {
  LanPairingInvitation,
  PairingInfo,
  RemoteControlSnapshot,
  WorkspacePermissionPatch,
} from './types'
import { RemoteLiveMonitor } from './RemoteLiveMonitor'
import { RelayPairingPanel } from './RelayPairingPanel'
import { useLanguage, type AppLanguage } from '../../lib/i18n'
import {
  summarizeWorkspacePermissions,
  type WorkspacePermissionSelection,
} from './workspacePermissions'
import './RemoteControl.css'

function formatTime(value: number | undefined, language: AppLanguage) {
  return value
    ? new Date(value).toLocaleString(language, { hour12: false })
    : language === 'en-US' ? 'No record' : '尚无记录'
}

function formatRemaining(expiresAt: number | undefined, language: AppLanguage) {
  if (!expiresAt) return language === 'en-US' ? 'Not created' : '尚未创建'
  const seconds = Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000))
  if (seconds <= 0) return language === 'en-US' ? 'Expired' : '已失效'
  return language === 'en-US' ? `Expires in ${seconds} seconds` : `${seconds} 秒后失效`
}

type BulkPermissionCheckboxProps = {
  label: string
  selection: WorkspacePermissionSelection
  disabled: boolean
  onChange: (checked: boolean) => void
}

function BulkPermissionCheckbox({
  label,
  selection,
  disabled,
  onChange,
}: BulkPermissionCheckboxProps) {
  return (
    <label>
      <input
        ref={(input) => {
          if (input) input.indeterminate = selection.indeterminate
        }}
        type="checkbox"
        checked={selection.checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      {label}
    </label>
  )
}

export function RemoteControlPage() {
  const { language, t } = useLanguage()
  const [snapshot, setSnapshot] = useState<RemoteControlSnapshot>()
  const [pairing, setPairing] = useState<PairingInfo>()
  const [lanInvitation, setLanInvitation] = useState<LanPairingInvitation>()
  const [lanQrCode, setLanQrCode] = useState('')
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const refreshInFlight = useRef(false)

  const refresh = useCallback(async () => {
    if (refreshInFlight.current) return
    refreshInFlight.current = true
    try {
      setSnapshot(await getRemoteStatus())
      setError('')
    } catch (reason) {
      setError(t(String(reason)))
    } finally {
      refreshInFlight.current = false
    }
  }, [t])

  useEffect(() => {
    let disposed = false
    let removeStatusListener: (() => void) | undefined
    void refresh()
    void listen('remote-control-status', () => {
      if (!disposed) void refresh()
    }).then((cleanup) => {
      if (disposed) cleanup()
      else removeStatusListener = cleanup
    }).catch(() => undefined)

    const refreshWhenVisible = () => {
      if (document.visibilityState === 'visible') void refresh()
    }
    document.addEventListener('visibilitychange', refreshWhenVisible)
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refresh()
    }, 30_000)
    return () => {
      disposed = true
      removeStatusListener?.()
      document.removeEventListener('visibilitychange', refreshWhenVisible)
      window.clearInterval(timer)
    }
  }, [refresh])

  useEffect(() => {
    const pairingUrl = lanInvitation?.pairingUrls[0]
    if (!pairingUrl) {
      setLanQrCode('')
      return
    }
    let cancelled = false
    void QRCode.toDataURL(pairingUrl, {
      errorCorrectionLevel: 'M',
      margin: 1,
      width: 224,
      color: { dark: '#18202b', light: '#ffffff' },
    }).then((value) => {
      if (!cancelled) setLanQrCode(value)
    })
    return () => {
      cancelled = true
    }
  }, [lanInvitation])

  async function run<T>(name: string, operation: () => Promise<T>, apply?: (value: T) => void) {
    setBusy(name)
    setError('')
    setNotice('')
    try {
      const value = await operation()
      apply?.(value)
    } catch (reason) {
      setError(t(String(reason)))
    } finally {
      setBusy('')
    }
  }

  if (!snapshot) {
    return <div className="remote-loading">{t('正在读取手机远控状态...')}</div>
  }

  const settings = snapshot.settings
  const lanPairing = snapshot.lanPairing
  const authLabel = snapshot.authType === 'chatgpt'
    ? t('ChatGPT 官方账号')
    : snapshot.authType === 'apiKey'
      ? t('本机 API Key')
      : t('尚未检测')
  const connectionText = {
    disabled: t('已关闭'),
    connecting: t('连接中'),
    connected: t('已连接'),
    disconnected: t('未连接'),
  }
  const allPermissionSelection = summarizeWorkspacePermissions(
    snapshot.workspaces,
    ['allowWrite', 'allowCommands', 'allowUploads'],
  )
  const writePermissionSelection = summarizeWorkspacePermissions(snapshot.workspaces, ['allowWrite'])
  const commandPermissionSelection = summarizeWorkspacePermissions(snapshot.workspaces, ['allowCommands'])
  const uploadPermissionSelection = summarizeWorkspacePermissions(snapshot.workspaces, ['allowUploads'])
  const permissionBusy = busy === 'permissions-all' || busy.startsWith('permission-')
  const bulkPermissionDisabled = snapshot.workspaces.length === 0 || permissionBusy
  const relayConfigured = Boolean(settings.relayUrl.trim() && settings.publicWebUrl.trim())

  function applyBulkPermissions(
    permissions: WorkspacePermissionPatch,
    checked: boolean,
    label: string,
  ) {
    void run(
      'permissions-all',
      () => updateAllRemoteWorkspacePermissions(permissions),
      (items) => {
        setSnapshot((current) => current ? { ...current, workspaces: items } : current)
        setNotice(language === 'en-US'
          ? `${checked ? 'Enabled' : 'Disabled'} ${label} for ${items.length} workspaces.`
          : `已为 ${items.length} 个工作区${checked ? '开启' : '关闭'}${label}。`)
      },
    )
  }

  return (
    <div className="remote-page">
      <section className="remote-command-bar">
        <div>
          <h1>{t('手机远控')}</h1>
          <p>{t('网站仅中继端到端加密消息，Codex 认证和任务执行始终留在这台电脑。')}</p>
        </div>
        <div className="remote-actions">
          <button className="remote-danger" type="button" onClick={() => void run('pause', () => setRemotePaused(!settings.paused), setSnapshot)}>
            {settings.paused ? <Play size={16} /> : <Pause size={16} />}
            {settings.paused ? t('恢复远控') : t('立即暂停所有远控')}
          </button>
          <button type="button" title={t('重新连接')} onClick={() => void run('reconnect', reconnectRemote, setSnapshot)} disabled={busy === 'reconnect'}>
            <RefreshCw className={busy === 'reconnect' ? 'spin' : ''} size={16} />{t('重新连接')}
          </button>
        </div>
      </section>

      {error && <div className="remote-error">{error}</div>}
      {notice && <div className="remote-notice">{notice}</div>}

      <section className="remote-status-grid">
        <div><span>{t('远控总开关')}</span><strong>{settings.enabled ? settings.paused ? t('已暂停') : t('已开启') : t('已关闭')}</strong></div>
        <div><span>{t('中继连接')}</span><strong className={`remote-${snapshot.connection}`}>{relayConfigured ? connectionText[snapshot.connection] : t('未配置')}</strong></div>
        <div><span>{t('本机认证')}</span><strong>{authLabel}</strong></div>
        <div><span>app-server</span><strong>{snapshot.codexVersion || t('连接后检测')}</strong></div>
        <div><span>{t('授权工作区')}</span><strong>{snapshot.workspaces.length}</strong></div>
        <div><span>{t('活跃远程会话')}</span><strong>{snapshot.activeSessions}</strong></div>
        <div><span>{t('最近连接')}</span><strong>{formatTime(snapshot.lastConnectedAt, language)}</strong></div>
        <div><span>{t('最近手机活动')}</span><strong>{formatTime(snapshot.lastMobileAt, language)}</strong></div>
      </section>

      <RemoteLiveMonitor />

      <RelayPairingPanel
        snapshot={snapshot}
        onSnapshot={setSnapshot}
        onError={setError}
        onNotice={setNotice}
      />

      <div className="remote-layout">
        <section className="remote-panel remote-settings">
          <header><Link2 size={17} /><h2>{t('自建中继与设备')}</h2><span className="remote-panel-meta">{t('用户自定义')}</span></header>
          <div className="remote-panel-body remote-form">
            <label className="remote-toggle"><input type="checkbox" checked={settings.enabled} onChange={(event) => setSnapshot({ ...snapshot, settings: { ...settings, enabled: event.target.checked } })} /><span>{t('开启手机远控')}</span></label>
            <p className="remote-note">{t('本软件不提供默认公网中继，请填写你自己部署的 Relay 服务。')}</p>
            <label><span>{t('中继 WebSocket')}</span><input autoComplete="off" spellCheck={false} placeholder="wss://relay.example.com/ws" value={settings.relayUrl} onChange={(event) => setSnapshot({ ...snapshot, settings: { ...settings, relayUrl: event.target.value } })} /></label>
            <label><span>{t('手机网站地址')}</span><input autoComplete="off" spellCheck={false} placeholder="https://relay.example.com" value={settings.publicWebUrl} onChange={(event) => setSnapshot({ ...snapshot, settings: { ...settings, publicWebUrl: event.target.value } })} /></label>
            <label><span>{t('设备名称')}</span><input value={settings.deviceName} onChange={(event) => setSnapshot({ ...snapshot, settings: { ...settings, deviceName: event.target.value } })} /></label>
            <div className="remote-two-columns">
              <label><span>{t('心跳（秒）')}</span><input type="number" min={10} max={120} value={settings.heartbeatSeconds} onChange={(event) => setSnapshot({ ...snapshot, settings: { ...settings, heartbeatSeconds: Number(event.target.value) } })} /></label>
              <label className="remote-toggle"><input type="checkbox" checked={settings.autoReconnect} onChange={(event) => setSnapshot({ ...snapshot, settings: { ...settings, autoReconnect: event.target.checked } })} /><span>{t('自动重连')}</span></label>
            </div>
            <div className="remote-lan-settings">
              <div className="remote-lan-settings-head">
                <div>
                  <strong><Wifi size={15} />{t('局域网配对')}</strong>
                  <span>{t('仅开放一次性设备绑定，不开放 Codex、8787 或 app-server。')}</span>
                </div>
                <label className="remote-toggle">
                  <input
                    type="checkbox"
                    checked={settings.lanPairingEnabled}
                    onChange={(event) => setSnapshot({
                      ...snapshot,
                      settings: { ...settings, lanPairingEnabled: event.target.checked },
                    })}
                  />
                  <span>{t('允许同网设备请求')}</span>
                </label>
              </div>
              <div className="remote-two-columns">
                <label>
                  <span>{t('局域网配对端口')}</span>
                  <input
                    type="number"
                    min={1024}
                    max={65535}
                    value={settings.lanPairingPort}
                    onChange={(event) => setSnapshot({
                      ...snapshot,
                      settings: { ...settings, lanPairingPort: Number(event.target.value) },
                    })}
                  />
                </label>
                <label className="remote-toggle">
                  <input
                    type="checkbox"
                    checked={settings.lanAllowTailscale}
                    onChange={(event) => setSnapshot({
                      ...snapshot,
                      settings: { ...settings, lanAllowTailscale: event.target.checked },
                    })}
                  />
                  <span>{t('允许 Tailscale 网段')}</span>
                </label>
              </div>
              <div className="remote-lan-runtime">
                <span className={`remote-lan-state ${lanPairing.status}`}>
                  <Radio size={12} />
                  {lanPairing.status === 'listening'
                    ? t('正在监听')
                    : lanPairing.status === 'error'
                      ? t('启动失败')
                      : t('未启用')}
                </span>
                <span>{lanPairing.urls.find((url) => !url.includes('127.0.0.1')) || lanPairing.urls[0] || t('保存并开启后显示局域网地址')}</span>
              </div>
              {lanPairing.lastError && <p className="remote-inline-error">{t(lanPairing.lastError)}</p>}
            </div>
            <label><span>{t('设备 ID')}</span><input readOnly value={settings.desktopDeviceId} /></label>
            <div className="remote-form-actions">
              <button type="button" onClick={() => void run('save', () => saveRemoteSettings(settings), setSnapshot)} disabled={busy === 'save'}><ShieldCheck size={16} />{t('保存并应用')}</button>
              <button type="button" onClick={() => void run('lan-pair', createLanPairing, setLanInvitation)} disabled={lanPairing.status !== 'listening' || busy === 'lan-pair'}><QrCode size={16} />{t('创建局域网邀请')}</button>
              <button type="button" onClick={() => void run('pair', getPairingInfo, setPairing)} disabled={!settings.enabled || !relayConfigured}><Smartphone size={16} />{t('生成公网快速链接')}</button>
            </div>
            {snapshot.lastError && <p className="remote-inline-error">{t(snapshot.lastError)}</p>}
          </div>
        </section>

        <section className="remote-panel">
          <header><FolderPlus size={17} /><h2>{t('工作区白名单')}</h2></header>
          <div className="remote-panel-body remote-form">
            <div className="remote-workspace-toolbar">
              <p className="remote-note">{t('手机不能输入任意路径。通过 Codex 左侧项目同步工作区，新增项目默认禁止修改、命令和上传。')}</p>
              <button
                type="button"
                disabled={busy === 'sync-projects'}
                onClick={() => void run(
                  'sync-projects',
                  importCodexProjects,
                  (result) => {
                    setSnapshot({ ...snapshot, workspaces: result.workspaces })
                    setNotice(language === 'en-US'
                      ? result.imported > 0
                        ? `Synced ${result.imported} Codex projects; ${result.skipped} already existed or were unavailable.`
                        : `All ${result.discovered} projects from the Codex sidebar are already synced.`
                      : result.imported > 0
                        ? `已同步 ${result.imported} 个 Codex 项目，${result.skipped} 个已存在或不可用。`
                        : `Codex 左侧的 ${result.discovered} 个项目均已同步。`)
                  },
                )}
              >
                <RefreshCw className={busy === 'sync-projects' ? 'spin' : ''} size={16} />
                {t('一键同步 Codex 项目')}
              </button>
            </div>
            <div className="remote-workspace-bulk" aria-label={t('批量工作区权限')}>
              <strong>{t('一键勾选')}</strong>
              <div>
                <BulkPermissionCheckbox
                  label={t('全部权限')}
                  selection={allPermissionSelection}
                  disabled={bulkPermissionDisabled}
                  onChange={(checked) => applyBulkPermissions({
                    allowWrite: checked,
                    allowCommands: checked,
                    allowUploads: checked,
                  }, checked, language === 'en-US' ? 'all permissions' : '全部权限')}
                />
                <BulkPermissionCheckbox
                  label={t('修改文件')}
                  selection={writePermissionSelection}
                  disabled={bulkPermissionDisabled}
                  onChange={(checked) => applyBulkPermissions(
                    { allowWrite: checked },
                    checked,
                    language === 'en-US' ? 'file modification' : '修改文件权限',
                  )}
                />
                <BulkPermissionCheckbox
                  label={t('运行命令')}
                  selection={commandPermissionSelection}
                  disabled={bulkPermissionDisabled}
                  onChange={(checked) => applyBulkPermissions(
                    { allowCommands: checked },
                    checked,
                    language === 'en-US' ? 'command execution' : '运行命令权限',
                  )}
                />
                <BulkPermissionCheckbox
                  label={t('手机上传')}
                  selection={uploadPermissionSelection}
                  disabled={bulkPermissionDisabled}
                  onChange={(checked) => applyBulkPermissions(
                    { allowUploads: checked },
                    checked,
                    language === 'en-US' ? 'mobile uploads' : '手机上传权限',
                  )}
                />
              </div>
            </div>
            <div className="remote-workspaces">
              {snapshot.workspaces.length === 0 && <div className="remote-empty">{t('尚未授权任何工作区')}</div>}
              {snapshot.workspaces.map((item) => (
                <article key={item.id}>
                  <div>
                    <strong>{item.name}</strong>
                    <span>{item.path}</span>
                    <div className="remote-workspace-permissions">
                      <label><input type="checkbox" checked={item.allowWrite} disabled={permissionBusy} onChange={(event) => void run(`permission-${item.id}`, () => updateRemoteWorkspacePermissions({ ...item, allowWrite: event.target.checked }), (items) => setSnapshot({ ...snapshot, workspaces: items }))} />{t('修改文件')}</label>
                      <label><input type="checkbox" checked={item.allowCommands} disabled={permissionBusy} onChange={(event) => void run(`permission-${item.id}`, () => updateRemoteWorkspacePermissions({ ...item, allowCommands: event.target.checked }), (items) => setSnapshot({ ...snapshot, workspaces: items }))} />{t('运行命令')}</label>
                      <label><input type="checkbox" checked={item.allowUploads} disabled={permissionBusy} onChange={(event) => void run(`permission-${item.id}`, () => updateRemoteWorkspacePermissions({ ...item, allowUploads: event.target.checked }), (items) => setSnapshot({ ...snapshot, workspaces: items }))} />{t('手机上传')}</label>
                    </div>
                  </div>
                  <button type="button" title={t('撤销工作区')} onClick={() => void run(`remove-${item.id}`, () => removeRemoteWorkspace(item.id), (items) => setSnapshot({ ...snapshot, workspaces: items }))}><Trash2 size={15} /></button>
                </article>
              ))}
            </div>
          </div>
        </section>
      </div>

      {(lanInvitation || lanPairing.pendingRequests.length > 0 || lanPairing.status === 'listening') && (
        <section className="remote-panel remote-lan-pairing-panel">
          <header><Wifi size={17} /><h2>{t('局域网设备配对')}</h2><span className="remote-panel-meta">{t('电脑端最终确认')}</span></header>
          <div className="remote-panel-body remote-lan-pairing-layout">
            <div className="remote-lan-invitation">
              <div className="remote-lan-section-head">
                <div>
                  <strong>{t('电脑邀请手机')}</strong>
                  <span>{t('扫描二维码，或在局域网页中输入六位码。')}</span>
                </div>
                {lanInvitation && (
                  <button
                    type="button"
                    title={t('取消当前邀请')}
                    onClick={() => void run('cancel-lan-pair', cancelLanPairing, (value) => {
                      setSnapshot(value)
                      setLanInvitation(undefined)
                    })}
                  >
                    <X size={15} />
                  </button>
                )}
              </div>
              {lanInvitation ? (
                <div className="remote-lan-invitation-body">
                  <div className="remote-lan-qr">
                    {lanQrCode ? <img src={lanQrCode} alt={t('局域网配对二维码')} /> : <span>{t('正在生成二维码')}</span>}
                  </div>
                  <div className="remote-lan-code">
                    <span>{t('一次性配对码')}</span>
                    <strong>{lanInvitation.code}</strong>
                    <em>{formatRemaining(lanInvitation.expiresAt, language)}</em>
                    <button type="button" onClick={() => void navigator.clipboard.writeText(lanInvitation.pairingUrls[0])}>
                      <Copy size={15} />{t('复制邀请链接')}
                    </button>
                  </div>
                </div>
              ) : (
                <div className="remote-lan-empty-action">
                  <span>{t('尚未创建电脑邀请。手机也可以直接打开下方局域网地址发起请求。')}</span>
                  <button type="button" onClick={() => void run('lan-pair', createLanPairing, setLanInvitation)}>
                    <QrCode size={15} />{t('创建两分钟邀请')}
                  </button>
                </div>
              )}
              <div className="remote-lan-urls">
                <strong>{t('手机主动请求地址')}</strong>
                {lanPairing.urls.map((url) => (
                  <div key={url}>
                    <span>{url}</span>
                    <button type="button" title={t('复制地址')} onClick={() => void navigator.clipboard.writeText(url)}>
                      <Copy size={14} />
                    </button>
                  </div>
                ))}
              </div>
            </div>

            <div className="remote-lan-requests">
              <div className="remote-lan-section-head">
                <div>
                  <strong>{t('等待电脑确认')}</strong>
                  <span>{t('手机和电脑显示的校验码必须完全一致。')}</span>
                </div>
                <b>{lanPairing.pendingRequests.length}</b>
              </div>
              {lanPairing.pendingRequests.length === 0 ? (
                <div className="remote-empty">{t('尚无手机配对请求')}</div>
              ) : lanPairing.pendingRequests.map((request) => (
                <article key={request.requestId}>
                  <div className="remote-lan-request-main">
                    <div>
                      <strong>{request.deviceName}</strong>
                      <span>{request.platform} · {request.remoteAddress}</span>
                      <small title={request.browser}>{request.mode === 'direct' ? t('手机主动请求') : t('电脑邀请')} · {formatTime(request.requestedAt, language)}</small>
                    </div>
                    <div className="remote-lan-verification">
                      <span>{t('双端校验码')}</span>
                      <strong>{request.verificationCode}</strong>
                      <em>{formatRemaining(request.expiresAt, language)}</em>
                    </div>
                  </div>
                  <div className="remote-lan-request-actions">
                    <button type="button" className="remote-reject" onClick={() => void run(`reject-${request.requestId}`, () => rejectLanPairing(request.requestId), setSnapshot)}>
                      <X size={15} />{t('拒绝')}
                    </button>
                    <button type="button" className="remote-approve" onClick={() => void run(`approve-${request.requestId}`, () => approveLanPairing(request.requestId), setSnapshot)}>
                      <Check size={15} />{t('确认并允许')}
                    </button>
                  </div>
                </article>
              ))}
            </div>
          </div>
        </section>
      )}

      {pairing && (
        <section className="remote-pairing">
          <div>
            <h2>{t('公网快速链接')}</h2>
            <p>{t('用于已部署的 HTTPS 网站。长期凭据只存在 URL 片段中，不会随 HTTP 请求发送给中继服务器。')}</p>
          </div>
          <input readOnly value={pairing.pairingUrl} />
          <button type="button" onClick={() => void navigator.clipboard.writeText(pairing.pairingUrl)}><Copy size={16} />{t('复制配对链接')}</button>
        </section>
      )}
    </div>
  )
}
