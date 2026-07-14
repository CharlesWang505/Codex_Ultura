import { Plus, RefreshCw, Save, Sparkles, Trash2 } from 'lucide-react'
import type { HotSwitchMappingResult, HotSwitchModelMapping, RelayProfile } from '../types'
import { CodexEmptyState, CodexField, CodexPanel, LoadingButton } from '../shared/CodexPanel'
import { FallbackRelayPicker } from './FallbackRelayPicker'
import { ProviderScanResults } from './ProviderScanResults'
import type { MappingValidation } from './mappingValidation'

export function ModelMappingEditor({
  profiles,
  mappings,
  scan,
  validation,
  busy,
  autoModelEnabled,
  onChange,
  onScan,
  onSave,
  onSetAutoModelEnabled,
}: {
  profiles: RelayProfile[]
  mappings: HotSwitchModelMapping[]
  scan: HotSwitchMappingResult | null
  validation: MappingValidation
  busy: string
  autoModelEnabled: boolean
  onChange: (mappings: HotSwitchModelMapping[]) => void
  onScan: () => void
  onSave: () => void
  onSetAutoModelEnabled: (enabled: boolean) => void
}) {
  const usableProfiles = profiles.filter((profile) => profile.relayMode !== 'aggregate')
  const operationBusy = Boolean(busy)
  const update = (index: number, patch: Partial<HotSwitchModelMapping>) => {
    onChange(mappings.map((mapping, mappingIndex) => mappingIndex === index ? { ...mapping, ...patch } : mapping))
  }

  const add = () => onChange([...mappings, {
    model: '',
    upstreamModel: '',
    relayId: usableProfiles[0]?.id ?? '',
    candidateRelayIds: [],
    fallbackRelayIds: [],
    reasoningOverride: 'inherit',
  }])

  return (
    <CodexPanel
      title="模型映射规则"
      icon={<RefreshCw size={18} />}
      action={(
        <div className="codex-inline-actions">
          <LoadingButton busy={busy === 'auto-model'} className={autoModelEnabled ? '' : 'primary'} disabled={operationBusy || !usableProfiles.length || !validation.valid} onClick={() => onSetAutoModelEnabled(!autoModelEnabled)}>
            <Sparkles size={14} />{autoModelEnabled ? '移除自动模型' : '添加自动模型'}
          </LoadingButton>
          <button type="button" disabled={operationBusy || !usableProfiles.length} onClick={add}><Plus size={14} />新增规则</button>
          <LoadingButton busy={busy === 'scan-mappings'} disabled={operationBusy || !usableProfiles.length} onClick={onScan}><RefreshCw size={14} />自动扫描</LoadingButton>
          <LoadingButton busy={busy === 'save-mappings'} disabled={operationBusy || !validation.valid} onClick={onSave}><Save size={14} />保存规则</LoadingButton>
        </div>
      )}
      className="mapping-panel"
    >
      {scan ? (
        <>
          <div className="codex-scan-summary"><span>{scan.mappings.length} 条映射</span><span>{scan.conflictCount} 个同名冲突</span><span>{scan.failedProviderCount} 个扫描失败</span></div>
          <ProviderScanResults providers={scan.providers} />
        </>
      ) : null}
      {autoModelEnabled ? (
        <div className="codex-auto-model-note">
          <Sparkles size={16} />
          <div><strong>Codex Compass 自动模型已添加</strong><span>在 Codex 中选择“Codex Compass 自动模型”，之后悬浮面板选择的供应商、模型和 Reasoning 会在下一次请求立即生效。</span></div>
        </div>
      ) : null}
      {!validation.valid ? <div className="codex-mapping-errors">{validation.messages.slice(0, 8).map((message) => <span key={message}>{message}</span>)}</div> : null}
      {mappings.length ? (
        <div className="codex-mapping-cards">
          {mappings.map((mapping, index) => (
            <article key={index} className={(validation.rowErrors[index]?.length ?? 0) > 0 ? 'invalid' : ''}>
              <header><strong>规则 {index + 1}</strong><button type="button" aria-label={`删除映射规则 ${index + 1}`} disabled={operationBusy} onClick={() => onChange(mappings.filter((_, itemIndex) => itemIndex !== index))}><Trash2 size={14} />删除</button></header>
              <div className="codex-form-grid">
                <CodexField label="Codex 模型 / 别名"><input value={mapping.model} disabled={operationBusy} onChange={(event) => update(index, { model: event.target.value })} /></CodexField>
                <CodexField label="上游真实模型"><input value={mapping.upstreamModel} disabled={operationBusy} onChange={(event) => update(index, { upstreamModel: event.target.value })} /></CodexField>
                <CodexField label="首选供应商">
                  <select value={mapping.relayId} disabled={operationBusy} onChange={(event) => update(index, { relayId: event.target.value, fallbackRelayIds: (mapping.fallbackRelayIds ?? []).filter((id) => id !== event.target.value) })}>
                    {usableProfiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}
                  </select>
                </CodexField>
                <CodexField label="Reasoning">
                  <select value={mapping.reasoningOverride ?? 'inherit'} disabled={operationBusy} onChange={(event) => update(index, { reasoningOverride: event.target.value })}>
                    <option value="inherit">继承</option><option value="off">关闭</option><option value="low">low</option><option value="medium">medium</option><option value="high">high</option><option value="xhigh">xhigh</option>
                  </select>
                </CodexField>
                <CodexField label="备用供应商顺序" wide>
                  <FallbackRelayPicker profiles={usableProfiles} primaryId={mapping.relayId} selectedIds={mapping.fallbackRelayIds ?? []} candidateIds={mapping.candidateRelayIds ?? []} disabled={operationBusy} onChange={(ids) => update(index, { fallbackRelayIds: ids })} />
                </CodexField>
              </div>
              {validation.rowErrors[index]?.length ? <div className="codex-mapping-row-errors">{validation.rowErrors[index].map((error) => <span key={error}>{error}</span>)}</div> : null}
            </article>
          ))}
        </div>
      ) : <CodexEmptyState text="点击“自动扫描”从所有供应商获取模型并生成映射，或手动新增模型别名规则。" />}
    </CodexPanel>
  )
}
