import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { CircleAlert, Download, ExternalLink, FileCode2, LoaderCircle, RefreshCw, Search, ShieldCheck, Trash2, X } from 'lucide-react'
import { callCodex } from '../api'
import type { ScriptMarketItem, ScriptMarketResult, SettingsResult, UserScriptInventory } from '../types'
import { InstalledScriptRow } from './InstalledScriptRow'
import { MarketScriptCard } from './MarketScriptCard'
import type { DeleteScriptState, InstalledScript, ScriptPageNotice } from './types'
import { CodexNotice } from '../shared/CodexNotice'
import './ScriptMarketPage.css'

const SCRIPT_MARKET_REPOSITORY_URL = 'https://github.com/BigPizzaV3/CodexPlusPlusScriptMarket'
const EMPTY_MARKET_SCRIPTS: ScriptMarketItem[] = []

type Props = {
  settingsResult: SettingsResult | null
  onSettingsResultChange: (result: SettingsResult) => void
}

function noticeTone(status: string): ScriptPageNotice['tone'] {
  if (status === 'failed') return 'error'
  if (status === 'warning') return 'warning'
  return 'ok'
}

function marketStatusLabel(status?: string) {
  if (!status) return '未检查'
  if (status === 'ok') return '正常'
  if (status === 'warning') return '有警告'
  if (status === 'failed') return '加载失败'
  return status
}

export function ScriptMarketPage({ settingsResult, onSettingsResultChange }: Props) {
  const [market, setMarket] = useState<ScriptMarketResult | null>(null)
  const [busyKeys, setBusyKeys] = useState<Set<string>>(() => new Set())
  const [notice, setNotice] = useState<ScriptPageNotice | null>(null)
  const [query, setQuery] = useState('')
  const [deleteState, setDeleteState] = useState<DeleteScriptState | null>(null)
  const settingsResultRef = useRef(settingsResult)
  const onSettingsResultChangeRef = useRef(onSettingsResultChange)
  const operationBusy = busyKeys.size > 0
  const deleteBusy = busyKeys.has('delete')

  const beginBusy = useCallback((key: string) => {
    setBusyKeys((current) => {
      const next = new Set(current)
      next.add(key)
      return next
    })
  }, [])

  const endBusy = useCallback((key: string) => {
    setBusyKeys((current) => {
      const next = new Set(current)
      next.delete(key)
      return next
    })
  }, [])

  useEffect(() => { settingsResultRef.current = settingsResult }, [settingsResult])
  useEffect(() => { onSettingsResultChangeRef.current = onSettingsResultChange }, [onSettingsResultChange])

  const inventory = settingsResult?.userScripts
  const installedScripts = inventory?.scripts ?? []
  const marketScripts = market?.market.scripts ?? EMPTY_MARKET_SCRIPTS
  const installedCount = useMemo(() => marketScripts.reduce((count, script) => count + Number(script.installed), 0), [marketScripts])
  const normalizedQuery = query.trim().toLocaleLowerCase()
  const visibleMarketScripts = useMemo(() => {
    if (!normalizedQuery) return marketScripts
    return marketScripts.filter((script) => [script.name, script.author, script.description, ...script.tags].some((value) => value.toLocaleLowerCase().includes(normalizedQuery)))
  }, [marketScripts, normalizedQuery])

  const syncInventory = useCallback((nextInventory: UserScriptInventory) => {
    const current = settingsResultRef.current
    if (!current) return
    onSettingsResultChangeRef.current({ ...current, userScripts: nextInventory })
  }, [])

  const refreshMarket = useCallback(async (silent = false) => {
    beginBusy('market')
    try {
      const result = await callCodex<ScriptMarketResult>('refresh_script_market')
      setMarket(result)
      if (!silent || result.status === 'failed') setNotice({ tone: noticeTone(result.status), text: result.message })
    } catch (error) {
      setNotice({ tone: 'error', text: error instanceof Error ? error.message : String(error) })
    } finally {
      endBusy('market')
    }
  }, [beginBusy, endBusy])

  const refreshRuntime = useCallback(async (reload = false, silent = false) => {
    const busyKey = reload ? 'local-reload' : 'runtime-inspect'
    beginBusy(busyKey)
    try {
      const result = await callCodex<SettingsResult>(reload ? 'reload_user_scripts' : 'load_user_script_runtime')
      onSettingsResultChangeRef.current(result)
      if (!silent || result.status === 'failed') setNotice({ tone: noticeTone(result.status), text: result.message })
    } catch (error) {
      setNotice({ tone: 'error', text: error instanceof Error ? error.message : String(error) })
    } finally {
      endBusy(busyKey)
    }
  }, [beginBusy, endBusy])

  useEffect(() => { void refreshMarket(true) }, [refreshMarket])
  useEffect(() => { void refreshRuntime(false, true) }, [refreshRuntime])

  useEffect(() => {
    if (!deleteState) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !deleteBusy) setDeleteState(null)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [deleteBusy, deleteState])

  const installScript = useCallback(async (id: string) => {
    const operationKey = `install-${id}`
    beginBusy(operationKey)
    try {
      const result = await callCodex<ScriptMarketResult>('install_market_script', { id })
      setMarket(result)
      if (result.status === 'failed') {
        syncInventory(result.userScripts)
        setNotice({ tone: 'error', text: result.message })
      } else {
        const runtime = await callCodex<SettingsResult>('reload_user_scripts')
        onSettingsResultChange(runtime)
        setNotice({ tone: noticeTone(runtime.status), text: `${result.message}${runtime.message}` })
      }
    } catch (error) {
      setNotice({ tone: 'error', text: error instanceof Error ? error.message : String(error) })
    } finally {
      endBusy(operationKey)
    }
  }, [beginBusy, endBusy, onSettingsResultChange, syncInventory])

  const toggleScript = useCallback(async (script: InstalledScript) => {
    const operationKey = `toggle-${script.key}`
    beginBusy(operationKey)
    try {
      const result = await callCodex<SettingsResult>('set_user_script_enabled', { key: script.key, enabled: !script.enabled })
      if (result.status === 'failed') {
        onSettingsResultChange(result)
        setNotice({ tone: 'error', text: result.message })
      } else {
        const runtime = await callCodex<SettingsResult>(script.enabled ? 'load_user_script_runtime' : 'reload_user_scripts')
        onSettingsResultChange(runtime)
        setNotice({ tone: noticeTone(runtime.status), text: `${result.message}${runtime.message}` })
      }
    } catch (error) {
      setNotice({ tone: 'error', text: error instanceof Error ? error.message : String(error) })
    } finally {
      endBusy(operationKey)
    }
  }, [beginBusy, endBusy, onSettingsResultChange])

  const deleteScript = useCallback(async () => {
    const script = deleteState?.script
    if (!script || script.source !== 'user') return
    beginBusy('delete')
    try {
      const result = await callCodex<SettingsResult>('delete_user_script', { key: script.key })
      onSettingsResultChange(result)
      setDeleteState(null)
      setNotice({ tone: noticeTone(result.status), text: result.message })
      if (result.status !== 'failed') await refreshMarket(true)
    } catch (error) {
      setNotice({ tone: 'error', text: error instanceof Error ? error.message : String(error) })
    } finally {
      endBusy('delete')
    }
  }, [beginBusy, deleteState, endBusy, onSettingsResultChange, refreshMarket])

  const openExternal = useCallback(async (url: string) => {
    try {
      const result = await callCodex<{ status: string; message: string }>('open_external_url', { url })
      if (result.status === 'failed') setNotice({ tone: 'error', text: result.message })
    } catch (error) {
      setNotice({ tone: 'error', text: error instanceof Error ? error.message : String(error) })
    }
  }, [])

  return (
    <div className="script-market-page">
      {notice ? <CodexNotice tone={notice.tone} text={notice.text} onDismiss={() => setNotice(null)} /> : null}

      <section className="script-panel script-overview-panel">
        <header><div><FileCode2 size={18} /><strong>脚本市场</strong></div><span>{market?.market.message || '尚未刷新市场'}</span></header>
        <div className="script-metrics">
          <div><span>市场状态</span><strong>{marketStatusLabel(market?.market.status || market?.status)}</strong><small>{market?.market.updatedAt ? `更新于 ${market.market.updatedAt}` : '等待远程清单'}</small></div>
          <div><span>远程脚本</span><strong>{marketScripts.length}</strong><small>市场清单数量</small></div>
          <div><span>已安装</span><strong>{installedCount}</strong><small>来自当前市场</small></div>
          <div><span>本地总开关</span><strong>{inventory?.enabled === false ? '关闭' : '开启'}</strong><small>{installedScripts.length} 个本地脚本</small></div>
        </div>
        <div className="script-toolbar">
          <button type="button" className="primary" disabled={operationBusy} onClick={() => void refreshMarket()}>{busyKeys.has('market') ? <LoaderCircle className="spin" size={14} /> : <RefreshCw size={14} />}刷新市场</button>
          <button type="button" disabled={operationBusy} onClick={() => void refreshRuntime(true)}>{busyKeys.has('local-reload') ? <LoaderCircle className="spin" size={14} /> : <RefreshCw size={14} />}重新加载脚本</button>
          <button type="button" onClick={() => void openExternal(SCRIPT_MARKET_REPOSITORY_URL)}><ExternalLink size={14} />市场主页</button>
        </div>
      </section>

      <section className="script-panel market-list-panel">
        <header><div><Download size={18} /><strong>市场脚本</strong></div><span>{visibleMarketScripts.length} / {marketScripts.length}</span></header>
        <div className="script-search"><Search size={15} /><input value={query} placeholder="搜索脚本名称、作者、描述或标签" onChange={(event) => setQuery(event.target.value)} /></div>
        {visibleMarketScripts.length ? <div className="market-script-grid">{visibleMarketScripts.map((script) => <MarketScriptCard key={script.id} script={script} busy={busyKeys.has(`install-${script.id}`)} disabled={operationBusy} onInstall={(id) => void installScript(id)} onOpenHomepage={(url) => void openExternal(url)} />)}</div> : <div className="script-empty"><Search size={22} /><span>{marketScripts.length ? '没有符合搜索条件的脚本。' : market?.status === 'failed' ? market.message : '点击“刷新市场”加载远程脚本。'}</span></div>}
      </section>

      <section className="script-panel local-script-panel">
        <header><div><ShieldCheck size={18} /><strong>本地脚本</strong></div><span>{installedScripts.length} 个</span></header>
        {installedScripts.length ? <div className="installed-script-list">{installedScripts.map((script) => <InstalledScriptRow key={script.key} script={script} busy={busyKeys.has(`toggle-${script.key}`) || (deleteBusy && deleteState?.script.key === script.key)} disabled={operationBusy} onToggle={(item) => void toggleScript(item)} onDelete={(item) => setDeleteState({ script: item })} />)}</div> : <div className="script-empty"><FileCode2 size={22} /><span>未发现内置、用户或市场安装脚本。</span></div>}
      </section>

      {deleteState ? <div className="script-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !deleteBusy) setDeleteState(null) }}><section className="script-confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="delete-script-title" aria-describedby="delete-script-description"><header><div><Trash2 size={18} /><strong id="delete-script-title">删除用户脚本</strong></div><button type="button" aria-label="关闭" disabled={deleteBusy} onClick={() => setDeleteState(null)}><X size={16} /></button></header><div id="delete-script-description" className="script-delete-copy"><CircleAlert size={20} /><div><strong>{deleteState.script.name}</strong><span>此操作会移除本地脚本文件。市场脚本可以之后重新安装。</span><code>{deleteState.script.key}</code></div></div><footer><button type="button" disabled={deleteBusy} onClick={() => setDeleteState(null)}>取消</button><button type="button" className="danger" disabled={deleteBusy} onClick={() => void deleteScript()}>{deleteBusy ? <LoaderCircle className="spin" size={14} /> : <Trash2 size={14} />}确认删除</button></footer></section></div> : null}
    </div>
  )
}
