import { useMemo, useState } from 'react'
import { Layers3, Save, Sparkles, Zap } from 'lucide-react'
import type { BackendSettings, HotSwitchMappingResult, HotSwitchModelMapping, HotSwitchResult } from '../types'
import { CodexField, CodexPanel, LoadingButton, StatusPill } from '../shared/CodexPanel'
import { ModelMappingEditor } from './ModelMappingEditor'
import { validateMappings } from './mappingValidation'
import './HotSwitchPage.css'

export function HotSwitchPage({
  settings,
  status,
  mappings,
  scan,
  busy,
  onPatchSettings,
  onMappingsChange,
  onToggle,
  onScan,
  onInject,
  onSaveMappings,
  onSetAutoModelEnabled,
  onSaveSettings,
  onSetFloatingEnabled,
  onResetFloatingPosition,
}: {
  settings: BackendSettings
  status: HotSwitchResult | null
  mappings: HotSwitchModelMapping[]
  scan: HotSwitchMappingResult | null
  busy: string
  onPatchSettings: (patch: Partial<BackendSettings>) => void
  onMappingsChange: (mappings: HotSwitchModelMapping[]) => void
  onToggle: (enabled: boolean) => void
  onScan: () => void
  onInject: (relayIds: string[]) => void
  onSaveMappings: () => void
  onSetAutoModelEnabled: (enabled: boolean) => void
  onSaveSettings: () => void
  onSetFloatingEnabled: (enabled: boolean) => void
  onResetFloatingPosition: () => void
}) {
  const injectionProfiles = useMemo(
    () => settings.relayProfiles.filter((profile) => profile.relayMode !== 'aggregate'),
    [settings.relayProfiles],
  )
  const [selectedInjectionRelayIds, setSelectedInjectionRelayIds] = useState<string[]>(() => {
    const mappedRelayIds = new Set(mappings.flatMap((mapping) => [mapping.relayId, ...(mapping.candidateRelayIds ?? [])]))
    const mappedProfiles = injectionProfiles.filter((profile) => mappedRelayIds.has(profile.id)).map((profile) => profile.id)
    return mappedProfiles.length ? mappedProfiles : injectionProfiles.map((profile) => profile.id)
  })
  const validation = validateMappings(mappings, settings.relayProfiles)
  const enabled = Boolean(status?.enabled ?? settings.hotSwitchEnabled)
  const operationBusy = Boolean(busy)
  const savingSettings = busy === 'save-settings'
  const applying = busy === 'save-mappings-before-hot' || busy === 'set-hot'
  const automaticRouting = settings.hotSwitchModelRoutingEnabled
  const state = status?.error ? 'error' : status?.running ? 'running' : enabled ? 'waiting' : 'off'
  const stateLabel = state === 'error' ? '网关错误' : state === 'running' ? '网关运行中' : state === 'waiting' ? '配置已开启，进程未运行' : '配置已关闭'
  const stateTone = state === 'running' ? 'ok' : state === 'error' ? 'error' : state === 'waiting' ? 'warning' : 'info'
  const selectedInjectionCount = selectedInjectionRelayIds.length
  const injectedModelCount = settings.hotSwitchAutoModelEnabled ? 1 : mappings.length
  const showFixedTarget = settings.hotSwitchAutoModelEnabled || !automaticRouting

  const toggleInjectionProfile = (relayId: string) => {
    setSelectedInjectionRelayIds((current) => current.includes(relayId)
      ? current.filter((id) => id !== relayId)
      : [...current, relayId])
  }

  return (
    <div className="codex-hot-switch-page">
      <CodexPanel title="8787 本地网关" icon={<Zap size={18} />} action={<StatusPill tone={stateTone}>{stateLabel}</StatusPill>}>
        {status?.error ? <div className="codex-hot-switch-error">{status.error}</div> : null}
        <div className="codex-form-grid">
          {showFixedTarget ? (
            <>
              <CodexField label={settings.hotSwitchAutoModelEnabled ? '自动模型供应商' : '固定供应商'}>
                <select value={settings.hotSwitchRelayId} disabled={operationBusy} onChange={(event) => onPatchSettings({ hotSwitchRelayId: event.target.value })}>
                  {settings.relayProfiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}{profile.relayMode === 'aggregate' ? '（聚合）' : ''}</option>)}
                </select>
              </CodexField>
              <CodexField label={settings.hotSwitchAutoModelEnabled ? '自动模型实际模型' : '固定模型'}><input value={settings.hotSwitchModel} disabled={operationBusy} onChange={(event) => onPatchSettings({ hotSwitchModel: event.target.value })} /></CodexField>
            </>
          ) : null}
          <CodexField label="默认推理强度">
            <select value={settings.defaultReasoning ?? 'auto'} disabled={operationBusy} onChange={(event) => onPatchSettings({ defaultReasoning: event.target.value })}>
              <option value="auto">自动</option><option value="off">关闭</option><option value="low">low</option><option value="medium">medium</option><option value="high">high</option><option value="xhigh">xhigh</option>
            </select>
          </CodexField>
          <CodexField label="请求体上限（MiB）">
            <input
              type="number"
              min={16}
              max={256}
              step={16}
              value={settings.hotSwitchRequestBodyLimitMib}
              disabled={operationBusy}
              onChange={(event) => {
                const value = event.currentTarget.valueAsNumber
                if (Number.isFinite(value)) onPatchSettings({ hotSwitchRequestBodyLimitMib: value })
              }}
            />
          </CodexField>
          {!settings.hotSwitchAutoModelEnabled ? (
            <CodexField label="模型自动路由">
              <select value={settings.hotSwitchModelRoutingEnabled ? 'on' : 'off'} disabled={operationBusy} onChange={(event) => onPatchSettings({ hotSwitchModelRoutingEnabled: event.target.value === 'on' })}>
                <option value="off">关闭</option><option value="on">开启</option>
              </select>
            </CodexField>
          ) : null}
        </div>
        {settings.hotSwitchAutoModelEnabled ? (
          <p className="codex-result-text">Codex 选择“Codex Compass 自动模型”时，这里的供应商、模型和默认推理强度就是实际请求目标；也可以随后通过悬浮面板即时修改。</p>
        ) : automaticRouting ? (
          <p className="codex-result-text">模型自动路由开启后，只接受已保存的模型映射，并以 Codex 窗口内选择的模型为准；未映射模型会直接提示错误，不再使用全局回退目标。</p>
        ) : null}
        {!validation.valid && !enabled ? <p className="codex-result-text">映射规则仍有错误；修正后才能应用并开启自动路由。</p> : null}
        <p className="codex-result-text">请求体上限默认 64 MiB，可设置 16–256 MiB；保存后对下一次请求立即生效。调高会增加内存、Token 与上游超限风险，不会改变上游站点的限制。</p>
        <p className="codex-result-text">“保存配置”只保存本区设置，不会启动 8787 网关，也不会修改 Codex 当前配置。</p>
        <div className="codex-toolbar">
          <LoadingButton busy={savingSettings} disabled={operationBusy} onClick={onSaveSettings}>
            <Save size={14} />保存配置
          </LoadingButton>
          <LoadingButton busy={applying} className={enabled ? 'danger' : 'primary'} disabled={operationBusy || (!enabled && settings.hotSwitchModelRoutingEnabled && !validation.valid)} onClick={() => onToggle(!enabled)}>
            <Zap size={14} />{enabled ? '关闭热切换' : '应用并开启'}
          </LoadingButton>
          <span className="codex-path">{status?.baseUrl ?? 'http://127.0.0.1:8787/v1'}</span>
        </div>
      </CodexPanel>

      <CodexPanel title="悬浮切换" icon={<Sparkles size={18} />}>
        <div className="codex-switch-row"><div><strong>悬浮球与自动模型控制器</strong><span>启动软件时默认关闭；开启后单击打开面板、拖动调整位置、右键可关闭悬浮球。添加自动模型后，可实时切换 Codex 请求实际使用的供应商、模型和 Reasoning。</span></div><button className={settings.floatingSwitchEnabled ? 'toggle on' : 'toggle'} type="button" role="switch" aria-label="悬浮切换面板" aria-checked={settings.floatingSwitchEnabled} disabled={operationBusy} onClick={() => onSetFloatingEnabled(!settings.floatingSwitchEnabled)}><span /></button></div>
        <div className="codex-toolbar">
          <LoadingButton busy={savingSettings} disabled={operationBusy} onClick={onSaveSettings}><Save size={14} />保存悬浮设置</LoadingButton>
          <button type="button" disabled={operationBusy} onClick={onResetFloatingPosition}>恢复默认位置</button>
        </div>
      </CodexPanel>

      <CodexPanel title="多供应商模型注入" icon={<Layers3 size={18} />} className="injection-panel">
        <div className="codex-injection-intro">
          <div>
            <strong>把多个供应商的模型合并到 Codex 模型选择器</strong>
            <span>{settings.hotSwitchAutoModelEnabled ? '自动模型启用后，Codex 模型选择器只保留“Codex Compass 自动模型”；现有普通映射仍会保存，移除自动模型后自动恢复。' : '每个供应商的模型都会独立注入；同名模型在 Codex 中按“模型 · 供应商”区分。添加自动模型后，也可以只保留一个入口并通过悬浮面板切换。'}</span>
          </div>
          <StatusPill tone={enabled && settings.hotSwitchModelRoutingEnabled ? 'ok' : 'info'}>
            {enabled && settings.hotSwitchModelRoutingEnabled ? `已生成 ${injectedModelCount} 个模型` : '尚未启用'}
          </StatusPill>
        </div>
        <div className="codex-injection-profiles">
          {injectionProfiles.map((profile) => (
            <label key={profile.id} className={selectedInjectionRelayIds.includes(profile.id) ? 'selected' : ''}>
              <input
                type="checkbox"
                checked={selectedInjectionRelayIds.includes(profile.id)}
                disabled={operationBusy}
                onChange={() => toggleInjectionProfile(profile.id)}
              />
              <span><strong>{profile.name}</strong><small>{profile.protocol}</small></span>
            </label>
          ))}
        </div>
        <div className="codex-toolbar">
          <button type="button" disabled={operationBusy || selectedInjectionCount === injectionProfiles.length} onClick={() => setSelectedInjectionRelayIds(injectionProfiles.map((profile) => profile.id))}>全选</button>
          <button type="button" disabled={operationBusy || !selectedInjectionCount} onClick={() => setSelectedInjectionRelayIds([])}>清空</button>
          <LoadingButton busy={busy === 'inject-models'} className="primary" disabled={operationBusy || !selectedInjectionCount} onClick={() => onInject(selectedInjectionRelayIds)}>
            <Layers3 size={14} />{enabled ? '重新生成并更新 Codex' : '生成模型列表并开启'}
          </LoadingButton>
          <span className="codex-result-text">已选择 {selectedInjectionCount} / {injectionProfiles.length} 个供应商</span>
        </div>
      </CodexPanel>

      <ModelMappingEditor
        profiles={settings.relayProfiles}
        mappings={mappings}
        scan={scan}
        validation={validation}
        busy={busy}
        autoModelEnabled={settings.hotSwitchAutoModelEnabled}
        onChange={onMappingsChange}
        onScan={onScan}
        onSave={onSaveMappings}
        onSetAutoModelEnabled={onSetAutoModelEnabled}
      />
    </div>
  )
}
