import { Save, X } from 'lucide-react'
import { CodexField, LoadingButton } from '../shared/CodexPanel'
import type { ContextDraft, ContextKind } from './contextTypes'
import { CONTEXT_KIND_LABELS } from './contextTypes'

export function ContextEntryEditor({
  draft,
  busy,
  onChange,
  onCancel,
  onSave,
}: {
  draft: ContextDraft
  busy: boolean
  onChange: (draft: ContextDraft) => void
  onCancel: () => void
  onSave: () => void
}) {
  const valid = Boolean(draft.id.trim() && draft.tomlBody.trim())

  return (
    <section className="codex-context-editor" aria-label={draft.editing ? '编辑配置' : '新增配置'}>
      <header>
        <div><strong>{draft.editing ? '编辑配置' : '新增配置'}</strong><span>保存后会进入 Codex Compass 的统一 Codex 配置。</span></div>
        <button type="button" aria-label="关闭编辑器" disabled={busy} onClick={onCancel}><X size={16} /></button>
      </header>
      <div className="codex-form-grid single">
        <CodexField label="类型">
          <select
            value={draft.kind}
            disabled={draft.editing || busy}
            onChange={(event) => onChange({ ...draft, kind: event.target.value as ContextKind })}
          >
            {(Object.entries(CONTEXT_KIND_LABELS) as Array<[ContextKind, string]>).map(([kind, label]) => (
              <option key={kind} value={kind}>{label}</option>
            ))}
          </select>
        </CodexField>
        <CodexField label="ID" hint={draft.editing ? '编辑已有条目时不能修改 ID。' : '建议使用稳定且不重复的英文 ID。'}>
          <input value={draft.id} disabled={draft.editing || busy} onChange={(event) => onChange({ ...draft, id: event.target.value })} />
        </CodexField>
        <CodexField label="TOML 配置" wide>
          <textarea rows={12} value={draft.tomlBody} disabled={busy} onChange={(event) => onChange({ ...draft, tomlBody: event.target.value })} />
        </CodexField>
      </div>
      <footer className="codex-toolbar">
        <button type="button" disabled={busy} onClick={onCancel}>取消</button>
        <LoadingButton type="button" className="primary" busy={busy} disabled={!valid} onClick={onSave}>
          <Save size={14} />保存配置
        </LoadingButton>
      </footer>
    </section>
  )
}
