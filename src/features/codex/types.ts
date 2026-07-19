export type CommandStatus = 'ok' | 'warning' | 'failed' | 'not_checked' | string

export type CommandResult<T extends object = Record<string, never>> = T & {
  status: CommandStatus
  message: string
}

export type RelayProtocol = 'responses' | 'chatCompletions' | 'anthropic' | 'gemini'
export type RelayMode = 'official' | 'mixedApi' | 'pureApi' | 'aggregate'
export type AggregateRelayStrategy = 'failover' | 'conversationRoundRobin' | 'requestRoundRobin' | 'weightedRoundRobin'

export type AggregateRelayMember = {
  relayId: string
  weight: number
}

export type AggregateRelayProfile = {
  id: string
  name: string
  strategy: AggregateRelayStrategy
  members: AggregateRelayMember[]
}
export type ReasoningDialect =
  | 'inherit'
  | 'openai'
  | 'openrouter'
  | 'qwen'
  | 'siliconflow'
  | 'none'

export type RelayContextSelection = {
  mcpServers: string[]
  skills: string[]
  plugins: string[]
}

export type RelayProfile = {
  id: string
  name: string
  model?: string
  baseUrl?: string
  upstreamBaseUrl: string
  apiKey?: string
  protocol: RelayProtocol
  relayMode: RelayMode
  officialMixApiKey: boolean
  testModel: string
  configContents: string
  authContents: string
  useCommonConfig: boolean
  contextSelection: RelayContextSelection
  contextSelectionInitialized: boolean
  contextWindow: string
  autoCompactLimit: string
  modelInsertMode?: 'patch' | 'modelCatalog'
  modelList: string
  modelWindows: string
  modelVlm: string
  vlmApiKey?: string
  vlmApiKeySaved?: boolean
  vlmModel: string
  vlmBaseUrl: string
  userAgent: string
  reasoningDialect?: ReasoningDialect
}

export type HotSwitchModelMapping = {
  model: string
  upstreamModel: string
  relayId: string
  candidateRelayIds: string[]
  fallbackRelayIds?: string[]
  reasoningOverride?: string
}

export type BackendSettings = {
  codexAppPath: string
  codexExtraArgs: string[]
  providerSyncEnabled: boolean
  providerSyncSavedProviders: string[]
  providerSyncManualProviders: string[]
  providerSyncLastSelectedProvider: string
  relayProfilesEnabled: boolean
  enhancementsEnabled: boolean
  computerUseGuardEnabled: boolean
  codexAppPluginMarketplaceUnlock: boolean
  codexAppPluginAutoExpand: boolean
  codexAppModelWhitelistUnlock: boolean
  codexAppSessionDelete: boolean
  codexAppMarkdownExport: boolean
  codexAppPasteFix: boolean
  codexAppForceChineseLocale: boolean
  codexAppFastStartup: boolean
  codexAppProjectMove: boolean
  codexAppThreadIdBadge: boolean
  codexAppConversationView: boolean
  codexAppThreadScrollRestore: boolean
  codexAppUpstreamWorktreeCreate: boolean
  codexAppNativeMenuPlacement: boolean
  codexAppNativeMenuLocalization: boolean
  codexAppServiceTierControls: boolean
  codexAppStepwiseEnabled: boolean
  codexAppStepwiseDirectSend: boolean
  codexAppStepwiseBaseUrl: string
  codexAppStepwiseApiKey: string
  codexAppStepwiseApiKeyEnv: string
  codexAppStepwiseModel: string
  codexAppStepwiseMaxItems: number
  codexAppStepwiseMaxInputChars: number
  codexAppStepwiseMaxOutputTokens: number
  codexAppStepwiseTimeoutMs: number
  codexAppImageOverlayEnabled: boolean
  codexAppImageOverlayPath: string
  codexAppImageOverlayOpacity: number
  codexAppImageOverlayFitMode: string
  codexGoalsEnabled: boolean
  launchMode: 'patch' | 'relay'
  relayBaseUrl: string
  relayApiKey: string
  relayProfiles: RelayProfile[]
  aggregateRelayProfiles: AggregateRelayProfile[]
  activeAggregateRelayId: string
  relayCommonConfigContents: string
  relayContextConfigContents: string
  activeRelayId: string
  hotSwitchEnabled: boolean
  hotSwitchRequestBodyLimitMib: number
  hotSwitchRelayId: string
  hotSwitchModel: string
  hotSwitchModelRoutingEnabled: boolean
  hotSwitchAutoModelEnabled: boolean
  hotSwitchModelMappings: HotSwitchModelMapping[]
  relayTestModel: string
  floatingSwitchEnabled?: boolean
  floatingSwitchPosition?: { x: number; y: number } | null
  defaultReasoning?: string
}

export type SettingsResult = CommandResult<{
  settings: BackendSettings
  settingsPath: string
  userScripts: UserScriptInventory
}>

export type OverviewResult = CommandResult<{
  codexApp: { status: string; path: string | null }
  codexVersion: string | null
  silentShortcut: { status: string; path: string | null }
  managementShortcut: { status: string; path: string | null }
  latestLaunch: { status: string; message: string } | null
  currentVersion: string
  updateStatus: string
  settingsPath: string
  logsPath: string
}>

export type HotSwitchResult = CommandResult<{
  enabled: boolean
  running: boolean
  baseUrl: string
  relayId: string
  relayName: string
  model: string
  error: string | null
  settings: BackendSettings
  settingsPath: string
}>

export type HotSwitchProviderScan = {
  relayId: string
  relayName: string
  endpoint: string
  models: string[]
  error: string
}

export type HotSwitchMappingResult = CommandResult<{
  settings: BackendSettings
  settingsPath: string
  mappings: HotSwitchModelMapping[]
  providers: HotSwitchProviderScan[]
  conflictCount: number
  failedProviderCount: number
}>

export type RelayActionResult = CommandResult<{
  authenticated: boolean
  authSource: string
  accountLabel: string | null
  configPath: string
  configured: boolean
  requiresOpenaiAuth: boolean
  hasBearerToken: boolean
  backupPath: string | null
}>

export type RelayProfileModelsResult = CommandResult<{ models: string[]; endpoint: string }>
export type RelayProfileTestResult = CommandResult<{ httpStatus: number; endpoint: string; responsePreview: string }>
export type ProviderDoctorResult = CommandResult<{
  profileName: string
  model: string
  summary: string
  recommendation: string
  checks: Array<{ id: string; title: string; status: string; detail: string }>
}>

export type LocalSession = {
  id: string
  title: string
  cwd: string
  modelProvider: string
  archived: boolean
  updatedAtMs: number | null
  rolloutPath: string
  dbPath: string
}

export type LocalSessionsResult = CommandResult<{
  dbPath: string
  dbPaths: string[]
  sessions: LocalSession[]
  offset: number
  limit: number
  hasMore: boolean
}>

export type CodexContextEntry = {
  id: string
  kind: 'mcp' | 'skill' | 'plugin'
  title: string
  summary: string
  tomlBody: string
  enabled: boolean
}

export type CodexContextEntries = {
  mcpServers: CodexContextEntry[]
  skills: CodexContextEntry[]
  plugins: CodexContextEntry[]
}

export type ContextEntriesResult = CommandResult<{
  settings: BackendSettings
  entries: CodexContextEntries
}>

export type UserScriptInventory = {
  enabled?: boolean
  scripts?: Array<{
    key: string
    name: string
    source: string
    enabled: boolean
    status: string
    error: string
    statusMessage?: string
    marketId?: string
    version?: string
    installed?: boolean
    sourceUrl?: string
    homepage?: string
  }>
}

export type ScriptMarketItem = {
  id: string
  name: string
  description: string
  version: string
  author: string
  tags: string[]
  homepage: string
  installed: boolean
  installedVersion: string
  updateAvailable: boolean
}

export type ScriptMarketResult = CommandResult<{
  market: {
    status: string
    message: string
    indexUrl: string
    updatedAt: string
    scripts: ScriptMarketItem[]
  }
  userScripts: UserScriptInventory
}>

export type WatcherResult = CommandResult<{
  installed: boolean
  enabled: boolean
  running: boolean
  registrationValid: boolean
  launcherPath: string
  processId: number | null
  lastError: string | null
  disabledFlag: string
}>
export type LogsResult = CommandResult<{
  path: string
  text: string
  lines: number
  truncated: boolean
  fileSize: number
}>
export type DiagnosticsResult = CommandResult<{ report: string }>
export type InstallResult = CommandResult<{
  silentShortcut: { installed: boolean; path: string | null }
  managementShortcut: { installed: boolean; path: string | null }
}>
export type UpdateResult = CommandResult<{
  currentVersion: string
  latestVersion?: string | null
  releaseSummary?: string
  assetName?: string | null
  assetUrl?: string | null
  updateAvailable?: boolean
  automaticUpdateConfigured?: boolean
  updateRepository?: string
  installedPath?: string
  launched?: boolean
  progress?: number
}>

export type PluginStatusResult = CommandResult<{
  codexHome: string
  marketplaceRoot?: string | null
  configRegistered?: boolean
  initialized?: boolean
  configured?: boolean
  needsRepair: boolean
  pluginCount?: number
  skillCount?: number
}>
