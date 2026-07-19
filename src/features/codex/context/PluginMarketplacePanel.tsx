import { RefreshCw, Wrench } from 'lucide-react'
import type { PluginStatusResult } from '../types'
import { CodexPanel, LoadingButton, StatusPill } from '../shared/CodexPanel'

function MarketplaceStatus({
  title,
  status,
  busy,
  disabled,
  onRepair,
}: {
  title: string
  status: PluginStatusResult | null
  busy: boolean
  disabled: boolean
  onRepair: () => void
}) {
  const healthy = Boolean(status && !status.needsRepair)
  const tone = !status ? 'info' : healthy ? 'ok' : 'warning'
  return (
    <article className="codex-marketplace-status">
      <div className="codex-marketplace-heading">
        <strong>{title}</strong>
        <StatusPill tone={tone}>{status ? status.needsRepair ? '需要修复' : '正常' : '未检测'}</StatusPill>
      </div>
      <dl>
        <div><dt>市场目录</dt><dd title={status?.marketplaceRoot ?? status?.codexHome ?? ''}>{status?.marketplaceRoot ?? status?.codexHome ?? '-'}</dd></div>
        <div><dt>配置注册</dt><dd>{status?.configRegistered ? '已注册' : '未注册'}</dd></div>
        <div><dt>插件 / 技能</dt><dd>{status ? `${status.pluginCount ?? 0} / ${status.skillCount ?? 0}` : '-'}</dd></div>
      </dl>
      <LoadingButton type="button" busy={busy} disabled={disabled} onClick={onRepair}><Wrench size={14} />初始化/修复</LoadingButton>
    </article>
  )
}

export function PluginMarketplacePanel({
  localStatus,
  remoteStatus,
  busy,
  onRefresh,
  onRepair,
}: {
  localStatus: PluginStatusResult | null
  remoteStatus: PluginStatusResult | null
  busy: string
  onRefresh: () => void
  onRepair: (remote: boolean) => void
}) {
  const operationBusy = Boolean(busy)
  return (
    <CodexPanel
      title="插件市场维护"
      icon={<Wrench size={18} />}
      action={<LoadingButton busy={busy === 'plugins'} disabled={operationBusy} onClick={onRefresh}><RefreshCw size={14} />检测</LoadingButton>}
      className="codex-tools-marketplace-panel"
    >
      <div className="codex-plugin-grid">
        <MarketplaceStatus title="本地精选市场" status={localStatus} busy={busy === 'repair_plugin_marketplace'} disabled={operationBusy} onRepair={() => onRepair(false)} />
        <MarketplaceStatus title="官方远端缓存" status={remoteStatus} busy={busy === 'repair_remote_plugin_marketplace'} disabled={operationBusy} onRepair={() => onRepair(true)} />
      </div>
    </CodexPanel>
  )
}
