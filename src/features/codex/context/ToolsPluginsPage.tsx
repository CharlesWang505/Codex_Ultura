import { useMemo, useState } from 'react'
import { Boxes, Plus } from 'lucide-react'
import type { CodexContextEntries, CodexContextEntry, PluginStatusResult } from '../types'
import { CodexPanel, LoadingButton } from '../shared/CodexPanel'
import { ConfirmDialog } from '../shared/ConfirmDialog'
import { ContextEntryEditor } from './ContextEntryEditor'
import { ContextEntryList } from './ContextEntryList'
import { CONTEXT_KIND_LABELS, setContextEnabled } from './contextTypes'
import type { ContextDraft, ContextKind } from './contextTypes'
import { PluginMarketplacePanel } from './PluginMarketplacePanel'
import './ToolsPluginsPage.css'

const EMPTY_DRAFT: ContextDraft = { kind: 'mcp', id: '', tomlBody: '', editing: false }

function entriesForKind(entries: CodexContextEntries, kind: ContextKind) {
  if (kind === 'mcp') return entries.mcpServers
  if (kind === 'skill') return entries.skills
  return entries.plugins
}

export function ToolsPluginsPage({
  entries,
  localMarketplace,
  remoteMarketplace,
  busy,
  onReadLive,
  onSyncLive,
  onUpsert,
  onDelete,
  onRefreshMarketplaces,
  onRepairMarketplace,
}: {
  entries: CodexContextEntries
  localMarketplace: PluginStatusResult | null
  remoteMarketplace: PluginStatusResult | null
  busy: string
  onReadLive: () => void
  onSyncLive: () => void
  onUpsert: (draft: ContextDraft, operationKey?: string) => Promise<boolean>
  onDelete: (entry: CodexContextEntry) => Promise<boolean>
  onRefreshMarketplaces: () => void
  onRepairMarketplace: (remote: boolean) => void
}) {
  const [activeKind, setActiveKind] = useState<ContextKind>('mcp')
  const [draft, setDraft] = useState<ContextDraft | null>(null)
  const [pendingDelete, setPendingDelete] = useState<CodexContextEntry | null>(null)
  const activeEntries = useMemo(() => entriesForKind(entries, activeKind), [activeKind, entries])
  const pageBusy = Boolean(busy)

  const saveDraft = async () => {
    if (!draft) return
    const saved = await onUpsert(draft)
    if (saved) setDraft(null)
  }

  const toggleEntry = async (entry: CodexContextEntry) => {
    await onUpsert({
      kind: entry.kind,
      id: entry.id,
      tomlBody: setContextEnabled(entry.tomlBody, !entry.enabled),
      editing: true,
    }, `toggle-context-${entry.kind}-${entry.id}`)
  }

  const confirmDelete = async () => {
    if (!pendingDelete) return
    const deleted = await onDelete(pendingDelete)
    if (deleted) setPendingDelete(null)
  }

  return (
    <div className="codex-tools-page">
      <CodexPanel
        title="MCP、Skills 与插件"
        icon={<Boxes size={18} />}
        action={(
          <div className="codex-inline-actions">
            <LoadingButton busy={busy === 'read-live-context'} disabled={pageBusy} onClick={onReadLive}>读取当前 Codex</LoadingButton>
            <LoadingButton busy={busy === 'sync-live-context'} disabled={pageBusy} onClick={onSyncLive}>同步到当前 Codex</LoadingButton>
            <button type="button" className="primary" disabled={pageBusy} onClick={() => setDraft({ ...EMPTY_DRAFT, kind: activeKind })}><Plus size={14} />新增</button>
          </div>
        )}
      >
        <div className="codex-context-tabs" role="tablist" aria-label="工具与插件分类">
          {(Object.entries(CONTEXT_KIND_LABELS) as Array<[ContextKind, string]>).map(([kind, label]) => {
            const count = entriesForKind(entries, kind).length
            return (
              <button
                key={kind}
                id={`codex-context-tab-${kind}`}
                type="button"
                role="tab"
                aria-controls={`codex-context-panel-${kind}`}
                aria-selected={activeKind === kind}
                tabIndex={activeKind === kind ? 0 : -1}
                className={activeKind === kind ? 'active' : ''}
                disabled={pageBusy}
                onClick={() => setActiveKind(kind)}
              >
                {label}<span>{count}</span>
              </button>
            )
          })}
        </div>
        <div id={`codex-context-panel-${activeKind}`} role="tabpanel" aria-labelledby={`codex-context-tab-${activeKind}`}>
          <ContextEntryList
            entries={activeEntries}
            busy={busy}
            disabled={pageBusy}
            onEdit={(entry) => setDraft({ kind: entry.kind, id: entry.id, tomlBody: entry.tomlBody, editing: true })}
            onToggle={(entry) => void toggleEntry(entry)}
            onDelete={setPendingDelete}
          />
        </div>
        {draft ? <ContextEntryEditor draft={draft} busy={pageBusy} onChange={setDraft} onCancel={() => setDraft(null)} onSave={() => void saveDraft()} /> : null}
      </CodexPanel>

      <PluginMarketplacePanel
        localStatus={localMarketplace}
        remoteStatus={remoteMarketplace}
        busy={busy}
        onRefresh={onRefreshMarketplaces}
        onRepair={onRepairMarketplace}
      />

      <ConfirmDialog
        open={Boolean(pendingDelete)}
        title="删除工具或插件配置"
      description="删除后会从 Codex Compass 管理的公共 Codex 配置中移除。"
        items={pendingDelete ? [`${CONTEXT_KIND_LABELS[pendingDelete.kind]} · ${pendingDelete.title || pendingDelete.id}`] : []}
        confirmLabel="删除"
        destructive
        busy={Boolean(pendingDelete && busy === `delete-context-${pendingDelete.id}`)}
        onCancel={() => setPendingDelete(null)}
        onConfirm={() => void confirmDelete()}
      />
    </div>
  )
}
