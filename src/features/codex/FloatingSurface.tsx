import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { getCurrentWindow, PhysicalPosition } from '@tauri-apps/api/window'
import { ExternalLink, Power, Radio, Save, Zap } from 'lucide-react'
import { useTheme } from '../../lib/theme'
import { callCodex } from './api'
import type { BackendSettings, HotSwitchResult, SettingsResult } from './types'
import './FloatingSurface.css'

type Props = { surface: 'floating' | 'floating-panel' }

export function FloatingSurface({ surface }: Props) {
  useTheme()
  if (surface === 'floating') return <FloatingBall />
  return <FloatingPanel />
}

function FloatingBall() {
  const drag = useRef<{ screenX: number; screenY: number; x: number; y: number; moved: boolean } | null>(null)

  const onPointerDown = useCallback(async (event: React.PointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return
    const position = await getCurrentWindow().outerPosition()
    drag.current = { screenX: event.screenX, screenY: event.screenY, x: position.x, y: position.y, moved: false }
    event.currentTarget.setPointerCapture(event.pointerId)
  }, [])

  const onPointerMove = useCallback((event: React.PointerEvent<HTMLButtonElement>) => {
    const current = drag.current
    if (!current) return
    const dx = event.screenX - current.screenX
    const dy = event.screenY - current.screenY
    if (Math.abs(dx) + Math.abs(dy) > 4) current.moved = true
    if (current.moved) void getCurrentWindow().setPosition(new PhysicalPosition(current.x + dx, current.y + dy))
  }, [])

  const onPointerUp = useCallback(async () => {
    const current = drag.current
    drag.current = null
    if (!current?.moved) {
      await invoke('floating_toggle_panel')
      return
    }
    const position = await getCurrentWindow().outerPosition()
    await invoke('floating_save_position', { x: position.x, y: position.y })
  }, [])

  return (
    <button
      className="floating-ball"
      type="button"
      aria-label="打开热切换面板"
      title="单击切换面板，拖动调整位置，右键打开主程序"
      onPointerDown={(event) => void onPointerDown(event)}
      onPointerMove={onPointerMove}
      onPointerUp={() => void onPointerUp()}
      onContextMenu={(event) => { event.preventDefault(); void invoke('floating_show_main') }}
    >
      <Zap size={24} />
      <span />
    </button>
  )
}

function FloatingPanel() {
  const [hot, setHot] = useState<HotSwitchResult | null>(null)
  const [settings, setSettings] = useState<BackendSettings | null>(null)
  const [relayId, setRelayId] = useState('')
  const [model, setModel] = useState('')
  const [reasoning, setReasoning] = useState('auto')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const automaticRouting = Boolean(settings?.hotSwitchModelRoutingEnabled)
  const autoModelEnabled = Boolean(settings?.hotSwitchAutoModelEnabled)
  const selectableModels = useMemo(() => {
    const profile = settings?.relayProfiles.find((candidate) => candidate.id === relayId)
    const configuredModels = profile?.modelList
      .split(/[\r\n,]/)
      .map((value) => value.trim())
      .filter(Boolean) ?? []
    const mappedModels = settings?.hotSwitchModelMappings
      .filter((mapping) => mapping.relayId === relayId)
      .map((mapping) => (mapping.upstreamModel || mapping.model).trim())
      .filter(Boolean) ?? []
    return Array.from(new Set([
      profile?.model?.trim() ?? '',
      ...configuredModels,
      ...mappedModels,
    ].filter(Boolean)))
  }, [relayId, settings?.hotSwitchModelMappings, settings?.relayProfiles])

  const refresh = useCallback(async () => {
    try {
      const result = await callCodex<HotSwitchResult>('hot_switch_status')
      setHot(result)
      setSettings(result.settings)
      setRelayId(result.settings.hotSwitchRelayId || result.settings.relayProfiles[0]?.id || '')
      setModel(result.settings.hotSwitchModel)
      setReasoning(result.settings.defaultReasoning ?? 'auto')
      setMessage(result.message)
    } catch (error) {
      setMessage(String(error))
    }
  }, [])

  useEffect(() => { void refresh() }, [refresh])
  useEffect(() => {
    let disposed = false
    let unlisten: (() => void) | undefined

    void getCurrentWindow().onFocusChanged(({ payload: focused }) => {
      if (focused) void refresh()
    }).then((cleanup) => {
      if (disposed) cleanup()
      else unlisten = cleanup
    })

    return () => {
      disposed = true
      unlisten?.()
    }
  }, [refresh])

  const apply = useCallback(async () => {
    if (!settings) return
    setBusy(true)
    try {
      const next = { ...settings, defaultReasoning: reasoning }
      const saved = await callCodex<SettingsResult>('save_settings', { settings: next })
      setSettings(saved.settings)
      const result = await callCodex<HotSwitchResult>('set_hot_switch', {
        request: { enabled: true, relayId, model },
      })
      setHot(result)
      setSettings(result.settings)
      setMessage(result.message)
    } catch (error) {
      setMessage(String(error))
    } finally {
      setBusy(false)
    }
  }, [model, reasoning, relayId, settings])

  const toggleGateway = useCallback(async () => {
    if (!settings) return
    setBusy(true)
    try {
      const result = await callCodex<HotSwitchResult>('set_hot_switch', {
        request: { enabled: !hot?.enabled, relayId, model },
      })
      setHot(result)
      setSettings(result.settings)
      setMessage(result.message)
    } catch (error) {
      setMessage(String(error))
    } finally {
      setBusy(false)
    }
  }, [hot?.enabled, model, relayId, settings])

  return (
    <main className="floating-panel-shell">
      <header>
        <div><Radio size={16} /><strong>{autoModelEnabled ? 'Codex Compass 自动模型' : 'Codex Compass 热切换'}</strong></div>
        <button type="button" onClick={() => void invoke('floating_hide_panel')}>×</button>
      </header>
      <section className="floating-gateway-state">
        <span className={hot?.running ? 'online' : 'offline'} />
        <div><strong>{hot?.running ? '8787 网关运行中' : '8787 网关已关闭'}</strong><small>{hot?.baseUrl ?? 'http://127.0.0.1:8787/v1'}</small></div>
      </section>
      {autoModelEnabled ? (
        <div className="floating-routing-hint">在 Codex 中选择“Codex Compass 自动模型”后，这里的供应商、模型和 Reasoning 就是请求实际使用的目标；修改后下一次请求立即生效。</div>
      ) : automaticRouting ? (
        <div className="floating-routing-hint">自动路由已开启：Codex 选择器决定正常路由；这里可修改未匹配请求的回退目标。</div>
      ) : null}
      <label><span>{autoModelEnabled ? '自动模型供应商 / Key' : automaticRouting ? '回退供应商 / Key' : '供应商 / Key'}</span><select value={relayId} disabled={busy} onChange={(event) => setRelayId(event.target.value)}>{settings?.relayProfiles.filter((profile) => profile.relayMode !== 'aggregate').map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}</select></label>
      <label>
        <span>{autoModelEnabled ? '自动模型实际使用' : automaticRouting ? '回退模型' : '模型'}</span>
        <div className="floating-model-picker">
          <input
            value={model}
            disabled={busy}
            placeholder={selectableModels.length ? '也可以手动输入模型' : '请先在供应商配置中获取模型'}
            onChange={(event) => setModel(event.target.value)}
          />
          <select
            value={selectableModels.includes(model) ? model : ''}
            disabled={busy || !selectableModels.length}
            aria-label="选择已获取的模型"
            title={selectableModels.length ? `选择已获取的模型（${selectableModels.length} 个）` : '当前供应商还没有已获取的模型'}
            onChange={(event) => {
              if (event.target.value) setModel(event.target.value)
            }}
          >
            <option value="">{selectableModels.length ? `选择（${selectableModels.length}）` : '暂无模型'}</option>
            {selectableModels.map((candidate) => <option key={candidate} value={candidate}>{candidate}</option>)}
          </select>
        </div>
      </label>
      <label><span>{autoModelEnabled ? '自动模型 Reasoning' : 'Reasoning'}</span><select value={reasoning} onChange={(event) => setReasoning(event.target.value)}><option value="auto">自动</option><option value="off">关闭</option><option value="low">low</option><option value="medium">medium</option><option value="high">high</option><option value="xhigh">xhigh</option></select></label>
      <div className="floating-actions">
        <button className="primary" type="button" disabled={busy} onClick={() => void apply()}><Save size={14} />{autoModelEnabled ? '应用自动模型' : automaticRouting ? '保存并开启' : '应用并开启'}</button>
        <button type="button" disabled={busy} onClick={() => void toggleGateway()}><Power size={14} />{hot?.enabled ? '关闭' : '开启'}</button>
      </div>
      <button className="floating-open-main" type="button" onClick={() => void invoke('floating_show_main')}><ExternalLink size={14} />打开主程序</button>
      <p>{message}</p>
    </main>
  )
}
