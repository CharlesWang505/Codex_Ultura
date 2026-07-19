import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Activity,
  CircleAlert,
  Download,
  KeyRound,
  LoaderCircle,
  Play,
  Plus,
  Power,
  RefreshCw,
  Save,
  Settings2,
  ShieldCheck,
  Sparkles,
  Stethoscope,
  Trash2,
  Wrench,
  Zap,
} from 'lucide-react'
import { isTauriRuntime } from '../../lib/desktop'
import { listen } from '@tauri-apps/api/event'
import { callCodex, commandSucceeded } from './api'
import { ToolsPluginsPage } from './context/ToolsPluginsPage'
import type { ContextDraft } from './context/contextTypes'
import { HotSwitchPage } from './hotSwitch/HotSwitchPage'
import { AggregateRelayEditor } from './providers/AggregateRelayEditor'
import {
  configuredModelNames,
  normalizeModelImageHandling,
  parseModelImageHandling,
  updateModelImageHandling,
} from './providers/modelImageHandling'
import { removeRelayProfileFromSettings } from './providers/providerSettings'
import { ScriptMarketPage } from './scripts/ScriptMarketPage'
import { SessionsPage } from './sessions/SessionsPage'
import {
  CodexEmptyState as EmptyState,
  CodexField as Field,
  CodexPanel as Panel,
  LoadingButton,
  StatusPill,
} from './shared/CodexPanel'
import { CodexNotice } from './shared/CodexNotice'
import type {
  BackendSettings,
  CodexContextEntries,
  CodexContextEntry,
  CommandResult,
  ContextEntriesResult,
  DiagnosticsResult,
  HotSwitchMappingResult,
  HotSwitchModelMapping,
  HotSwitchResult,
  InstallResult,
  LogsResult,
  OverviewResult,
  PluginStatusResult,
  ProviderDoctorResult,
  RelayActionResult,
  RelayProfile,
  RelayProfileModelsResult,
  RelayProfileTestResult,
  SettingsResult,
  UpdateResult,
  WatcherResult,
} from './types'
import './CodexWorkspace.css'

const ThemeStudioPage = lazy(() => import('./themes/ThemeStudioPage').then((module) => ({ default: module.ThemeStudioPage })))

export type CodexSection =
  | '概览'
  | '供应商配置'
  | '热切换'
  | '会话管理'
  | '主题工坊'
  | '工具与插件'
  | 'Codex增强'
  | '脚本市场'
  | '设置'

type Props = {
  section: CodexSection
}

type Notice = { tone: 'ok' | 'warning' | 'error' | 'info'; text: string }

type RelayEnvironmentReport = {
  clashVergeTun: { enabled: boolean; configPath: string | null }
  proxyEnvironment: { variables: Array<{ name: string; source: 'process' | 'user' | 'system' }> }
  codexEnvFile: { exists: boolean; path: string }
}

type EnvConflictsResult = CommandResult<{
  conflicts: Array<{ name: string; source: string; valuePresent: boolean }>
  environment: RelayEnvironmentReport
}>

const EMPTY_CONTEXT: CodexContextEntries = { mcpServers: [], skills: [], plugins: [] }

const ENHANCEMENT_TOGGLES: Array<[keyof BackendSettings, string, string]> = [
  ['codexAppPluginMarketplaceUnlock', '插件市场解锁', '解除 Codex 客户端插件市场入口限制。'],
  ['codexAppPluginAutoExpand', '插件自动展开', '打开插件页面时自动展开可用插件。'],
  ['codexAppModelWhitelistUnlock', '模型白名单解锁', '显示供应商模型目录中的全部模型。'],
  ['codexAppSessionDelete', '会话删除', '在会话管理中允许安全删除本地会话。'],
  ['codexAppMarkdownExport', 'Markdown 导出', '为会话增加 Markdown 导出能力。'],
  ['codexAppPasteFix', '粘贴修复', '修复部分 Windows 环境下的粘贴异常。'],
  ['codexAppForceChineseLocale', '中文界面', '为 Codex 客户端应用中文本地化。'],
  ['codexAppFastStartup', '快速启动', '减少非必要启动等待。'],
  ['codexAppProjectMove', '项目迁移', '允许调整会话关联的项目目录。'],
  ['codexAppThreadIdBadge', '任务 ID 标记', '在任务界面显示线程 ID。'],
  ['codexAppConversationView', '会话视图增强', '启用增强的会话展示模式。'],
  ['codexAppThreadScrollRestore', '滚动位置恢复', '重新打开任务时恢复阅读位置。'],
  ['codexAppUpstreamWorktreeCreate', '工作树创建', '启用上游工作树创建入口。'],
  ['codexAppNativeMenuPlacement', '原生菜单布局', '优化桌面端原生菜单位置。'],
  ['codexAppNativeMenuLocalization', '原生菜单中文化', '翻译桌面端原生菜单。'],
  ['codexAppServiceTierControls', '服务等级控制', '显示服务等级相关控制项。'],
  ['computerUseGuardEnabled', '计算机操作防护', '为计算机控制能力增加安全检查。'],
  ['codexGoalsEnabled', '目标实验功能', '启用 Codex 目标实验能力。'],
]

function createId(prefix: string) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`
}

function blankProfile(): RelayProfile {
  return {
    id: createId('relay'),
    name: '新供应商',
    model: '',
    baseUrl: 'https://',
    upstreamBaseUrl: 'https://',
    apiKey: '',
    protocol: 'responses',
    relayMode: 'pureApi',
    officialMixApiKey: false,
    testModel: '',
    configContents: '',
    authContents: '',
    useCommonConfig: true,
    contextSelection: { mcpServers: [], skills: [], plugins: [] },
    contextSelectionInitialized: false,
    contextWindow: '',
    autoCompactLimit: '',
    modelInsertMode: 'patch',
    modelList: '',
    modelWindows: '',
    modelVlm: '{}',
    vlmApiKey: '',
    vlmApiKeySaved: false,
    vlmModel: '',
    vlmBaseUrl: '',
    userAgent: '',
    reasoningDialect: 'inherit',
  }
}

function noticeFrom(result: { status: string; message: string }): Notice {
  if (result.status === 'ok') return { tone: 'ok', text: result.message }
  if (result.status === 'warning') return { tone: 'warning', text: result.message }
  return { tone: 'error', text: result.message }
}

export function CodexWorkspace({ section }: Props) {
  const tauri = isTauriRuntime()
  const [busy, setBusy] = useState('')
  const activeOperations = useRef<string[]>([])
  const [notice, setNotice] = useState<Notice | null>(null)
  const [settingsResult, setSettingsResult] = useState<SettingsResult | null>(null)
  const [settings, setSettings] = useState<BackendSettings | null>(null)
  const [overview, setOverview] = useState<OverviewResult | null>(null)
  const [relayStatus, setRelayStatus] = useState<RelayActionResult | null>(null)
  const [hotSwitch, setHotSwitch] = useState<HotSwitchResult | null>(null)
  const [mappings, setMappings] = useState<HotSwitchModelMapping[]>([])
  const [mappingScan, setMappingScan] = useState<HotSwitchMappingResult | null>(null)
  const [selectedProfileId, setSelectedProfileId] = useState('')
  const [profileModels, setProfileModels] = useState<string[]>([])
  const [doctor, setDoctor] = useState<ProviderDoctorResult | null>(null)
  const [contexts, setContexts] = useState<CodexContextEntries>(EMPTY_CONTEXT)
  const [watcher, setWatcher] = useState<WatcherResult | null>(null)
  const [logs, setLogs] = useState<LogsResult | null>(null)
  const [diagnostics, setDiagnostics] = useState<DiagnosticsResult | null>(null)
  const [update, setUpdate] = useState<UpdateResult | null>(null)
  const [pluginStatus, setPluginStatus] = useState<PluginStatusResult | null>(null)
  const [remotePluginStatus, setRemotePluginStatus] = useState<PluginStatusResult | null>(null)
  const [relayFiles, setRelayFiles] = useState<CommandResult<{ configPath: string; authPath: string; configContents: string; authContents: string }> | null>(null)
  const [ccsProviders, setCcsProviders] = useState<CommandResult<{ dbPath: string; providers: Array<{ sourceId: string; name: string; baseUrl: string }> }> | null>(null)
  const [pendingImport, setPendingImport] = useState<CommandResult<{ pending: { name: string; baseUrl: string } | null }> | null>(null)
  const [envConflicts, setEnvConflicts] = useState<EnvConflictsResult | null>(null)

  const run = useCallback(async <T,>(key: string, operation: () => Promise<T>) => {
    activeOperations.current.push(key)
    setBusy(key)
    try {
      return await operation()
    } catch (error) {
      setNotice({ tone: 'error', text: error instanceof Error ? error.message : String(error) })
      return null
    } finally {
      const index = activeOperations.current.lastIndexOf(key)
      if (index >= 0) activeOperations.current.splice(index, 1)
      setBusy(activeOperations.current.at(-1) ?? '')
    }
  }, [])

  const acceptSettings = useCallback((result: SettingsResult | HotSwitchResult | HotSwitchMappingResult) => {
    setSettings(result.settings)
    setMappings(result.settings.hotSwitchModelMappings ?? [])
    if ('userScripts' in result) setSettingsResult(result)
    if (!selectedProfileId && result.settings.relayProfiles[0]) {
      setSelectedProfileId(result.settings.relayProfiles[0].id)
    }
  }, [selectedProfileId])

  const loadSettings = useCallback(async () => {
    if (!tauri) return null
    const result = await run('load-settings', () => callCodex<SettingsResult>('load_settings'))
    if (result) {
      setSettingsResult(result)
      acceptSettings(result)
      setNotice(noticeFrom(result))
    }
    return result
  }, [acceptSettings, run, tauri])

  const refreshOverview = useCallback(async () => {
    if (!tauri) return
    const results = await run('overview', () => Promise.all([
      callCodex<OverviewResult>('load_overview'),
      callCodex<RelayActionResult>('relay_status'),
      callCodex<HotSwitchResult>('hot_switch_status'),
      callCodex<WatcherResult>('load_watcher_state'),
    ]))
    if (!results) return
    const [nextOverview, nextRelay, nextHot, nextWatcher] = results
    setOverview(nextOverview)
    setRelayStatus(nextRelay)
    setHotSwitch(nextHot)
    setWatcher(nextWatcher)
    acceptSettings(nextHot)
  }, [acceptSettings, run, tauri])

  useEffect(() => {
    if (!tauri || settings) return
    void loadSettings()
  }, [loadSettings, settings, tauri])

  useEffect(() => {
    if (!tauri) return
    if (section === '概览') void refreshOverview()
    if (section === '热切换') {
      void run('hot-status', () => callCodex<HotSwitchResult>('hot_switch_status')).then((result) => {
        if (result) {
          setHotSwitch(result)
          acceptSettings(result)
        }
      })
    }
    if (section === '设置') {
      void run('watcher-status', () => callCodex<WatcherResult>('load_watcher_state')).then((result) => result && setWatcher(result))
    }
  }, [acceptSettings, refreshOverview, run, section, tauri])

  useEffect(() => {
    if (section !== '工具与插件' || !settings || !tauri) return
    void run('tools-load', () => Promise.all([
      callCodex<ContextEntriesResult>('list_context_entries', { request: { settings } }),
      callCodex<CommandResult<{ entries: CodexContextEntries }>>('read_live_context_entries'),
      callCodex<PluginStatusResult>('plugin_marketplace_status'),
      callCodex<PluginStatusResult>('remote_plugin_marketplace_status'),
    ])).then((result) => {
      if (!result) return
      const [managed, live, localMarketplace, remoteMarketplace] = result
      setContexts(commandSucceeded(live) ? live.entries : managed.entries)
      setPluginStatus(localMarketplace)
      setRemotePluginStatus(remoteMarketplace)
      if (!commandSucceeded(live)) setNotice(noticeFrom(live))
    })
  }, [run, section, settings, tauri])

  const selectedProfile = useMemo(
    () => settings?.relayProfiles.find((profile) => profile.id === selectedProfileId) ?? settings?.relayProfiles[0] ?? null,
    [selectedProfileId, settings],
  )
  const selectableProfileModels = useMemo(() => {
    const configuredModels = selectedProfile?.modelList
      .split(/[\r\n,]/)
      .map((value) => value.trim())
      .filter(Boolean) ?? []
    return Array.from(new Set([...profileModels, ...configuredModels]))
  }, [profileModels, selectedProfile?.modelList])
  const selectedAggregateProfile = useMemo(
    () => selectedProfile ? settings?.aggregateRelayProfiles.find((profile) => profile.id === selectedProfile.id) ?? null : null,
    [selectedProfile, settings],
  )
  const selectedProfileReady = selectedProfile?.relayMode !== 'aggregate' || Boolean(selectedAggregateProfile?.members.length)
  const configuredModels = useMemo(
    () => configuredModelNames(selectedProfile?.modelList ?? ''),
    [selectedProfile?.modelList],
  )
  const modelImageHandling = useMemo(
    () => parseModelImageHandling(selectedProfile?.modelVlm),
    [selectedProfile?.modelVlm],
  )
  const usesVlm = configuredModels.some((model) => modelImageHandling[model] === 'vlm')

  const saveSettings = useCallback(async (next: BackendSettings, message = true) => {
    if (!tauri) return null
    const result = await run('save-settings', () => callCodex<SettingsResult>('save_settings', { settings: next }))
    if (result) {
      setSettingsResult(result)
      acceptSettings(result)
      if (message) setNotice(noticeFrom(result))
    }
    return result
  }, [acceptSettings, run, tauri])

  const patchSettings = useCallback((patch: Partial<BackendSettings>) => {
    setSettings((current) => current ? { ...current, ...patch } : current)
  }, [])

  useEffect(() => {
    if (!tauri) return
    let disposed = false
    let unlisten: (() => void) | undefined
    void listen<boolean>('floating-switch-changed', ({ payload }) => {
      patchSettings({ floatingSwitchEnabled: payload })
    }).then((cleanup) => {
      if (disposed) cleanup()
      else unlisten = cleanup
    })
    return () => {
      disposed = true
      unlisten?.()
    }
  }, [patchSettings, tauri])

  const setFloatingEnabled = useCallback(async (enabled: boolean) => {
    const result = await run('floating-enabled', () => callCodex<boolean>('floating_set_enabled', { enabled }))
    if (result === null) return
    patchSettings({ floatingSwitchEnabled: result })
    setNotice({ tone: 'ok', text: result ? '悬浮球已开启，单击悬浮球可打开快速切换面板。' : '悬浮球已关闭。' })
  }, [patchSettings, run])

  const resetFloatingPosition = useCallback(async () => {
    const result = await run('floating-reset-position', () => callCodex<boolean>('floating_reset_position'))
    if (!result) return
    patchSettings({ floatingSwitchPosition: null })
    setNotice({ tone: 'ok', text: '悬浮球已恢复到默认位置。' })
  }, [patchSettings, run])

  const patchProfile = useCallback((patch: Partial<RelayProfile>) => {
    setSettings((current) => {
      if (!current || !selectedProfile) return current
      const nextProfile = { ...selectedProfile, ...patch }
      let aggregateRelayProfiles = current.aggregateRelayProfiles.map((profile) => profile.id === selectedProfile.id && patch.name ? { ...profile, name: patch.name } : profile)
      if (nextProfile.relayMode === 'aggregate' && !aggregateRelayProfiles.some((profile) => profile.id === selectedProfile.id)) {
        aggregateRelayProfiles = [...aggregateRelayProfiles, { id: selectedProfile.id, name: nextProfile.name, strategy: 'failover', members: [] }]
      }
      return {
        ...current,
        relayProfiles: current.relayProfiles.map((profile) => profile.id === selectedProfile.id ? nextProfile : profile),
        aggregateRelayProfiles,
      }
    })
  }, [selectedProfile])

  const patchAggregateProfile = useCallback((profile: BackendSettings['aggregateRelayProfiles'][number]) => {
    setSettings((current) => current ? {
      ...current,
      aggregateRelayProfiles: current.aggregateRelayProfiles.some((item) => item.id === profile.id)
        ? current.aggregateRelayProfiles.map((item) => item.id === profile.id ? profile : item)
        : [...current.aggregateRelayProfiles, profile],
    } : current)
  }, [])

  const addProfile = useCallback(() => {
    const profile = blankProfile()
    setSettings((current) => current ? { ...current, relayProfiles: [...current.relayProfiles, profile] } : current)
    setSelectedProfileId(profile.id)
    setProfileModels([])
    setDoctor(null)
  }, [])

  const removeProfile = useCallback(async () => {
    if (!settings || !selectedProfile) return
    const next = removeRelayProfileFromSettings(settings, selectedProfile.id)
    if (!next) return

    const removedName = selectedProfile.name
    const nextId = next.relayProfiles[0]?.id ?? ''
    const result = await saveSettings(next, false)
    if (!result || !commandSucceeded(result)) return

    setSelectedProfileId(
      result.settings.relayProfiles.some((profile) => profile.id === nextId)
        ? nextId
        : result.settings.relayProfiles[0]?.id ?? '',
    )
    setProfileModels([])
    setDoctor(null)
    setNotice({ tone: 'ok', text: `供应商「${removedName}」已删除并保存。` })
  }, [saveSettings, selectedProfile, settings])

  const saveProfiles = useCallback(async () => {
    if (settings) await saveSettings(settings)
  }, [saveSettings, settings])

  const testProfile = useCallback(async (mode: 'test' | 'models' | 'doctor') => {
    if (!selectedProfile) return
    if (mode === 'models') {
      const result = await run('profile-models', () => callCodex<RelayProfileModelsResult>('fetch_relay_profile_models', { profile: selectedProfile }))
      if (result) {
        setProfileModels(result.models)
        setNotice(noticeFrom(result))
        if (commandSucceeded(result) && result.models.length) {
          patchProfile({
            modelList: result.models.join('\n'),
            model: selectedProfile.model?.trim() ? selectedProfile.model : result.models[0],
          })
        }
      }
      return
    }
    if (mode === 'doctor') {
      const result = await run('profile-doctor', () => callCodex<ProviderDoctorResult>('diagnose_relay_profile', { profile: selectedProfile }))
      if (result) {
        setDoctor(result)
        setNotice(noticeFrom(result))
      }
      return
    }
    const result = await run('profile-test', () => callCodex<RelayProfileTestResult>('test_relay_profile', { profile: selectedProfile }))
    if (result) setNotice(noticeFrom(result))
  }, [patchProfile, run, selectedProfile])

  const switchProfile = useCallback(async () => {
    if (!settings || !selectedProfile) return
    const nextSettings: BackendSettings = {
      ...settings,
      activeRelayId: selectedProfile.id,
      activeAggregateRelayId: selectedProfile.relayMode === 'aggregate' ? selectedProfile.id : settings.activeAggregateRelayId,
    }
    const result = await run('switch-profile', () => callCodex<SettingsResult & { relay?: unknown }>('switch_relay_profile', {
      request: { settings: nextSettings, previousActiveRelayId: settings.activeRelayId },
    }))
    if (result) {
      acceptSettings(result)
      setNotice(noticeFrom(result))
    }
  }, [acceptSettings, run, selectedProfile, settings])

  const applyRelay = useCallback(async (kind: 'relay' | 'pure' | 'clear') => {
    if (!settings) return
    const saved = await saveSettings(settings, false)
    if (!saved || !commandSucceeded(saved)) return
    const command = kind === 'relay' ? 'apply_relay_injection' : kind === 'pure' ? 'apply_pure_api_injection' : 'clear_relay_injection'
    const result = await run(`apply-${kind}`, () => callCodex<RelayActionResult>(command))
    if (result) {
      setRelayStatus(result)
      setNotice(noticeFrom(result))
    }
  }, [run, saveSettings, settings])

  const updateHotSwitch = useCallback(async (enabled: boolean) => {
    if (!settings) return
    if (enabled) {
      const savedSettings = await saveSettings(settings, false)
      if (!savedSettings || !commandSucceeded(savedSettings)) {
        if (savedSettings) setNotice(noticeFrom(savedSettings))
        return
      }
      if (settings.hotSwitchModelRoutingEnabled) {
        const savedMappings = await run('save-mappings-before-hot', () => callCodex<HotSwitchMappingResult>('save_hot_switch_model_mappings', {
          request: { enabled: true, mappings },
        }))
        if (!savedMappings || !commandSucceeded(savedMappings)) {
          if (savedMappings) setNotice(noticeFrom(savedMappings))
          return
        }
        setMappingScan(savedMappings)
        acceptSettings(savedMappings)
      }
    }
    const result = await run('set-hot', () => callCodex<HotSwitchResult>('set_hot_switch', {
      request: {
        enabled,
        relayId: settings.hotSwitchRelayId || settings.relayProfiles[0]?.id || '',
        model: settings.hotSwitchModel,
      },
    }))
    if (result) {
      setHotSwitch(result)
      acceptSettings(result)
      setNotice(noticeFrom(result))
    }
  }, [acceptSettings, mappings, run, saveSettings, settings])

  const scanMappings = useCallback(async (relayIds: string[] = []) => {
    if (!settings) return
    const result = await run('scan-mappings', async () => {
      const savedDrafts = await callCodex<HotSwitchMappingResult>('save_hot_switch_model_mappings', {
        request: { enabled: settings.hotSwitchModelRoutingEnabled, mappings },
      })
      if (!commandSucceeded(savedDrafts)) return savedDrafts
      return callCodex<HotSwitchMappingResult>('scan_hot_switch_model_mappings', {
        request: { relayIds },
      })
    })
    if (result) {
      setMappingScan(result)
      setMappings(result.mappings)
      acceptSettings(result)
      setNotice(noticeFrom(result))
    }
  }, [acceptSettings, mappings, run, settings])

  const injectProviderModels = useCallback(async (relayIds: string[]) => {
    if (!relayIds.length) {
      setNotice({ tone: 'warning', text: '请至少选择一个要注入模型的供应商。' })
      return
    }
    const result = await run('inject-models', async () => {
      if (settings) {
        const savedDrafts = await callCodex<HotSwitchMappingResult>('save_hot_switch_model_mappings', {
          request: { enabled: settings.hotSwitchModelRoutingEnabled, mappings },
        })
        if (!commandSucceeded(savedDrafts)) return { scan: savedDrafts, hot: null, restart: null }
      }
      const scan = await callCodex<HotSwitchMappingResult>('scan_hot_switch_model_mappings', {
        request: { relayIds },
      })
      if (!commandSucceeded(scan) || !scan.mappings.length) return { scan, hot: null, restart: null }
      const hot = await callCodex<HotSwitchResult>('set_hot_switch', {
        request: {
          enabled: true,
          relayId: scan.settings.hotSwitchRelayId || relayIds[0],
          model: scan.settings.hotSwitchModel,
        },
      })
      if (!commandSucceeded(hot)) return { scan, hot, restart: null }
      const restart = await callCodex<CommandResult<{ debugPort: number; helperPort: number }>>('restart_codex_plus', {
        request: {
          appPath: hot.settings.codexAppPath ?? '',
          debugPort: 9222,
          helperPort: 58321,
        },
      })
      return { scan, hot, restart }
    })
    if (!result) return

    setMappingScan(result.scan)
    setMappings(result.scan.mappings)
    acceptSettings(result.scan)
    if (!result.hot) {
      setNotice(noticeFrom(result.scan))
      return
    }
    setHotSwitch(result.hot)
    acceptSettings(result.hot)
    if (!commandSucceeded(result.hot)) {
      setNotice(noticeFrom(result.hot))
      return
    }
    if (!result.restart || result.restart.status === 'failed') {
      setNotice({
        tone: 'warning',
        text: `已生成 ${result.scan.mappings.length} 个模型并开启 8787，但 Codex 自动重启失败。请在“概览”中手动点击“重启 Codex”以加载完整模型列表。`,
      })
      return
    }
    setNotice({
      tone: result.scan.status === 'warning' ? 'warning' : 'ok',
      text: `已从 ${result.scan.providers.length} 个供应商生成 ${result.scan.mappings.length} 个 Codex 模型，启用模型白名单解锁，并已请求重启 Codex。`,
    })
  }, [acceptSettings, mappings, run, settings])

  const saveMappings = useCallback(async () => {
    if (!settings) return
    const result = await run('save-mappings', () => callCodex<HotSwitchMappingResult>('save_hot_switch_model_mappings', {
      request: { enabled: settings.hotSwitchModelRoutingEnabled, mappings },
    }))
    if (result) {
      setMappingScan(result)
      acceptSettings(result)
      setNotice(noticeFrom(result))
    }
  }, [acceptSettings, mappings, run, settings])

  const setAutoModelEnabled = useCallback(async (enabled: boolean) => {
    if (!settings) return

    const currentProfile = settings.relayProfiles.find((profile) => profile.id === settings.hotSwitchRelayId && profile.relayMode !== 'aggregate')
    const preferredMapping = mappings.find((mapping) => mapping.relayId === currentProfile?.id && mapping.upstreamModel.trim())
      ?? mappings.find((mapping) => mapping.upstreamModel.trim())
    const targetRelayId = currentProfile?.id
      ?? preferredMapping?.relayId
      ?? settings.relayProfiles.find((profile) => profile.relayMode !== 'aggregate')?.id
      ?? ''
    const targetProfile = settings.relayProfiles.find((profile) => profile.id === targetRelayId)
    const targetModels = targetProfile?.modelList
      .split(/[\r\n,]/)
      .map((model) => model.trim())
      .filter(Boolean) ?? []
    const targetModel = settings.hotSwitchModel.trim()
      || (preferredMapping?.relayId === targetRelayId ? preferredMapping.upstreamModel.trim() : '')
      || targetProfile?.model?.trim()
      || targetModels[0]
      || ''

    if (enabled && (!targetRelayId || !targetModel)) {
      setNotice({ tone: 'warning', text: '请先为至少一个供应商获取模型，自动模型需要一个初始供应商和实际模型。' })
      return
    }

    const result = await run('auto-model', async () => {
      const saved = await callCodex<HotSwitchMappingResult>('save_hot_switch_model_mappings', {
        request: {
          enabled: settings.hotSwitchModelRoutingEnabled || enabled,
          autoModelEnabled: enabled,
          mappings,
        },
      })
      if (!commandSucceeded(saved)) return { saved, hot: null, restart: null }

      let hot: HotSwitchResult | null = null
      if (enabled) {
        await callCodex<boolean>('floating_set_enabled', { enabled: true })
        hot = await callCodex<HotSwitchResult>('set_hot_switch', {
          request: {
            enabled: true,
            relayId: targetRelayId,
            model: targetModel,
          },
        })
        if (!commandSucceeded(hot)) return { saved, hot, restart: null }
      }

      const effectiveSettings = hot?.settings ?? saved.settings
      const restart = await callCodex<CommandResult<{ debugPort: number; helperPort: number }>>('restart_codex_plus', {
        request: {
          appPath: effectiveSettings.codexAppPath ?? '',
          debugPort: 9222,
          helperPort: 58321,
        },
      })
      return { saved, hot, restart }
    })
    if (!result) return

    setMappingScan(result.saved)
    setMappings(result.saved.mappings)
    if (result.hot) {
      setHotSwitch(result.hot)
      acceptSettings(result.hot)
    } else {
      acceptSettings(result.saved)
    }
    if (!commandSucceeded(result.saved)) {
      setNotice(noticeFrom(result.saved))
      return
    }
    if (result.hot && !commandSucceeded(result.hot)) {
      setNotice(noticeFrom(result.hot))
      return
    }
    if (!result.restart || result.restart.status === 'failed') {
      setNotice({
        tone: 'warning',
        text: `${enabled ? '自动模型已添加' : '自动模型已移除'}，但 Codex 自动重启失败。请点击左上角闪电按钮重新打开 Codex。`,
      })
      return
    }
    setNotice({
      tone: 'ok',
      text: enabled
        ? '已添加 Codex Compass 自动模型、开启悬浮球和 8787，并重新打开 Codex。选择自动模型后可直接用悬浮面板切换实际模型。'
        : '已移除 Codex Compass 自动模型并重新打开 Codex。',
    })
  }, [acceptSettings, mappings, run, settings])

  const upsertContext = useCallback(async (draft: ContextDraft, operationKey = 'save-context') => {
    if (!settings || !draft.id.trim() || !draft.tomlBody.trim()) return false
    const result = await run(operationKey, () => callCodex<ContextEntriesResult>('upsert_context_entry', {
      request: { settings, kind: draft.kind, id: draft.id.trim(), tomlBody: draft.tomlBody },
    }))
    if (!result) return false
    setContexts(result.entries)
    setSettings(result.settings)
    const saved = await saveSettings(result.settings, false)
    if (!saved || !commandSucceeded(saved)) {
      setNotice(noticeFrom(saved ?? result))
      return false
    }
    const synced = await run(`${operationKey}-sync`, () => callCodex<CommandResult<{ entries: CodexContextEntries }>>('sync_live_context_entries', { request: { settings: result.settings } }))
    if (synced) setContexts(synced.entries)
    setNotice(noticeFrom(synced ?? saved))
    return true
  }, [run, saveSettings, settings])

  const removeContext = useCallback(async (entry: CodexContextEntry) => {
    if (!settings) return false
    const result = await run(`delete-context-${entry.id}`, () => callCodex<ContextEntriesResult>('delete_context_entry', {
      request: { settings, kind: entry.kind, id: entry.id },
    }))
    if (!result) return false
    setContexts(result.entries)
    setSettings(result.settings)
    const saved = await saveSettings(result.settings, false)
    if (!saved || !commandSucceeded(saved)) {
      setNotice(noticeFrom(saved ?? result))
      return false
    }
    const synced = await run(`delete-context-${entry.id}-sync`, () => callCodex<CommandResult<{ entries: CodexContextEntries }>>('sync_live_context_entries', { request: { settings: result.settings } }))
    if (synced) setContexts(synced.entries)
    setNotice(noticeFrom(synced ?? saved))
    return true
  }, [run, saveSettings, settings])

  const refreshPlugins = useCallback(async () => {
    const result = await run('plugins', () => Promise.all([
      callCodex<PluginStatusResult>('plugin_marketplace_status'),
      callCodex<PluginStatusResult>('remote_plugin_marketplace_status'),
    ]))
    if (result) {
      setPluginStatus(result[0])
      setRemotePluginStatus(result[1])
    }
  }, [run])

  const repairPlugin = useCallback(async (remote: boolean) => {
    const command = remote ? 'repair_remote_plugin_marketplace' : 'repair_plugin_marketplace'
    const result = await run(command, () => callCodex<PluginStatusResult>(command))
    if (result) {
      setNotice(noticeFrom(result))
      await refreshPlugins()
    }
  }, [refreshPlugins, run])

  const loadProviderAdvanced = useCallback(async () => {
    const results = await run('provider-advanced', () => Promise.all([
      callCodex<typeof relayFiles>('read_relay_files'),
      callCodex<typeof ccsProviders>('load_ccs_providers'),
      callCodex<typeof pendingImport>('load_pending_provider_import'),
      callCodex<typeof envConflicts>('check_env_conflicts'),
    ]))
    if (!results) return
    setRelayFiles(results[0])
    setCcsProviders(results[1])
    setPendingImport(results[2])
    setEnvConflicts(results[3])
  }, [run])

  const importCcsProviders = useCallback(async () => {
    const result = await run('import-ccs', () => callCodex<SettingsResult>('import_ccs_providers'))
    if (result) {
      setSettingsResult(result)
      acceptSettings(result)
      setNotice(noticeFrom(result))
      await loadProviderAdvanced()
    }
  }, [acceptSettings, loadProviderAdvanced, run])

  const resolvePendingImport = useCallback(async (confirm: boolean) => {
    const command = confirm ? 'confirm_pending_provider_import' : 'dismiss_pending_provider_import'
    const result = await run(command, () => callCodex<SettingsResult | CommandResult<{ pending: null }>>(command))
    if (!result) return
    if ('settings' in result) {
      setSettingsResult(result)
      acceptSettings(result)
    }
    setNotice(noticeFrom(result))
    await loadProviderAdvanced()
  }, [acceptSettings, loadProviderAdvanced, run])

  const saveRelayFile = useCallback(async (kind: 'config' | 'auth') => {
    if (!relayFiles) return
    const contents = kind === 'config' ? relayFiles.configContents : relayFiles.authContents
    const result = await run(`save-relay-${kind}`, () => callCodex<NonNullable<typeof relayFiles>>('save_relay_file', { request: { kind, contents } }))
    if (result) {
      setRelayFiles(result)
      setNotice(noticeFrom(result))
    }
  }, [relayFiles, run])

  const removeEnvConflicts = useCallback(async () => {
    const names = envConflicts?.conflicts.map((conflict) => conflict.name) ?? []
    if (!names.length) return
    const result = await run('remove-env-conflicts', () => callCodex<CommandResult<{ remaining: Array<{ name: string; source: string; valuePresent: boolean }> }>>('remove_env_conflicts', { request: { names } }))
    if (result) {
      setNotice(noticeFrom(result))
      await loadProviderAdvanced()
    }
  }, [envConflicts, loadProviderAdvanced, run])

  const runSimple = useCallback(async (command: string, args?: Record<string, unknown>) => {
    const result = await run(command, () => callCodex<CommandResult>(command, args))
    if (result) setNotice(noticeFrom(result))
    return result
  }, [run])

  if (!tauri) {
    return (
      <section className="codex-browser-placeholder">
        <Zap size={28} />
        <div><strong>{section}</strong><p>该页面需要在 Tauri 桌面程序中连接 Codex 本地配置。浏览器预览模式不会读取真实 Key 或配置文件。</p></div>
      </section>
    )
  }

  if (!settings) {
    return (
      <div className="codex-workspace">
        {notice ? <CodexNotice tone={notice.tone} text={notice.text} onDismiss={() => setNotice(null)} /> : null}
        <section className="codex-loading-state" aria-live="polite">
          {busy === 'load-settings' ? <LoaderCircle className="spin" size={24} /> : <CircleAlert size={24} />}
          <div>
            <strong>{busy === 'load-settings' ? '正在加载 Codex 本地设置' : 'Codex 设置尚未加载'}</strong>
            <p>{busy === 'load-settings' ? '正在连接本地 Rust 后端，请稍候。' : '可以重试读取；此操作不会修改现有供应商或 Key。'}</p>
          </div>
          {busy !== 'load-settings' ? <button type="button" onClick={() => void loadSettings()}><RefreshCw size={14} />重新读取</button> : null}
        </section>
      </div>
    )
  }

  return (
    <div className="codex-workspace">
      {notice ? <CodexNotice tone={notice.tone} text={notice.text} onDismiss={() => setNotice(null)} /> : null}

      {section === '概览' ? (
        <div className="codex-grid overview">
          <Panel title="Codex 运行状态" icon={<Activity size={18} />} action={<LoadingButton busy={busy === 'overview'} onClick={() => void refreshOverview()}><RefreshCw size={14} />刷新</LoadingButton>}>
            <div className="codex-metrics">
              <div><span>Codex 应用</span><strong>{overview?.codexVersion ?? '未检测'}</strong><small>{overview?.codexApp?.path ?? '等待检测'}</small></div>
              <div><span>本地配置</span><strong>{relayStatus?.configured ? '已应用' : '未应用'}</strong><small>{relayStatus?.configPath ?? overview?.settingsPath ?? '-'}</small></div>
              <div><span>8787 网关</span><strong>{hotSwitch?.running ? '运行中' : '已停止'}</strong><small>{hotSwitch?.baseUrl ?? 'http://127.0.0.1:8787/v1'}</small></div>
              <div><span>后台守护</span><strong>{watcher?.running ? '运行中' : watcher?.enabled ? '已启用' : watcher?.installed ? '已停用' : '未安装'}</strong><small>自动维护 Codex 启动状态</small></div>
            </div>
          </Panel>
          <Panel title="快速操作" icon={<Play size={18} />}>
            <div className="codex-action-grid">
              <LoadingButton busy={busy === 'launch_codex_plus'} onClick={() => void runSimple('launch_codex_plus', { request: { appPath: settings?.codexAppPath ?? '', debugPort: 9222, helperPort: 58321 } })}><Play size={16} />启动 Codex</LoadingButton>
              <LoadingButton busy={busy === 'restart_codex_plus'} onClick={() => void runSimple('restart_codex_plus', { request: { appPath: settings?.codexAppPath ?? '', debugPort: 9222, helperPort: 58321 } })}><RefreshCw size={16} />重启 Codex</LoadingButton>
              <LoadingButton busy={busy === 'install_entrypoints'} onClick={() => void run('install_entrypoints', () => callCodex<InstallResult>('install_entrypoints')).then((result) => result && setNotice(noticeFrom(result)))}><Download size={16} />安装入口</LoadingButton>
              <LoadingButton busy={busy === 'repair_shortcuts'} onClick={() => void run('repair_shortcuts', () => callCodex<InstallResult>('repair_shortcuts')).then((result) => result && setNotice(noticeFrom(result)))}><Wrench size={16} />修复快捷方式</LoadingButton>
              <LoadingButton busy={busy === 'uninstall_entrypoints'} onClick={() => void run('uninstall_entrypoints', () => callCodex<InstallResult>('uninstall_entrypoints', { options: { removeOwnedData: false } })).then((result) => result && setNotice(noticeFrom(result)))}><Trash2 size={16} />卸载入口</LoadingButton>
            </div>
          </Panel>
          <Panel title="当前路由" icon={<Zap size={18} />}>
            <div className="codex-route-summary">
              <StatusPill ok={Boolean(hotSwitch?.running)}>{hotSwitch?.running ? '热切换接管中' : '供应商直连'}</StatusPill>
              <strong>{hotSwitch?.relayName || settings?.relayProfiles.find((profile) => profile.id === settings.activeRelayId)?.name || '未选择供应商'}</strong>
              <span>{hotSwitch?.model || settings?.relayTestModel || '未选择模型'}</span>
            </div>
          </Panel>
          <Panel title="安装与维护" icon={<Settings2 size={18} />}>
            <div className="codex-maintenance-list">
              <div><span>Codex 管理入口</span><StatusPill ok={overview?.silentShortcut?.status === 'ok'}>{overview?.silentShortcut?.status ?? '未检测'}</StatusPill></div>
              <div><span>Codex 兼容核心</span><strong>v{overview?.currentVersion ?? '-'}</strong></div>
            </div>
          </Panel>
        </div>
      ) : null}

      {section === '供应商配置' ? (
        <div className="codex-provider-layout">
          <Panel title="API 供应商" icon={<KeyRound size={18} />} action={<button type="button" disabled={Boolean(busy)} onClick={addProfile}><Plus size={14} />添加</button>} className="codex-provider-list-panel">
            <div className="codex-switch-row codex-feature-master-switch"><div><strong>启用供应商配置</strong><span>关闭后保留所有供应商数据，但不参与 Codex 直连配置应用。</span></div><button className={settings?.relayProfilesEnabled ? 'toggle on' : 'toggle'} type="button" disabled={!settings || Boolean(busy)} onClick={() => settings && patchSettings({ relayProfilesEnabled: !settings.relayProfilesEnabled })}><span /></button></div>
            <div className="codex-provider-list">
              {settings?.relayProfiles.map((profile) => (
                <button className={profile.id === selectedProfile?.id ? 'active' : ''} type="button" key={profile.id} onClick={() => { setSelectedProfileId(profile.id); setProfileModels([]); setDoctor(null) }}>
                  <span>{profile.name}</span><small>{profile.relayMode === 'aggregate' ? '聚合' : profile.protocol === 'chatCompletions' ? 'Chat' : profile.protocol}</small>
                </button>
              ))}
            </div>
          </Panel>
          <div className="codex-provider-editor">
            {selectedProfile && settings ? (
              <>
                {settings.hotSwitchEnabled ? <div className="codex-lock-banner"><ShieldCheck size={16} />8787 热切换运行中；可继续编辑，保存并重载后新请求使用新配置，正在执行的请求不受影响。</div> : null}
                <Panel title={selectedProfile.name} icon={<KeyRound size={18} />} action={<div className="codex-inline-actions"><button type="button" className="danger" disabled={Boolean(busy) || settings.relayProfiles.length <= 1} onClick={() => void removeProfile()}><Trash2 size={14} />删除</button></div>}>
                  <div className="codex-provider-guide">
                    <strong>三步完成配置</strong>
                    <ol><li>填写 Base URL 和 API Key</li><li>点击“获取模型”并选择默认模型</li><li>{settings.hotSwitchEnabled ? '点击“保存并重载网关”' : '点击“保存并应用到 Codex”'}</li></ol>
                  </div>
                  <div className="codex-form-grid codex-provider-basic-grid">
                    <Field label="供应商名称"><input value={selectedProfile.name} onChange={(event) => patchProfile({ name: event.target.value })} /></Field>
                    <Field label="使用方式" hint="普通中转站保持“纯 API”即可。"><select value={selectedProfile.relayMode} onChange={(event) => patchProfile({ relayMode: event.target.value as RelayProfile['relayMode'] })}><option value="pureApi">纯 API（推荐）</option><option value="official">官方账号</option><option value="mixedApi">官方账号 + API</option><option value="aggregate">聚合供应商</option></select></Field>
                    {selectedProfile.relayMode === 'aggregate' && selectedAggregateProfile ? (
                      <div className="codex-field wide"><AggregateRelayEditor profile={selectedAggregateProfile} relayProfiles={settings.relayProfiles} disabled={false} onChange={patchAggregateProfile} /></div>
                    ) : (
                      <>
                        <Field label="接口协议" hint="大多数 Codex 中转站选择 OpenAI Responses。"><select value={selectedProfile.protocol} onChange={(event) => patchProfile({ protocol: event.target.value as RelayProfile['protocol'] })}><option value="responses">OpenAI Responses（推荐）</option><option value="chatCompletions">OpenAI Chat Completions</option><option value="anthropic">Anthropic 原生</option><option value="gemini">Gemini 原生</option></select></Field>
                        <Field label="Base URL" hint="通常以 /v1 结尾，例如 https://example.com/v1"><input value={selectedProfile.baseUrl ?? selectedProfile.upstreamBaseUrl ?? ''} onChange={(event) => patchProfile({ baseUrl: event.target.value, upstreamBaseUrl: event.target.value })} /></Field>
                        <Field label="API Key" hint={selectedProfile.apiKey === undefined ? 'Key 已保存在本地；留空不会覆盖。' : '仅保存在本机敏感配置目录。'}><input type="password" value={selectedProfile.apiKey ?? ''} placeholder={selectedProfile.apiKey === undefined ? '已保存' : 'sk-...'} onChange={(event) => patchProfile({ apiKey: event.target.value })} /></Field>
                        <Field label="默认模型" hint={selectableProfileModels.length ? `已读取 ${selectableProfileModels.length} 个模型，可直接选择。` : '先点击下方“获取模型”，也可以手动输入。'}>
                          <><input list={`provider-models-${selectedProfile.id}`} value={selectedProfile.model ?? ''} onChange={(event) => patchProfile({ model: event.target.value })} /><datalist id={`provider-models-${selectedProfile.id}`}>{selectableProfileModels.map((model) => <option key={model} value={model} />)}</datalist></>
                        </Field>
                      </>
                    )}
                  </div>
                  {selectedProfile.relayMode !== 'aggregate' ? <details className="codex-provider-advanced">
                    <summary><span>高级设置</span><small>Reasoning、测试模型、上下文和模型列表</small></summary>
                    <div className="codex-form-grid">
                      <Field label="Reasoning 方言"><select value={selectedProfile.reasoningDialect ?? 'inherit'} onChange={(event) => patchProfile({ reasoningDialect: event.target.value as RelayProfile['reasoningDialect'] })}><option value="inherit">自动识别（推荐）</option><option value="openai">OpenAI reasoning_effort</option><option value="openrouter">OpenRouter reasoning</option><option value="qwen">Qwen enable_thinking</option><option value="siliconflow">硅基流动 enable_thinking</option><option value="none">不发送推理参数</option></select></Field>
                      <Field label="测试模型" hint="留空时使用默认模型。"><input value={selectedProfile.testModel} onChange={(event) => patchProfile({ testModel: event.target.value })} /></Field>
                      <Field label="上下文窗口"><input value={selectedProfile.contextWindow} onChange={(event) => patchProfile({ contextWindow: event.target.value })} placeholder="例如 200000" /></Field>
                      <Field label="自动压缩阈值"><input value={selectedProfile.autoCompactLimit} onChange={(event) => patchProfile({ autoCompactLimit: event.target.value })} placeholder="留空为自动" /></Field>
                      <Field label="模型列表" hint="通常由“获取模型”自动填写；每行一个模型。" wide><textarea rows={6} value={selectedProfile.modelList} onChange={(event) => patchProfile({ modelList: event.target.value, modelVlm: normalizeModelImageHandling(event.target.value, selectedProfile.modelVlm) })} /></Field>
                      <div className="codex-field wide">
                        <span>模型图片策略</span>
                        <em>按模型决定图片原样发送、剥离，或先交给视觉模型分析。</em>
                        {configuredModels.length ? <div className="codex-model-image-list">
                          {configuredModels.map((model) => <label key={model}><strong>{model}</strong><select value={modelImageHandling[model] ?? 'send-as-is'} onChange={(event) => patchProfile({ modelVlm: updateModelImageHandling(selectedProfile.modelList, selectedProfile.modelVlm, model, event.target.value as 'send-as-is' | 'strip' | 'vlm') })}><option value="send-as-is">原样发送</option><option value="strip">剥离图片</option><option value="vlm">VLM 分析</option></select></label>)}
                        </div> : <small className="codex-model-image-empty">获取或填写模型后可配置图片策略。</small>}
                      </div>
                      {usesVlm ? <>
                        <Field label="VLM API Key" hint={selectedProfile.vlmApiKeySaved && selectedProfile.vlmApiKey === undefined ? 'Key 已由 Windows DPAPI 加密保存；输入新值可替换。' : '单独加密保存，不写入 settings.json。'}><input type="password" value={selectedProfile.vlmApiKey ?? ''} placeholder={selectedProfile.vlmApiKeySaved ? '已保存' : 'sk-...'} onChange={(event) => patchProfile({ vlmApiKey: event.target.value, vlmApiKeySaved: Boolean(event.target.value) })} /></Field>
                        <Field label="VLM 模型"><input value={selectedProfile.vlmModel ?? ''} onChange={(event) => patchProfile({ vlmModel: event.target.value })} placeholder="例如 qwen-vl-plus" /></Field>
                        <Field label="VLM Base URL" wide><input value={selectedProfile.vlmBaseUrl ?? ''} onChange={(event) => patchProfile({ vlmBaseUrl: event.target.value })} placeholder="https://example.com/v1" /></Field>
                        {!selectedProfile.vlmApiKeySaved || !(selectedProfile.vlmModel ?? '').trim() || !(selectedProfile.vlmBaseUrl ?? '').trim() ? <div className="codex-vlm-warning wide"><CircleAlert size={15} />VLM 配置不完整时会保留原图，不会静默丢失图片。</div> : null}
                      </> : null}
                      <Field label="自定义 User-Agent" hint="中转站没有特殊要求时保持为空。" wide><input value={selectedProfile.userAgent} onChange={(event) => patchProfile({ userAgent: event.target.value })} /></Field>
                    </div>
                  </details> : null}
                  <div className="codex-provider-primary-actions">
                    <div className="codex-toolbar">
                      {selectedProfile.relayMode !== 'aggregate' ? <LoadingButton busy={busy === 'profile-test'} onClick={() => void testProfile('test')}><Activity size={14} />测试连接</LoadingButton> : null}
                      {selectedProfile.relayMode !== 'aggregate' ? <LoadingButton busy={busy === 'profile-models'} onClick={() => void testProfile('models')}><Download size={14} />获取模型</LoadingButton> : null}
                      <LoadingButton busy={busy === 'save-settings'} className="primary" onClick={() => void saveProfiles()}><Save size={14} />{settings.hotSwitchEnabled ? '保存并重载网关' : '仅保存'}</LoadingButton>
                      {!settings.hotSwitchEnabled ? <LoadingButton busy={busy === 'switch-profile'} className="primary" disabled={!settings.relayProfilesEnabled || !selectedProfileReady} onClick={() => void switchProfile()}><Power size={14} />保存并应用到 Codex</LoadingButton> : null}
                    </div>
                    <small>{settings.hotSwitchEnabled ? '保存会原子更新 8787 的上游配置；不需要关闭网关，也不需要重启 Codex。' : settings.relayProfilesEnabled ? '“保存并应用”会把当前供应商设为默认，并写入 Codex 配置；不需要再单独点击“设为当前”。' : '请先打开左侧“启用供应商配置”开关，才能应用到 Codex。'}</small>
                  </div>
                  <details className="codex-provider-secondary-actions">
                    <summary>诊断与清理</summary>
                    <div className="codex-toolbar compact">
                      {selectedProfile.relayMode !== 'aggregate' ? <LoadingButton busy={busy === 'profile-doctor'} onClick={() => void testProfile('doctor')}><Stethoscope size={14} />诊断供应商</LoadingButton> : null}
                      <LoadingButton busy={busy === 'apply-clear'} disabled={settings.hotSwitchEnabled} onClick={() => void applyRelay('clear')}>清除 Codex 供应商配置</LoadingButton>
                    </div>
                  </details>
                </Panel>
                {doctor ? <Panel title="供应商诊断" icon={<Stethoscope size={18} />}><p className="codex-doctor-summary">{doctor.summary}</p><div className="codex-check-list">{doctor.checks.map((check) => <div key={check.id}><StatusPill ok={check.status === 'ok'}>{check.title}</StatusPill><span>{check.detail}</span></div>)}</div>{doctor.recommendation ? <p>{doctor.recommendation}</p> : null}</Panel> : null}
                <details className="codex-provider-maintenance">
                  <summary><span>高级维护与导入</span><small>读取当前 Codex、CCS 导入、环境变量和原始配置</small></summary>
                  <div className="codex-provider-maintenance-body">
                  <div className="codex-toolbar compact"><LoadingButton busy={busy === 'provider-advanced'} onClick={() => void loadProviderAdvanced()}><RefreshCw size={14} />读取维护状态</LoadingButton></div>
                  <div className="codex-toolbar compact">
                    <LoadingButton busy={busy === 'import-ccs'} disabled={!ccsProviders?.providers.length} onClick={() => void importCcsProviders()}>导入 CCS 供应商（{ccsProviders?.providers.length ?? 0}）</LoadingButton>
                    <LoadingButton busy={busy === 'remove-env-conflicts'} disabled={!envConflicts?.conflicts.length} onClick={() => void removeEnvConflicts()}>移除环境变量冲突（{envConflicts?.conflicts.length ?? 0}）</LoadingButton>
                    <LoadingButton busy={busy === 'backfill'} onClick={() => settings && selectedProfile && void run('backfill', () => callCodex<SettingsResult>('backfill_relay_profile_from_live', { request: { settings, profileId: selectedProfile.id } })).then((result) => { if (result) { acceptSettings(result); setNotice(noticeFrom(result)) } })}>读取当前 Codex 配置</LoadingButton>
                  </div>
                  <p className="codex-provider-maintenance-hint">仅当你在软件外修改过 Codex 的 config.toml 或 auth.json 时使用“读取当前 Codex 配置”；它会回填到当前供应商，不会自动应用其他供应商。</p>
                  {pendingImport?.pending ? <div className="codex-pending-import"><div><strong>待导入：{pendingImport.pending.name}</strong><span>{pendingImport.pending.baseUrl}</span></div><div><button type="button" onClick={() => void resolvePendingImport(true)}>确认</button><button type="button" className="danger" onClick={() => void resolvePendingImport(false)}>忽略</button></div></div> : null}
                  {envConflicts?.conflicts.length ? <div className="codex-tag-cloud">{envConflicts.conflicts.map((conflict) => <span key={`${conflict.source}-${conflict.name}`}>{conflict.name} · {conflict.source}</span>)}</div> : null}
                  {envConflicts?.environment ? <div className="codex-check-list codex-environment-checks">
                    <div><StatusPill ok={!envConflicts.environment.clashVergeTun.enabled}>Clash Verge TUN</StatusPill><span>{envConflicts.environment.clashVergeTun.enabled ? `已启用${envConflicts.environment.clashVergeTun.configPath ? ` · ${envConflicts.environment.clashVergeTun.configPath}` : ''}` : '未检测到启用状态'}</span></div>
                    <div><StatusPill ok={!envConflicts.environment.proxyEnvironment.variables.length}>代理环境变量</StatusPill><span>{envConflicts.environment.proxyEnvironment.variables.length ? envConflicts.environment.proxyEnvironment.variables.map((variable) => `${variable.name} · ${variable.source}`).join('，') : '未检测到'}</span></div>
                    <div><StatusPill ok={!envConflicts.environment.codexEnvFile.exists}>Codex .env</StatusPill><span>{envConflicts.environment.codexEnvFile.exists ? `已存在 · ${envConflicts.environment.codexEnvFile.path}` : '未检测到'}</span></div>
                  </div> : null}
                  {envConflicts?.environment ? <p className="codex-provider-maintenance-hint">TUN、代理变量和 .env 仅作只读提示，不会被“移除环境变量冲突”自动删除。</p> : null}
                  {relayFiles ? <details className="codex-raw-files"><summary>原始 config.toml / auth.json（包含敏感信息）</summary><div className="codex-form-grid"><Field label={`config.toml · ${relayFiles.configPath}`} wide><textarea rows={12} value={relayFiles.configContents} onChange={(event) => setRelayFiles((current) => current ? { ...current, configContents: event.target.value } : current)} /></Field><LoadingButton busy={busy === 'save-relay-config'} onClick={() => void saveRelayFile('config')}><Save size={14} />保存 config.toml</LoadingButton><Field label={`auth.json · ${relayFiles.authPath}`} wide><textarea rows={8} value={relayFiles.authContents} onChange={(event) => setRelayFiles((current) => current ? { ...current, authContents: event.target.value } : current)} /></Field><LoadingButton busy={busy === 'save-relay-auth'} onClick={() => void saveRelayFile('auth')}><Save size={14} />保存 auth.json</LoadingButton></div></details> : null}
                  </div>
                </details>
              </>
            ) : <EmptyState text="尚未创建 API 供应商。" />}
          </div>
        </div>
      ) : null}

      {section === '热切换' && settings ? (
        <HotSwitchPage
          settings={settings}
          status={hotSwitch}
          mappings={mappings}
          scan={mappingScan}
          busy={busy}
          onPatchSettings={patchSettings}
          onMappingsChange={setMappings}
          onToggle={(enabled) => void updateHotSwitch(enabled)}
          onScan={() => void scanMappings()}
          onInject={(relayIds) => void injectProviderModels(relayIds)}
          onSaveMappings={() => void saveMappings()}
          onSetAutoModelEnabled={(enabled) => void setAutoModelEnabled(enabled)}
          onSaveSettings={() => void saveSettings(settings)}
          onSetFloatingEnabled={(enabled) => void setFloatingEnabled(enabled)}
          onResetFloatingPosition={() => void resetFloatingPosition()}
        />
      ) : null}

      {section === '会话管理' ? <SessionsPage settings={settings} onSettingsChange={setSettings} /> : null}

      {section === '主题工坊' ? (
        <Suspense fallback={<div className="codex-loading-state">正在加载 Codex 主题工坊…</div>}>
          <ThemeStudioPage />
        </Suspense>
      ) : null}

      {section === '工具与插件' ? (
        <ToolsPluginsPage
          entries={contexts}
          localMarketplace={pluginStatus}
          remoteMarketplace={remotePluginStatus}
          busy={busy}
          onReadLive={() => void run('read-live-context', () => callCodex<CommandResult<{ entries: CodexContextEntries }>>('read_live_context_entries')).then((result) => { if (result) { setContexts(result.entries); setNotice(noticeFrom(result)) } })}
          onSyncLive={() => settings && void run('sync-live-context', () => callCodex<CommandResult<{ entries: CodexContextEntries }>>('sync_live_context_entries', { request: { settings } })).then((result) => { if (result) { setContexts(result.entries); setNotice(noticeFrom(result)) } })}
          onUpsert={upsertContext}
          onDelete={removeContext}
          onRefreshMarketplaces={() => void refreshPlugins()}
          onRepairMarketplace={(remote) => void repairPlugin(remote)}
        />
      ) : null}

      {section === 'Codex增强' && settings ? (
        <div className="codex-grid enhancements">
          <Panel title="功能开关" icon={<Sparkles size={18} />} action={<LoadingButton busy={busy === 'save-settings'} onClick={() => void saveSettings(settings)}><Save size={14} />保存</LoadingButton>} className="enhancement-panel">
            <div className="codex-switch-row codex-feature-master-switch"><div><strong>启用 Codex 增强</strong><span>作为全部增强能力的总开关；关闭不会清除下方单项配置。</span></div><button className={settings.enhancementsEnabled ? 'toggle on' : 'toggle'} type="button" onClick={() => patchSettings({ enhancementsEnabled: !settings.enhancementsEnabled })}><span /></button></div>
            <div className="codex-toggle-grid">{ENHANCEMENT_TOGGLES.map(([key, title, description]) => <div key={String(key)} className="codex-switch-row"><div><strong>{title}</strong><span>{description}</span></div><button className={settings[key] ? 'toggle on' : 'toggle'} type="button" onClick={() => patchSettings({ [key]: !settings[key] } as Partial<BackendSettings>)}><span /></button></div>)}</div>
          </Panel>
          <Panel title="分步处理" icon={<Activity size={18} />}>
            <div className="codex-switch-row"><div><strong>启用分步处理</strong><span>将长任务按步骤交给指定模型处理。</span></div><button className={settings.codexAppStepwiseEnabled ? 'toggle on' : 'toggle'} type="button" onClick={() => patchSettings({ codexAppStepwiseEnabled: !settings.codexAppStepwiseEnabled })}><span /></button></div>
            <div className="codex-switch-row"><div><strong>处理完成后直接发送</strong><span>关闭时仅填入结果，保留给你确认后再发送。</span></div><button className={settings.codexAppStepwiseDirectSend ? 'toggle on' : 'toggle'} type="button" onClick={() => patchSettings({ codexAppStepwiseDirectSend: !settings.codexAppStepwiseDirectSend })}><span /></button></div>
            <div className="codex-form-grid">
              <Field label="Base URL"><input value={settings.codexAppStepwiseBaseUrl} onChange={(event) => patchSettings({ codexAppStepwiseBaseUrl: event.target.value })} /></Field>
              <Field label="模型"><input value={settings.codexAppStepwiseModel} onChange={(event) => patchSettings({ codexAppStepwiseModel: event.target.value })} /></Field>
              <Field label="API Key"><input type="password" value={settings.codexAppStepwiseApiKey} onChange={(event) => patchSettings({ codexAppStepwiseApiKey: event.target.value })} /></Field>
              <Field label="Key 环境变量"><input value={settings.codexAppStepwiseApiKeyEnv} onChange={(event) => patchSettings({ codexAppStepwiseApiKeyEnv: event.target.value })} placeholder="例如 OPENAI_API_KEY" /></Field>
              <Field label="最大项目数"><input type="number" min={1} value={settings.codexAppStepwiseMaxItems} onChange={(event) => patchSettings({ codexAppStepwiseMaxItems: Number(event.target.value) })} /></Field>
              <Field label="最大输入字符"><input type="number" min={1} value={settings.codexAppStepwiseMaxInputChars} onChange={(event) => patchSettings({ codexAppStepwiseMaxInputChars: Number(event.target.value) })} /></Field>
              <Field label="最大输出 Token"><input type="number" min={1} value={settings.codexAppStepwiseMaxOutputTokens} onChange={(event) => patchSettings({ codexAppStepwiseMaxOutputTokens: Number(event.target.value) })} /></Field>
              <Field label="超时（ms）"><input type="number" value={settings.codexAppStepwiseTimeoutMs} onChange={(event) => patchSettings({ codexAppStepwiseTimeoutMs: Number(event.target.value) })} /></Field>
            </div>
            <div className="codex-toolbar"><LoadingButton busy={busy === 'test_stepwise_settings'} onClick={() => void runSimple('test_stepwise_settings', { settings })}><Activity size={14} />测试分步处理</LoadingButton><LoadingButton busy={busy === 'save-settings'} onClick={() => void saveSettings(settings)}><Save size={14} />保存设置</LoadingButton></div>
          </Panel>
          <Panel title="图片覆盖层" icon={<Sparkles size={18} />}>
            <div className="codex-switch-row"><div><strong>启用图片覆盖</strong><span>在 Codex 客户端背景中显示指定图片。</span></div><button className={settings.codexAppImageOverlayEnabled ? 'toggle on' : 'toggle'} type="button" onClick={() => patchSettings({ codexAppImageOverlayEnabled: !settings.codexAppImageOverlayEnabled })}><span /></button></div>
            <div className="codex-form-grid">
              <Field label="图片路径" wide><input value={settings.codexAppImageOverlayPath} onChange={(event) => patchSettings({ codexAppImageOverlayPath: event.target.value })} /></Field>
              <Field label="透明度（1-100）"><input type="number" min={1} max={100} value={settings.codexAppImageOverlayOpacity} onChange={(event) => patchSettings({ codexAppImageOverlayOpacity: Number(event.target.value) })} /></Field>
              <Field label="显示方式"><select value={settings.codexAppImageOverlayFitMode} onChange={(event) => patchSettings({ codexAppImageOverlayFitMode: event.target.value })}><option value="fit">适应</option><option value="fill">填充</option><option value="stretch">拉伸</option><option value="tile">平铺</option><option value="center">居中</option></select></Field>
            </div>
            <div className="codex-toolbar"><LoadingButton busy={busy === 'save-settings'} onClick={() => void saveSettings(settings)}><Save size={14} />保存覆盖层</LoadingButton><LoadingButton busy={busy === 'reset_image_overlay_settings'} onClick={() => void run('reset_image_overlay_settings', () => callCodex<SettingsResult>('reset_image_overlay_settings')).then((result) => { if (result) { setSettingsResult(result); acceptSettings(result); setNotice(noticeFrom(result)) } })}>恢复默认</LoadingButton></div>
          </Panel>
        </div>
      ) : null}

      {section === '脚本市场' ? (
        <ScriptMarketPage
          settingsResult={settingsResult}
          onSettingsResultChange={(result) => {
            setSettingsResult(result)
            acceptSettings(result)
          }}
        />
      ) : null}

      {section === '设置' && settings ? (
        <div className="codex-grid settings">
          <Panel title="Codex 路径与启动" icon={<Settings2 size={18} />} action={<LoadingButton busy={busy === 'save-settings'} onClick={() => void saveSettings(settings)}><Save size={14} />保存</LoadingButton>}>
            <div className="codex-form-grid single">
              <Field label="Codex 应用路径" wide><input value={settings.codexAppPath} onChange={(event) => patchSettings({ codexAppPath: event.target.value })} /></Field>
              <Field label="启动模式"><select value={settings.launchMode} onChange={(event) => patchSettings({ launchMode: event.target.value as BackendSettings['launchMode'] })}><option value="patch">增强补丁模式</option><option value="relay">中转模式</option></select></Field>
              <Field label="额外启动参数"><input value={settings.codexExtraArgs.join(' ')} onChange={(event) => patchSettings({ codexExtraArgs: event.target.value.split(/\s+/).filter(Boolean) })} /></Field>
            </div>
          </Panel>
          <div className="codex-settings-side-stack">
            <Panel title="后台守护" icon={<ShieldCheck size={18} />}>
              <div className="codex-switch-row"><div><strong>Watcher</strong><span>{watcher?.registrationValid ? watcher.running ? '后台守护正在运行' : watcher.enabled ? '后台守护已启用，当前未运行' : '后台守护已停用' : watcher?.installed ? '启动注册需要修复' : '后台守护未安装'}</span></div><StatusPill ok={Boolean(watcher?.running)}>{watcher?.running ? '运行中' : watcher?.enabled ? '待启动' : '已停止'}</StatusPill></div>
              <div className="codex-toolbar"><LoadingButton busy={busy === 'load_watcher_state'} onClick={() => void run('load_watcher_state', () => callCodex<WatcherResult>('load_watcher_state')).then((result) => result && setWatcher(result))}>检测</LoadingButton><LoadingButton busy={busy === 'install_watcher'} onClick={() => void run('install_watcher', () => callCodex<WatcherResult>('install_watcher')).then((result) => { if (result) { setWatcher(result); setNotice(noticeFrom(result)) } })}>安装</LoadingButton><LoadingButton busy={busy === 'enable_watcher'} onClick={() => void run('enable_watcher', () => callCodex<WatcherResult>('enable_watcher')).then((result) => { if (result) { setWatcher(result); setNotice(noticeFrom(result)) } })}>启用</LoadingButton><LoadingButton busy={busy === 'disable_watcher'} onClick={() => void run('disable_watcher', () => callCodex<WatcherResult>('disable_watcher')).then((result) => { if (result) { setWatcher(result); setNotice(noticeFrom(result)) } })}>停用</LoadingButton></div>
            </Panel>
            <Panel title="危险操作" icon={<CircleAlert size={18} />}>
              <div className="codex-danger-zone"><div><strong>重置 Codex 功能设置</strong><span>不会删除 Codex Compass 的中转站监控配置。</span></div><LoadingButton busy={busy === 'reset_settings'} className="danger" onClick={() => void run('reset_settings', () => callCodex<SettingsResult>('reset_settings')).then((result) => { if (result) { setSettingsResult(result); acceptSettings(result); setNotice(noticeFrom(result)) } })}><Trash2 size={14} />重置</LoadingButton></div>
            </Panel>
          </div>
          <Panel title="更新与诊断" icon={<Wrench size={18} />}>
            <p className="codex-result-text">更新源已连接到 GitHub Releases：CharlesWang505/Codex_Ultura。只会识别并下载该仓库发布的 Codex Compass 安装包。</p>
            <div className="codex-toolbar">
              <LoadingButton busy={busy === 'check_update'} onClick={() => void run('check_update', () => callCodex<UpdateResult>('check_update')).then((result) => { if (result) { setUpdate(result); setNotice(noticeFrom(result)) } })}><RefreshCw size={14} />检查更新</LoadingButton>
              <LoadingButton busy={busy === 'perform_update'} disabled={!update?.updateAvailable || !update.latestVersion || !update.assetUrl} onClick={() => update?.latestVersion && void run('perform_update', () => callCodex<UpdateResult>('perform_update', { release: { version: update.latestVersion, url: '', body: update.releaseSummary ?? '', asset_name: update.assetName ?? null, asset_url: update.assetUrl ?? null } })).then((result) => { if (result) { setUpdate(result); setNotice(noticeFrom(result)) } })}>下载安装</LoadingButton>
              <LoadingButton busy={busy === 'read_latest_logs'} onClick={() => void run('read_latest_logs', () => callCodex<LogsResult>('read_latest_logs', { request: { lines: 240 } })).then((result) => result && setLogs(result))}>读取日志</LoadingButton>
              <LoadingButton busy={busy === 'clear_logs'} className="danger" onClick={() => void run('clear_logs', () => callCodex<LogsResult>('clear_logs')).then((result) => result && setLogs(result))}><Trash2 size={14} />清理日志</LoadingButton>
              <LoadingButton busy={busy === 'copy_diagnostics'} onClick={() => void run('copy_diagnostics', () => callCodex<DiagnosticsResult>('copy_diagnostics')).then((result) => { if (result) { setDiagnostics(result); setNotice(noticeFrom(result)) } })}>复制诊断</LoadingButton>
            </div>
            {update ? <p className="codex-result-text">当前 {update.currentVersion}，最新 {update.latestVersion ?? '未知'}。{update.releaseSummary ?? ''}</p> : null}
            {logs ? <><p className="codex-result-text">日志文件：{logs.fileSize} 字节{logs.truncated ? '；当前仅显示文件尾部' : ''}</p><textarea className="codex-log-output" readOnly rows={12} value={logs.text} /></> : null}
            {diagnostics ? <textarea className="codex-log-output" readOnly rows={8} value={diagnostics.report} /> : null}
          </Panel>
        </div>
      ) : null}
    </div>
  )
}
