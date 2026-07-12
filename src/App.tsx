import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import {
  Activity,
  AlertTriangle,
  BarChart3,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Database,
  Download,
  Edit3,
  Eye,
  EyeOff,
  Gauge,
  Inbox,
  Info,
  KeyRound,
  LayoutDashboard,
  MessageCircle,
  Minimize2,
  Minus,
  Moon,
  Network,
  Palette,
  Plus,
  Power,
  RefreshCw,
  Save,
  Search,
  Server,
  Settings,
  ShieldCheck,
  Square,
  SlidersHorizontal,
  Sun,
  Trash2,
  Upload,
  WalletCards,
  X,
  Zap,
} from 'lucide-react'
import { getCurrentWindow } from '@tauri-apps/api/window'
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Pie,
  PieChart,
  PolarAngleAxis,
  PolarGrid,
  PolarRadiusAxis,
  Radar,
  RadarChart,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
  ZAxis,
} from 'recharts'
import './App.css'
import { callCodex } from './features/codex/api'
import type { CodexSection } from './features/codex/CodexWorkspace'
import { fetchUsageSnapshot, loginNewApi, type NewApiLoginResult, type UsageFetchProgress } from './lib/relayApi'
import { createDemoSnapshot } from './lib/sampleData'
import { computeAnalytics, safeDivide } from './lib/analytics'
import { buildTimeWindow, DAY_MS, timeWindowKey, type TimeRange, type TimeWindow } from './lib/timeWindow'
import { chartTheme, useTheme } from './lib/theme'
import {
  getAppVersion,
  isTauriRuntime,
  listenForCloseRequest,
  loadAppPreferences,
  resolveCloseRequest,
  saveCloseBehavior,
  type CloseBehavior,
  type CloseResolution,
} from './lib/desktop'
import { createBlankSite, initializeSiteStorage, loadSelectedSiteId, loadSites, saveSelectedSiteId, saveSites } from './lib/storage'
import type { ApiKeyProbe, ApiKeyProbeResult, AvailabilityStatus, EndpointSource, GroupRate, ModelUsage, RelaySite, TokenRecord, TrendPoint, UsageLog, UsageSnapshot, UsageSummary } from './types'
import type { LucideIcon } from 'lucide-react'

const initialSites = loadSites()
const initialSiteId = loadSelectedSiteId(initialSites) ?? initialSites[0].id
const ProxyLatencyPanel = lazy(() => import('./features/proxyLatency/ProxyLatencyPanel').then((module) => ({ default: module.ProxyLatencyPanel })))
const CodexWorkspace = lazy(() => import('./features/codex/CodexWorkspace').then((module) => ({ default: module.CodexWorkspace })))
const palette = ['#2f7df6', '#11b6a0', '#f7b723', '#8b5cf6', '#f4779a', '#35c4d6', '#f4cc82']
const MODEL_CHART_MAX_ITEMS = 8
const MODEL_CHART_MIN_SHARE = 0.01
const navItems: Array<[string, LucideIcon]> = [
  ['概览', LayoutDashboard],
  ['分析', BarChart3],
  ['供应商配置', Server],
  ['热切换', Zap],
  ['会话管理', MessageCircle],
  ['工具与插件', Network],
  ['Codex增强', ShieldCheck],
  ['脚本市场', Download],
  ['代理测速', Network],
  ['设置', Settings],
]

const CODEX_SECTIONS = new Set<CodexSection>([
  '概览',
  '供应商配置',
  '热切换',
  '会话管理',
  '工具与插件',
  'Codex增强',
  '脚本市场',
  '设置',
])

type WindowAction = 'close' | 'minimize' | 'toggleMaximize'

type RefreshProgressState = {
  loadedLogs: number
  totalLogs?: number
  groupsReady: boolean
  completedKeyChecks: number
  totalKeyChecks?: number
}

function runWindowAction(action: WindowAction) {
  if (!isTauriRuntime()) {
    return
  }

  const appWindow = getCurrentWindow()
  const operation = action === 'close'
    ? appWindow.close()
    : action === 'minimize'
      ? appWindow.minimize()
      : appWindow.toggleMaximize()

  void operation.catch(() => undefined)
}

function WindowControls() {
  return (
    <div className="window-controls" aria-label="窗口控制">
      <button className="window-control" type="button" aria-label="最小化" title="最小化" onClick={() => runWindowAction('minimize')}>
        <Minus size={15} />
      </button>
      <button className="window-control" type="button" aria-label="最大化或还原" title="最大化或还原" onClick={() => runWindowAction('toggleMaximize')}>
        <Square size={12} />
      </button>
      <button className="window-control window-close" type="button" aria-label="关闭" title="关闭" onClick={() => runWindowAction('close')}>
        <X size={15} />
      </button>
    </div>
  )
}

function formatCny(value: number) {
  return `¥${value.toLocaleString('zh-CN', { maximumFractionDigits: 2, minimumFractionDigits: 2 })}`
}

function formatUsd(value: number) {
  return `$${value.toLocaleString('en-US', { maximumFractionDigits: 4, minimumFractionDigits: 4 })}`
}

function formatNumber(value: number) {
  return value.toLocaleString('zh-CN', { maximumFractionDigits: 0 })
}

function formatCompact(value: number) {
  return value.toLocaleString('zh-CN', { notation: 'compact', maximumFractionDigits: 2 })
}

function formatRatio(value: number | undefined) {
  if (!Number.isFinite(value)) {
    return '-'
  }
  const rounded = Math.round((Number(value) + Number.EPSILON) * 1000) / 1000
  return `${rounded.toFixed(3)}x`
}

function formatDecimal(value: number) {
  return value.toLocaleString('zh-CN', { maximumFractionDigits: 6 })
}

function formatLatency(value: number) {
  return value > 0 ? `${(value / 1000).toFixed(2)}s` : '-'
}

type TimingLevel = 'good' | 'warn' | 'bad' | 'unknown'

function formatTimingBadge(value: number) {
  if (!(value > 0)) {
    return '-'
  }
  const seconds = value / 1000
  if (seconds >= 60) {
    const minutes = Math.floor(seconds / 60)
    const remainingSeconds = Math.round(seconds % 60)
    return `${minutes}m ${remainingSeconds}s`
  }
  return `${seconds.toFixed(1)}s`
}

function totalTimingLevel(log: UsageLog): TimingLevel {
  if (!(log.latencyMs > 0)) {
    return 'unknown'
  }
  const speed = log.outputTokensPerSecond
  if (Number.isFinite(speed) && Number(speed) > 0) {
    if (Number(speed) >= 25) return 'good'
    if (log.latencyMs <= 20_000 || Number(speed) >= 10) return 'warn'
    return 'bad'
  }
  if (log.latencyMs <= 15_000) return 'good'
  if (log.latencyMs <= 45_000) return 'warn'
  return 'bad'
}

function firstTokenTimingLevel(value: number): TimingLevel {
  if (!(value > 0)) return 'unknown'
  if (value <= 5_000) return 'good'
  if (value <= 10_000) return 'warn'
  return 'bad'
}

function formatResponseTiming(log: UsageLog) {
  const total = formatTimingBadge(log.latencyMs)
  const firstToken = formatTimingBadge(log.firstTokenMs)
  return firstToken === '-' ? total : `${total}（FRT: ${firstToken}）`
}

function formatLogTime(value: string) {
  const timestamp = parseDisplayTime(value)
  if (timestamp === undefined) {
    return value
  }
  const date = new Date(timestamp)
  const pad = (item: number) => String(item).padStart(2, '0')
  const datePart = date.getFullYear() === new Date().getFullYear()
    ? `${pad(date.getMonth() + 1)}/${pad(date.getDate())}`
    : `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())}`
  return `${datePart} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

function formatConversationType(isStream: boolean | undefined) {
  return isStream === true ? '流式' : isStream === false ? '非流式' : '-'
}

function formatOutputSpeed(value: number | undefined) {
  return Number.isFinite(value) && Number(value) > 0 ? `${Math.round(Number(value))} t/s` : '-'
}

function formatConversationMeta(log: UsageLog) {
  const parts = []
  const conversationType = formatConversationType(log.isStream)
  const outputSpeed = formatOutputSpeed(log.outputTokensPerSecond)
  if (conversationType !== '-') parts.push(conversationType)
  if (outputSpeed !== '-') parts.push(outputSpeed)
  return parts.join(' · ') || '-'
}

function logStatusText(status: UsageLog['status']) {
  if (status === 'error') return '失败'
  if (status === 'cached') return '缓存命中'
  return '成功'
}

function logStatusTitle(log: UsageLog) {
  if (log.status !== 'error') {
    return logStatusText(log.status)
  }
  const code = log.errorCode !== undefined ? `HTTP ${log.errorCode}` : '失败'
  return log.errorMessage ? `${code}：${log.errorMessage}` : code
}

function parseDisplayTime(time: string) {
  const trimmed = time.trim()
  if (!trimmed) {
    return undefined
  }

  const hasTimezone = /(?:z|[+-]\d{2}:?\d{2})$/i.test(trimmed)
  if (hasTimezone) {
    const parsed = Date.parse(trimmed)
    if (!Number.isNaN(parsed)) {
      return parsed
    }
  }

  const withYear = /^\d{1,2}[/-]\d{1,2}(?:\s|$)/.test(trimmed) ? `${new Date().getFullYear()}/${trimmed}` : trimmed
  const normalized = withYear
    .replace(/[年月.-]/g, '/')
    .replace(/日/g, ' ')
    .replace('T', ' ')
    .trim()
  const match = normalized.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})(?:\s+(\d{1,2})(?::(\d{1,2})(?::(\d{1,2}))?)?)?/)
  if (match) {
    const [, year, month, day, hour = '0', minute = '0', second = '0'] = match
    const parsed = new Date(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second)).getTime()
    if (Number.isFinite(parsed)) {
      return parsed
    }
  }

  const parsed = Date.parse(withYear)
  return Number.isNaN(parsed) ? undefined : parsed
}

function trendSortValue(time: string) {
  return parseDisplayTime(time) ?? Number.MAX_SAFE_INTEGER
}

type ModelChartPoint = ModelUsage & {
  label: string
  mergedCount?: number
}

const MINUTE_MS = 60 * 1000
const HOUR_MS = 60 * MINUTE_MS

function formatDateTimeInput(value: number) {
  const date = new Date(value)
  const pad = (item: number) => String(item).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function isInTimeWindow(time: string, window: TimeWindow) {
  const value = parseDisplayTime(time)
  if (value === undefined || !Number.isFinite(value)) {
    return false
  }
  return value >= window.startMs && value <= window.endMs
}

const EMPTY_SUMMARY: UsageSummary = {
  realTokens: 0,
  cost: 0,
  cacheCreation: 0,
  cacheHit: 0,
  input: 0,
  output: 0,
  cacheHitRate: 0,
  totalRequests: 0,
}

function trendBucketSize(range: TimeRange, window: TimeWindow) {
  if (range === '7d' || range === '30d') {
    return HOUR_MS
  }
  if (range === 'custom') {
    const span = window.endMs - window.startMs
    if (span > DAY_MS) {
      return HOUR_MS
    }
  }
  return MINUTE_MS
}

function floorTrendBucket(timestamp: number, bucketMs: number) {
  const date = new Date(timestamp)
  if (bucketMs >= DAY_MS) {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
  }
  if (bucketMs < HOUR_MS) {
    const bucketMinutes = Math.max(1, Math.round(bucketMs / MINUTE_MS))
    const minute = Math.floor(date.getMinutes() / bucketMinutes) * bucketMinutes
    return new Date(date.getFullYear(), date.getMonth(), date.getDate(), date.getHours(), minute).getTime()
  }
  const bucketHours = Math.max(1, Math.round(bucketMs / HOUR_MS))
  const hour = Math.floor(date.getHours() / bucketHours) * bucketHours
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), hour).getTime()
}

function formatTrendBucket(timestamp: number, bucketMs: number) {
  const date = new Date(timestamp)
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  if (bucketMs >= DAY_MS) {
    return `${month}/${day}`
  }
  if (bucketMs < HOUR_MS) {
    return `${month}/${day} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
  }
  return `${month}/${day} ${String(date.getHours()).padStart(2, '0')}:00`
}

function trendBucket(time: string, bucketMs: number) {
  const timestamp = trendSortValue(time)
  if (Number.isFinite(timestamp) && timestamp !== Number.MAX_SAFE_INTEGER) {
    const bucketStart = floorTrendBucket(timestamp, bucketMs)
    return {
      label: formatTrendBucket(bucketStart, bucketMs),
      sortValue: bucketStart,
    }
  }
  return {
    label: time.slice(0, 16),
    sortValue: Number.MAX_SAFE_INTEGER,
  }
}

function firstTrendAxisTick(timestamp: number, bucketMs: number) {
  const date = new Date(timestamp)
  if (bucketMs <= MINUTE_MS) {
    date.setMinutes(0, 0, 0)
    if (date.getTime() < timestamp) {
      date.setHours(date.getHours() + 1)
    }
    return date.getTime()
  }
  date.setHours(0, 0, 0, 0)
  if (date.getTime() < timestamp) {
    date.setDate(date.getDate() + 1)
  }
  return date.getTime()
}

function buildTrendAxisTicks(window: TimeWindow, bucketMs: number) {
  if (!window.valid) {
    return []
  }
  const ticks: string[] = []
  const stepMs = bucketMs <= MINUTE_MS ? HOUR_MS : DAY_MS
  for (let timestamp = firstTrendAxisTick(window.startMs, bucketMs); timestamp <= window.endMs; timestamp += stepMs) {
    ticks.push(formatTrendBucket(timestamp, bucketMs))
  }
  return ticks
}

function formatTrendAxisTick(value: string, bucketMs: number) {
  return bucketMs <= MINUTE_MS ? value.slice(-5) : value.slice(0, 5)
}

const TREND_METRICS: Array<keyof Omit<TrendPoint, 'time'>> = [
  'tokens',
  'cost',
  'cacheCreation',
  'cacheHit',
  'input',
  'output',
]

function smoothTrendPoints(points: TrendPoint[], bucketMs: number) {
  if (points.length < 3) {
    return points
  }
  const radius = bucketMs <= MINUTE_MS ? 2 : 1
  return points.map((point, index) => {
    const start = Math.max(0, index - radius)
    const end = Math.min(points.length - 1, index + radius)
    const count = end - start + 1
    const smoothed = { ...point }
    TREND_METRICS.forEach((metric) => {
      let total = 0
      for (let cursor = start; cursor <= end; cursor += 1) {
        total += points[cursor][metric]
      }
      smoothed[metric] = total / count
    })
    return smoothed
  })
}

function computeScopedUsage(logs: UsageLog[], groups: GroupRate[], bucketMs: number, window: TimeWindow) {
  const summary = logs.reduce<UsageSummary>(
    (total, log) => ({
      realTokens: total.realTokens + log.total,
      cost: total.cost + log.cost,
      cacheCreation: total.cacheCreation + log.cacheCreation,
      cacheHit: total.cacheHit + log.cacheHit,
      input: total.input + log.input,
      output: total.output + log.output,
      cacheHitRate: 0,
      totalRequests: total.totalRequests + 1,
    }),
    { ...EMPTY_SUMMARY },
  )
  summary.cacheHitRate = summary.input > 0 ? summary.cacheHit / summary.input : 0

  const trendMap = new Map<string, TrendPoint>()
  const trendSortMap = new Map<string, number>()
  const modelMap = new Map<string, ModelUsage>()
  const ratioMap = new Map(groups.map((group) => [group.model, group.ratio]))

  logs.forEach((log) => {
    const bucket = trendBucket(log.time, bucketMs)
    const trend = trendMap.get(bucket.label) ?? {
      time: bucket.label,
      tokens: 0,
      cost: 0,
      cacheCreation: 0,
      cacheHit: 0,
      input: 0,
      output: 0,
    }
    trend.tokens += log.total
    trend.cost += log.cost
    trend.cacheCreation += log.cacheCreation
    trend.cacheHit += log.cacheHit
    trend.input += log.input
    trend.output += log.output
    trendMap.set(bucket.label, trend)
    if (Number.isFinite(bucket.sortValue) && bucket.sortValue !== Number.MAX_SAFE_INTEGER) {
      trendSortMap.set(bucket.label, Math.min(trendSortMap.get(bucket.label) ?? bucket.sortValue, bucket.sortValue))
    }

    const model = modelMap.get(log.model) ?? {
      model: log.model,
      group: log.group,
      tokens: 0,
      cost: 0,
      input: 0,
      output: 0,
      cacheCreation: 0,
      cacheHit: 0,
      requests: 0,
      ratio: ratioMap.get(log.model),
    }
    model.tokens += log.total
    model.cost += log.cost
    model.input += log.input
    model.output += log.output
    model.cacheCreation += log.cacheCreation
    model.cacheHit += log.cacheHit
    model.requests += 1
    modelMap.set(log.model, model)
  })

  if (window.valid) {
    const startBucket = floorTrendBucket(window.startMs, bucketMs)
    const endBucket = floorTrendBucket(window.endMs, bucketMs)
    for (let timestamp = startBucket; timestamp <= endBucket; timestamp += bucketMs) {
      const label = formatTrendBucket(timestamp, bucketMs)
      if (!trendMap.has(label)) {
        trendMap.set(label, {
          time: label,
          tokens: 0,
          cost: 0,
          cacheCreation: 0,
          cacheHit: 0,
          input: 0,
          output: 0,
        })
      }
      trendSortMap.set(label, timestamp)
    }
  }

  return {
    summary,
    trends: Array.from(trendMap.values()).sort((a, b) => {
      return (trendSortMap.get(a.time) ?? Number.MAX_SAFE_INTEGER) - (trendSortMap.get(b.time) ?? Number.MAX_SAFE_INTEGER)
    }),
    models: Array.from(modelMap.values()).sort((a, b) => b.cost - a.cost),
  }
}

function compactModelLabel(model: string) {
  if (model === '其他模型') {
    return model
  }
  const cleaned = model
    .replace(/-(20\d{6}|20\d{2}-\d{2}-\d{2})$/u, '')
    .replace(/-(preview|latest)$/iu, '')
  if (cleaned.length <= 18) {
    return cleaned
  }
  return `${cleaned.slice(0, 11)}…${cleaned.slice(-5)}`
}

function buildModelChartData(models: ModelUsage[]) {
  const sorted = [...models]
    .filter((model) => model.cost > 0 || model.tokens > 0 || model.input > 0 || model.output > 0)
    .sort((a, b) => b.cost - a.cost || b.tokens - a.tokens)
  const totalCost = sorted.reduce((sum, model) => sum + model.cost, 0)
  const totalTokens = sorted.reduce((sum, model) => sum + model.tokens, 0)

  const visible: ModelUsage[] = []
  const hidden: ModelUsage[] = []

  sorted.forEach((model, index) => {
    const share = totalCost > 0 ? safeDivide(model.cost, totalCost) : safeDivide(model.tokens, totalTokens)
    const keep = index === 0 || (visible.length < MODEL_CHART_MAX_ITEMS && share >= MODEL_CHART_MIN_SHARE)
    if (keep) {
      visible.push(model)
    } else {
      hidden.push(model)
    }
  })

  const points: ModelChartPoint[] = visible.map((model) => ({
    ...model,
    label: compactModelLabel(model.model),
  }))

  if (hidden.length > 0) {
    points.push({
      model: `其他模型（${hidden.length} 个低消耗）`,
      label: '其他模型',
      group: 'other',
      tokens: hidden.reduce((sum, model) => sum + model.tokens, 0),
      cost: hidden.reduce((sum, model) => sum + model.cost, 0),
      input: hidden.reduce((sum, model) => sum + model.input, 0),
      output: hidden.reduce((sum, model) => sum + model.output, 0),
      cacheCreation: hidden.reduce((sum, model) => sum + model.cacheCreation, 0),
      cacheHit: hidden.reduce((sum, model) => sum + model.cacheHit, 0),
      requests: hidden.reduce((sum, model) => sum + model.requests, 0),
      mergedCount: hidden.length,
    })
  }

  return {
    points,
    hiddenCount: hidden.length,
    visibleCount: points.length,
  }
}

function modelChartTooltipLabel(label: unknown, payload: unknown) {
  if (Array.isArray(payload)) {
    const first = payload[0] as { payload?: Partial<ModelChartPoint> } | undefined
    if (first?.payload?.model) {
      return first.payload.model
    }
  }
  return String(label ?? '')
}

function chartTooltipFormatter(value: unknown, name: unknown) {
  const label = String(name ?? '')
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) {
    return [String(value ?? ''), label]
  }
  if (label.includes('成本') || label.includes('$')) {
    return [formatUsd(numeric), label]
  }
  return [formatNumber(numeric), label]
}

function csvCell(value: string | number | undefined) {
  const text = String(value ?? '')
  return `"${text.replace(/"/g, '""')}"`
}

function downloadCsv(filename: string, rows: Array<Array<string | number | undefined>>) {
  const csv = rows.map((row) => row.map(csvCell).join(',')).join('\r\n')
  const blob = new Blob([`\uFEFF${csv}`], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  URL.revokeObjectURL(url)
}

type RateDraftField = 'modelRatio' | 'groupRatio' | 'completionRatio' | 'cacheRatio'
type RateDrafts = Record<string, Partial<Record<RateDraftField, string>>>
type LoginState = {
  status: 'idle' | 'loading' | 'success' | 'error'
  message: string
}
type AutoLoginAttempt = {
  siteId: string
  cookies: string[]
  at: number
}
type AutoLoginRequest = {
  siteId: string
  promise: Promise<RelaySite | null>
}

const CURRENT_API_KEY_TOKEN_FILTER = '__current_api_key__'

function createApiKeyProbe(index: number): ApiKeyProbe {
  return {
    id: `probe_${index}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    name: '',
    key: '',
    tokenName: '',
    enabled: true,
  }
}

function createImportedApiKeyProbe(token: TokenRecord, index: number): ApiKeyProbe {
  return {
    id: `imported_${token.id || index}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    name: token.name || `导入 Key ${index + 1}`,
    key: token.key ?? '',
    tokenName: token.name,
    enabled: token.status !== 'disabled',
  }
}

function siteWithImportedTokenKeys(site: RelaySite, tokens: TokenRecord[]) {
  let imported = 0
  let updated = 0
  const defaultKey = site.apiKey.trim()
  const probes = [...(site.apiKeyProbes ?? [])]
  let apiKeyTokenName = site.apiKeyTokenName ?? ''

  tokens.forEach((token, index) => {
    const key = token.key?.trim()
    if (!key) {
      return
    }

    if (defaultKey && key === defaultKey) {
      if (!apiKeyTokenName.trim()) {
        apiKeyTokenName = token.name
        updated += 1
      }
      return
    }

    const sameKeyIndex = probes.findIndex((probe) => probe.key.trim() === key)
    if (sameKeyIndex >= 0) {
      const previous = probes[sameKeyIndex]
      const tokenName = previous.tokenName?.trim() || previous.name.trim() || token.name
      probes[sameKeyIndex] = {
        ...previous,
        name: tokenName,
        tokenName,
        enabled: token.status !== 'disabled',
      }
      updated += 1
      return
    }

    const sameTokenIndex = probes.findIndex((probe) => (probe.tokenName?.trim() || probe.name.trim()) === token.name)
    if (sameTokenIndex >= 0 && !probes[sameTokenIndex].key.trim()) {
      const tokenName = probes[sameTokenIndex].tokenName?.trim() || probes[sameTokenIndex].name.trim() || token.name
      probes[sameTokenIndex] = {
        ...probes[sameTokenIndex],
        key,
        name: tokenName,
        tokenName,
        enabled: token.status !== 'disabled',
      }
      updated += 1
      return
    }

    probes.push(createImportedApiKeyProbe(token, probes.length + index))
    imported += 1
  })

  return {
    imported,
    site: {
      ...site,
      apiKeyTokenName,
      apiKeyProbes: probes,
    },
    updated,
  }
}

function rateKey(rate: UsageSnapshot['groups'][number]) {
  return `${rate.group}\u0000${rate.model}`
}

function parseRateDraft(value: string | undefined, fallback: number | undefined) {
  if (value === undefined || value.trim() === '') {
    return fallback
  }
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function rateDraftValue(rate: UsageSnapshot['groups'][number], draft: Partial<Record<RateDraftField, string>> | undefined, field: RateDraftField) {
  const value = draft?.[field]
  if (value !== undefined) {
    return value
  }
  const fallback = rate[field]
  return Number.isFinite(fallback) ? String(fallback) : ''
}

function mergedRate(rate: UsageSnapshot['groups'][number], draft: Partial<Record<RateDraftField, string>> | undefined) {
  const modelRatio = parseRateDraft(draft?.modelRatio, rate.modelRatio)
  const groupRatio = parseRateDraft(draft?.groupRatio, rate.groupRatio)
  const completionRatio = parseRateDraft(draft?.completionRatio, rate.completionRatio)
  const cacheRatio = parseRateDraft(draft?.cacheRatio, rate.cacheRatio)
  const shouldRecomputeRatio = draft?.modelRatio !== undefined || draft?.groupRatio !== undefined
  const ratio =
    shouldRecomputeRatio && Number.isFinite(modelRatio) && Number.isFinite(groupRatio)
      ? Number(modelRatio) * Number(groupRatio)
      : rate.ratio
  return { ...rate, ratio, modelRatio, groupRatio, completionRatio, cacheRatio }
}

function buildUsedRateGroups(logs: UsageLog[], groups: UsageSnapshot['groups']) {
  const exactRates = new Map(groups.map((rate) => [rateKey(rate), rate]))
  const modelRates = new Map<string, UsageSnapshot['groups'][number]>()
  const usage = new Map<string, { cost: number; requests: number; tokens: number }>()
  const used = new Map<string, UsageSnapshot['groups'][number]>()
  const latestLogs = [...logs].sort((a, b) => trendSortValue(b.time) - trendSortValue(a.time))

  groups.forEach((rate) => {
    if (!modelRates.has(rate.model)) {
      modelRates.set(rate.model, rate)
    }
  })

  latestLogs.forEach((log) => {
    if (!log.model || log.model === 'unknown-model') {
      return
    }

    const key = `${log.group}\u0000${log.model}`
    const fallback = exactRates.get(key) ?? modelRates.get(log.model)
    if (!used.has(key)) {
      const groupRatio = log.groupRatio ?? fallback?.groupRatio
      const modelRatio = log.modelRatio ?? fallback?.modelRatio
      const inferredRatio =
        Number.isFinite(modelRatio) && Number.isFinite(groupRatio)
          ? Number(modelRatio) * Number(groupRatio)
          : undefined
      const ratio = log.ratio ?? inferredRatio ?? fallback?.ratio ?? 1

      used.set(key, {
        group: log.group,
        model: log.model,
        ratio,
        enabled: fallback?.enabled ?? true,
        modelRatio,
        groupRatio,
        completionRatio: log.completionRatio ?? fallback?.completionRatio,
        cacheRatio: log.cacheRatio ?? fallback?.cacheRatio,
        modelPrice: fallback?.modelPrice,
        quotaType: fallback?.quotaType,
        availableGroups: fallback?.availableGroups,
      })
    }

    const item = usage.get(key) ?? { cost: 0, requests: 0, tokens: 0 }
    item.cost += log.cost
    item.requests += 1
    item.tokens += log.total
    usage.set(key, item)
  })

  return Array.from(used.values()).sort((a, b) => {
    const aUsage = usage.get(rateKey(a)) ?? { cost: 0, requests: 0, tokens: 0 }
    const bUsage = usage.get(rateKey(b)) ?? { cost: 0, requests: 0, tokens: 0 }
    return bUsage.cost - aUsage.cost || bUsage.tokens - aUsage.tokens || bUsage.requests - aUsage.requests
  })
}

function statusLabel(status: AvailabilityStatus) {
  if (status === 'ok') return '正常'
  if (status === 'slow') return '高延迟'
  if (status === 'down') return '异常'
  return '未知'
}

function statusClass(status: AvailabilityStatus) {
  return `status-dot status-${status}`
}

function availabilityPercent(value: number) {
  const p = value > 1 ? value : value * 100
  return `${Math.max(0, Math.min(100, p)).toFixed(2)}%`
}

function percent(value: number) {
  if (!Number.isFinite(value)) {
    return '0.0%'
  }
  return `${(value * 100).toFixed(1)}%`
}

const SOURCE_TAGS: Record<EndpointSource['kind'], string> = {
  ok: 'OK',
  fail: 'FAIL',
  optional: '可选',
  forbidden: '权限不足',
  timeout: '超时',
}

function sourceTagClass(source: EndpointSource) {
  const kind = source.kind ?? (source.optional ? 'optional' : source.ok ? 'ok' : 'fail')
  return `source-tag source-${kind}`
}

function sourceTagText(source: EndpointSource) {
  const kind = source.kind ?? (source.optional ? 'optional' : source.ok ? 'ok' : 'fail')
  return SOURCE_TAGS[kind]
}

function hasLoginCredentials(site: RelaySite) {
  return Boolean(site.loginUsername?.trim() && site.loginPassword)
}

function canAutoLogin(site: RelaySite) {
  return Boolean(site.autoLogin && hasLoginCredentials(site))
}

function shouldLoginBeforeFetch(site: RelaySite) {
  return canAutoLogin(site) && !site.apiKey.trim() && !site.cookie?.trim()
}

const AUTH_FAILURE_PATTERN = /(鉴权失败|unauthori[sz]ed|invalid access token|cookie\/session 已失效)/i
const AUTO_LOGIN_COOLDOWN_MS = 30 * 60_000
const LOGIN_REFRESHABLE_LABELS = new Set(['账户信息', '账户信息（按 ID）', '用量统计', '自助数据', '调用日志', '令牌列表', '分组列表'])
const LOGIN_REFRESHABLE_ENDPOINTS = [
  '/api/user/self',
  '/api/user/',
  '/api/log/self',
  '/api/data/self',
  '/api/token',
  '/api/user/self/groups',
]

function sourceCanBeFixedByLogin(source: EndpointSource) {
  return (
    LOGIN_REFRESHABLE_LABELS.has(source.label.replace(/\s+\d+$/, '')) ||
    LOGIN_REFRESHABLE_ENDPOINTS.some((endpoint) => source.endpoint.startsWith(endpoint))
  )
}

function sourceHasRefreshableAuthFailure(source: EndpointSource) {
  if (!sourceCanBeFixedByLogin(source)) {
    return false
  }
  return source.kind === 'forbidden' || source.status === 401 || source.status === 403 || AUTH_FAILURE_PATTERN.test(source.detail ?? '')
}

function snapshotHasAuthFailure(snapshot: UsageSnapshot) {
  return (
    snapshot.sources.some(sourceHasRefreshableAuthFailure) ||
    snapshot.errors.some((error) => {
      const [label = ''] = error.split('：')
      return LOGIN_REFRESHABLE_LABELS.has(label) && AUTH_FAILURE_PATTERN.test(error)
    })
  )
}

function siteWithLoginResult(site: RelaySite, result: NewApiLoginResult): RelaySite {
  const shouldUseToken = Boolean(result.token && !result.cookie && !site.apiKey.trim())
  return {
    ...site,
    apiKey: shouldUseToken ? result.token ?? site.apiKey : site.apiKey,
    userId: result.userId ?? site.userId ?? '',
    cookie: result.cookie ?? site.cookie ?? '',
  }
}

function siteForStorage(site: RelaySite): RelaySite {
  return site.autoLogin ? site : { ...site, loginPassword: '' }
}

function formatLoginStamp(mode: 'manual' | 'auto') {
  const time = new Date().toLocaleTimeString('zh-CN', { hour12: false })
  return `${mode === 'auto' ? '自动' : '手动'}，${time}`
}

function maskConfiguredKey(value: string) {
  const key = value.trim()
  if (!key) {
    return ''
  }
  if (key.length <= 12) {
    return `${key.slice(0, 3)}***`
  }
  return `${key.slice(0, 6)}********${key.slice(-4)}`
}

function apiKeyCompareVariants(value: string) {
  const normalized = value.trim().replace(/^Bearer\s+/i, '')
  const variants = new Set<string>()
  if (normalized) {
    variants.add(normalized)
  }
  if (normalized.startsWith('sk-')) {
    variants.add(normalized.slice(3))
  }
  return [...variants].filter(Boolean)
}

function previewVisibleParts(preview: string) {
  return preview
    .split(/\*+/)
    .map((part) => part.trim().replace(/^Bearer\s+/i, '').replace(/^sk-/, ''))
    .filter(Boolean)
}

function apiKeyMatchesPreview(apiKey: string, preview: string) {
  const key = apiKey.trim()
  const masked = preview.trim()
  if (!key || !masked || masked === 'not returned') {
    return false
  }
  if (masked === key || masked === maskConfiguredKey(key)) {
    return true
  }

  const keyVariants = apiKeyCompareVariants(key)
  if (apiKeyCompareVariants(masked).some((variant) => keyVariants.includes(variant))) {
    return true
  }

  const visibleParts = previewVisibleParts(masked)
  if (!visibleParts.length) {
    return false
  }
  return keyVariants.some((candidate) =>
    visibleParts.every((part, index) => {
      if (index === 0) {
        return candidate.startsWith(part)
      }
      if (index === visibleParts.length - 1) {
        return candidate.endsWith(part)
      }
      return candidate.includes(part)
    }),
  )
}

function matchingApiKeyTokenName(apiKey: string, tokens: TokenRecord[]) {
  if (!apiKey.trim()) {
    return ''
  }
  return tokens.find((token) => apiKeyMatchesPreview(apiKey, token.keyPreview))?.name ?? ''
}

function siteHasAuth(site: RelaySite) {
  return Boolean(site.apiKey.trim() || site.cookie?.trim() || (site.apiKeyProbes ?? []).some((probe) => probe.enabled && probe.key.trim()))
}

function keyCheckStatusText(status: ApiKeyProbeResult['status']) {
  if (status === 'ok') return '正常'
  if (status === 'forbidden') return '权限不足'
  if (status === 'timeout') return '超时'
  if (status === 'optional') return '可选'
  return '异常'
}

function keyHealthTone(score: number) {
  if (score >= 95) return 'ok'
  if (score >= 80) return 'warn'
  return 'bad'
}

function autoLoginInCooldown(site: RelaySite, attempt: AutoLoginAttempt | null) {
  const cookie = site.cookie?.trim() ?? ''
  return Boolean(
    attempt &&
      attempt.siteId === site.id &&
      attempt.cookies.includes(cookie) &&
      Date.now() - attempt.at < AUTO_LOGIN_COOLDOWN_MS,
  )
}

function autoLoginAttempt(site: RelaySite, loggedInSite: RelaySite | null): AutoLoginAttempt {
  const cookies = new Set([site.cookie?.trim() ?? '', loggedInSite?.cookie?.trim() ?? ''])
  return {
    siteId: site.id,
    cookies: [...cookies],
    at: Date.now(),
  }
}

/** 站点配置校验，给出可执行的中文提示。 */
function validateSite(site: RelaySite) {
  const errors: Partial<Record<'baseUrl' | 'apiKey' | 'userId' | 'refreshMinutes' | 'loginUsername' | 'loginPassword', string>> = {}
  const baseUrl = site.baseUrl.trim()
  if (!baseUrl || baseUrl === 'https://') {
    errors.baseUrl = '请填写中转站地址，例如 https://your-relay.com'
  } else if (!/^https?:\/\/.+/i.test(baseUrl)) {
    errors.baseUrl = 'Base URL 需以 http:// 或 https:// 开头'
  } else if (/\/$/.test(baseUrl)) {
    errors.baseUrl = '末尾多余的 / 会被自动去除，可保留'
  }
  if (!site.apiKey.trim() && !site.cookie?.trim() && !canAutoLogin(site)) {
    errors.apiKey = 'API Key、Cookie 或账号密码自动登录至少配置一项，否则只能查看示例数据'
  }
  if (site.userId && !/^\d+$/.test(site.userId.trim())) {
    errors.userId = 'User ID 通常为纯数字，请核对后台用户 ID'
  }
  if (site.autoLogin && !site.loginUsername?.trim()) {
    errors.loginUsername = '启用自动登录时需要填写账号'
  }
  if (site.autoLogin && !site.loginPassword) {
    errors.loginPassword = '启用自动登录时需要填写密码'
  }
  if (!Number.isFinite(site.refreshMinutes) || site.refreshMinutes < 1) {
    errors.refreshMinutes = '自动刷新间隔至少为 1 分钟'
  }
  return errors
}

function App() {
  const [theme, toggleTheme] = useTheme()
  const [appVersion, setAppVersion] = useState(__APP_VERSION__)
  const [brandRestartState, setBrandRestartState] = useState<'idle' | 'busy' | 'ok' | 'error'>('idle')
  const [closeBehavior, setCloseBehavior] = useState<CloseBehavior>('ask')
  const [closePreferenceState, setClosePreferenceState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const [closePromptOpen, setClosePromptOpen] = useState(false)
  const [closePromptRemember, setClosePromptRemember] = useState(false)
  const [closePromptBusy, setClosePromptBusy] = useState(false)
  const [closePromptError, setClosePromptError] = useState('')
  const [sites, setSites] = useState<RelaySite[]>(initialSites)
  const sitesRef = useRef(initialSites)
  const [selectedSiteId, setSelectedSiteId] = useState(initialSiteId)
  const selectedSite = useMemo(
    () => sites.find((site) => site.id === selectedSiteId) ?? sites[0],
    [selectedSiteId, sites],
  )
  const [snapshot, setSnapshot] = useState<UsageSnapshot>(() => createDemoSnapshot(selectedSite))
  const [draftSite, setDraftSite] = useState<RelaySite>(selectedSite)
  const [loading, setLoading] = useState(false)
  const [refreshProgress, setRefreshProgress] = useState<RefreshProgressState | null>(null)
  const [lastRefreshKind, setLastRefreshKind] = useState<'manual' | 'auto' | 'initial'>('initial')
  const [activeSection, setActiveSection] = useState('概览')
  const [modelFilter, setModelFilter] = useState('all')
  const [tokenFilter, setTokenFilter] = useState('all')
  const [statusFilter, setStatusFilter] = useState('all')
  const [logQuery, setLogQuery] = useState('')
  const [timeRange, setTimeRange] = useState<TimeRange>('24h')
  const [customRangeDraft, setCustomRangeDraft] = useState(() => ({
    start: formatDateTimeInput(Date.now() - DAY_MS),
    end: formatDateTimeInput(Date.now()),
  }))
  const [customRangeApplied, setCustomRangeApplied] = useState(() => ({
    start: formatDateTimeInput(Date.now() - DAY_MS),
    end: formatDateTimeInput(Date.now()),
  }))
  const [timeWindowAnchorMs, setTimeWindowAnchorMs] = useState(() => Date.now())
  const [logPageSize, setLogPageSize] = useState(20)
  const [logPage, setLogPage] = useState(1)
  const [nextRefreshAt, setNextRefreshAt] = useState(Date.now() + selectedSite.refreshMinutes * 60_000)
  const [clock, setClock] = useState(Date.now())
  const [showSecret, setShowSecret] = useState(false)
  const [showKeyProbeEditor, setShowKeyProbeEditor] = useState(() => Boolean(selectedSite.apiKeyProbes?.length))
  const [storageReady, setStorageReady] = useState(false)
  const [storageError, setStorageError] = useState('')
  const [saveState, setSaveState] = useState<'idle' | 'saved' | 'invalid'>('idle')
  const [tokenImportMessage, setTokenImportMessage] = useState('')
  const [loginState, setLoginState] = useState<LoginState>({ status: 'idle', message: '' })
  const [rateEditing, setRateEditing] = useState(false)
  const [rateDrafts, setRateDrafts] = useState<RateDrafts>({})
  const [selectedLog, setSelectedLog] = useState<UsageLog | null>(null)
  const autoLoginAttemptRef = useRef<AutoLoginAttempt | null>(null)
  const autoLoginRequestRef = useRef<AutoLoginRequest | null>(null)
  const rangeEffectReady = useRef(false)
  const selectedSiteRef = useRef(selectedSite)
  const activeSiteIdRef = useRef(selectedSite.id)
  const timeRangeRef = useRef(timeRange)
  const customRangeAppliedRef = useRef(customRangeApplied)

  const chart = useMemo(() => chartTheme(theme), [theme])
  const tooltipStyle = useMemo(
    () => ({
      background: chart.tooltipBg,
      border: `1px solid ${chart.tooltipBorder}`,
      borderRadius: 8,
      color: chart.tooltipText,
      fontSize: 12,
    }),
    [chart],
  )
  const draftErrors = useMemo(() => validateSite(draftSite), [draftSite])
  const activeTimeWindow = useMemo(
    () => buildTimeWindow(timeRange, customRangeApplied.start, customRangeApplied.end, timeWindowAnchorMs),
    [customRangeApplied.end, customRangeApplied.start, timeRange, timeWindowAnchorMs],
  )
  const activeTimeWindowKey = useMemo(() => timeWindowKey(activeTimeWindow), [activeTimeWindow])
  const rangeSelectionKey = `${timeRange}:${customRangeApplied.start}:${customRangeApplied.end}`
  const customRangePreview = useMemo(
    () => buildTimeWindow('custom', customRangeDraft.start, customRangeDraft.end),
    [customRangeDraft.end, customRangeDraft.start],
  )

  const persistSites = useCallback((nextSites: RelaySite[]) => {
    sitesRef.current = nextSites
    setSites(nextSites)
    return saveSites(nextSites)
      .then(() => {
        setStorageError('')
        return true
      })
      .catch(() => {
        setStorageError('敏感配置保存失败，请检查应用数据目录权限。')
        return false
      })
  }, [])

  const selectSite = useCallback((siteId: string) => {
    setSelectedSiteId(siteId)
    saveSelectedSiteId(siteId)
  }, [])

  const persistLoggedInSite = useCallback((updatedSite: RelaySite) => {
    const storedSite = siteForStorage(updatedSite)
    const nextSites = sitesRef.current.map((site) => (site.id === storedSite.id ? storedSite : site))
    persistSites(nextSites)
    selectedSiteRef.current = storedSite
    setDraftSite((draft) => (draft.id === storedSite.id ? storedSite : draft))
    return storedSite
  }, [persistSites])

  const runSiteLogin = useCallback(
    async (site: RelaySite, mode: 'manual' | 'auto') => {
      const username = site.loginUsername?.trim() ?? ''
      const password = site.loginPassword ?? ''

      if (!username || !password) {
        setLoginState({ status: 'error', message: `${formatLoginStamp(mode)}：请先填写 New API 登录账号和密码` })
        return null
      }

      setLoginState({
        status: 'loading',
        message: mode === 'auto' ? 'Cookie 失效，正在自动登录...' : '正在登录 New API...',
      })

      const result = await loginNewApi(site, username, password)
      if (!result.ok) {
        setLoginState({ status: 'error', message: `${formatLoginStamp(mode)}：${result.message}` })
        return null
      }

      const updatedSite = persistLoggedInSite(siteWithLoginResult(site, result))
      setSaveState('saved')
      setLoginState({ status: 'success', message: `${formatLoginStamp(mode)}：${result.message}` })
      return updatedSite
    },
    [persistLoggedInSite],
  )

  const runAutoLoginOnce = useCallback(
    async (site: RelaySite) => {
      if (autoLoginInCooldown(site, autoLoginAttemptRef.current)) {
        return null
      }
      if (autoLoginRequestRef.current?.siteId === site.id) {
        return autoLoginRequestRef.current.promise
      }

      const promise = runSiteLogin(site, 'auto').then((loggedInSite) => {
        autoLoginAttemptRef.current = autoLoginAttempt(site, loggedInSite)
        return loggedInSite
      })
      autoLoginRequestRef.current = { siteId: site.id, promise }
      try {
        return await promise
      } finally {
        if (autoLoginRequestRef.current?.promise === promise) {
          autoLoginRequestRef.current = null
        }
      }
    },
    [runSiteLogin],
  )

  useEffect(() => {
    if (!isTauriRuntime()) {
      return
    }

    let cancelled = false
    void getAppVersion()
      .then((version) => {
        if (!cancelled) {
          setAppVersion(version)
        }
      })
      .catch(() => undefined)

    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (!isTauriRuntime()) {
      return
    }

    let disposed = false
    let unlisten: (() => void) | undefined
    void loadAppPreferences()
      .then((preferences) => {
        if (!disposed) {
          setCloseBehavior(preferences.closeBehavior)
        }
      })
      .catch(() => {
        if (!disposed) {
          setClosePreferenceState('error')
        }
      })
    void listenForCloseRequest(() => {
      setClosePromptRemember(false)
      setClosePromptError('')
      setClosePromptOpen(true)
    }).then((removeListener) => {
      if (disposed) {
        removeListener()
      } else {
        unlisten = removeListener
      }
    }).catch(() => {
      if (!disposed) {
        setClosePreferenceState('error')
      }
    })

    return () => {
      disposed = true
      unlisten?.()
    }
  }, [])

  const updateCloseBehavior = useCallback(async (behavior: CloseBehavior) => {
    const previousBehavior = closeBehavior
    setCloseBehavior(behavior)
    setClosePreferenceState('saving')
    try {
      const preferences = await saveCloseBehavior(behavior)
      setCloseBehavior(preferences.closeBehavior)
      setClosePreferenceState('saved')
    } catch {
      setCloseBehavior(previousBehavior)
      setClosePreferenceState('error')
    }
  }, [closeBehavior])

  const handleCloseResolution = useCallback(async (resolution: CloseResolution) => {
    if (closePromptBusy) {
      return
    }
    setClosePromptBusy(true)
    setClosePromptError('')
    setClosePromptOpen(false)
    try {
      await resolveCloseRequest(resolution, closePromptRemember)
      if (closePromptRemember && resolution !== 'cancel') {
        setCloseBehavior(resolution)
        setClosePreferenceState('saved')
      }
    } catch {
      setClosePromptError('关闭操作执行失败，请重试。')
      setClosePromptOpen(true)
    } finally {
      setClosePromptBusy(false)
    }
  }, [closePromptBusy, closePromptRemember])

  useEffect(() => {
    let cancelled = false

    void initializeSiteStorage(initialSites)
      .then((loadedSites) => {
        if (cancelled) {
          return
        }
        const nextSiteId = loadSelectedSiteId(loadedSites) ?? loadedSites[0].id
        const nextSite = loadedSites.find((site) => site.id === nextSiteId) ?? loadedSites[0]
        sitesRef.current = loadedSites
        selectedSiteRef.current = nextSite
        activeSiteIdRef.current = nextSite.id
        setSites(loadedSites)
        setSelectedSiteId(nextSite.id)
        setDraftSite(nextSite)
        setStorageError('')
        setStorageReady(true)
      })
      .catch(() => {
        if (!cancelled) {
          setStorageError('无法读取敏感配置目录，当前仅使用空白配置。')
          setStorageReady(true)
        }
      })

    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    sitesRef.current = sites
  }, [sites])

  useEffect(() => {
    selectedSiteRef.current = selectedSite
  }, [selectedSite])

  useEffect(() => {
    timeRangeRef.current = timeRange
    customRangeAppliedRef.current = customRangeApplied
  }, [customRangeApplied, timeRange])

  // 手动/自动刷新共用；并发锁避免重复点击造成竞态。
  const refreshSnapshot = useCallback(
    async (kind: 'manual' | 'auto' | 'initial' = 'manual') => {
      setLoading((busy) => {
        if (busy) {
          return busy
        }
        void (async () => {
          setLastRefreshKind(kind)
          setRefreshProgress({
            loadedLogs: 0,
            groupsReady: false,
            completedKeyChecks: 0,
          })
          setSnapshot((current) => ({ ...current, keyChecks: [] }))
          try {
            let currentSite = selectedSiteRef.current
            const refreshedAt = Date.now()
            const selectedRange = timeRangeRef.current
            const selectedCustomRange = customRangeAppliedRef.current
            const refreshedTimeWindow = buildTimeWindow(
              selectedRange,
              selectedCustomRange.start,
              selectedCustomRange.end,
              refreshedAt,
            )
            if (!refreshedTimeWindow.valid) {
              return
            }
            const refreshedRequestRange = {
              startTimestamp: Math.floor(refreshedTimeWindow.startMs / 1000),
              endTimestamp: Math.floor(refreshedTimeWindow.endMs / 1000),
              label: refreshedTimeWindow.label,
            }
            if (selectedRange !== 'custom') {
              setTimeWindowAnchorMs(refreshedAt)
            }
            const preLoginSite = shouldLoginBeforeFetch(currentSite)
              ? await runAutoLoginOnce(currentSite)
              : null
            currentSite = preLoginSite ?? currentSite

            const showProgress = (progress: UsageFetchProgress) => {
              if (selectedSiteRef.current.id !== currentSite.id) {
                return
              }

              if (progress.kind === 'logs') {
                setRefreshProgress((current) => ({
                  loadedLogs: progress.loadedLogs,
                  totalLogs: progress.totalLogs,
                  groupsReady: current?.groupsReady ?? false,
                  completedKeyChecks: current?.completedKeyChecks ?? 0,
                  totalKeyChecks: current?.totalKeyChecks,
                }))
                setSnapshot((current) => ({
                  ...current,
                  generatedAt: new Date().toISOString(),
                  mode: 'partial',
                  logs: progress.logs,
                }))
                return
              }

              if (progress.kind === 'groups') {
                setRefreshProgress((current) => ({
                  loadedLogs: current?.loadedLogs ?? 0,
                  totalLogs: current?.totalLogs,
                  groupsReady: true,
                  completedKeyChecks: current?.completedKeyChecks ?? 0,
                  totalKeyChecks: current?.totalKeyChecks,
                }))
                setSnapshot((current) => ({ ...current, groups: progress.groups }))
                return
              }

              setRefreshProgress((current) => ({
                loadedLogs: current?.loadedLogs ?? 0,
                totalLogs: current?.totalLogs,
                groupsReady: current?.groupsReady ?? false,
                completedKeyChecks: progress.completedKeyChecks,
                totalKeyChecks: progress.totalKeyChecks,
              }))
              setSnapshot((current) => ({ ...current, keyChecks: progress.keyChecks }))
            }

            let next = await fetchUsageSnapshot(currentSite, refreshedRequestRange, showProgress)
            if (canAutoLogin(currentSite) && snapshotHasAuthFailure(next)) {
              const loggedInSite = await runAutoLoginOnce(currentSite)
              if (loggedInSite) {
                currentSite = loggedInSite
                setRefreshProgress({
                  loadedLogs: 0,
                  groupsReady: false,
                  completedKeyChecks: 0,
                })
                setSnapshot((current) => ({ ...current, keyChecks: [] }))
                next = await fetchUsageSnapshot(loggedInSite, refreshedRequestRange, showProgress)
              }
            }
            setSnapshot(next)
          } catch {
            // fetchUsageSnapshot 内部已兜底，这里仅防御异常
          } finally {
            setLoading(false)
            setRefreshProgress(null)
            setNextRefreshAt(Date.now() + selectedSiteRef.current.refreshMinutes * 60_000)
          }
        })()
        return true
      })
    },
    [runAutoLoginOnce],
  )

  // 切换站点时重置草稿、示例快照并重新拉取。
  useEffect(() => {
    if (!storageReady) {
      return
    }
    const switchedSite = activeSiteIdRef.current !== selectedSite.id
    activeSiteIdRef.current = selectedSite.id
    setDraftSite(selectedSite)
    if (switchedSite) {
      setSaveState('idle')
      setTokenImportMessage('')
      setLoginState({ status: 'idle', message: '' })
      setShowKeyProbeEditor(Boolean(selectedSite.apiKeyProbes?.length))
    }
    setSnapshot(createDemoSnapshot(selectedSite))
    setNextRefreshAt(Date.now() + selectedSite.refreshMinutes * 60_000)
    void refreshSnapshot('initial')
  }, [refreshSnapshot, selectedSite, storageReady])

  useEffect(() => {
    if (!storageReady) {
      return
    }
    if (!rangeEffectReady.current) {
      rangeEffectReady.current = true
      return
    }
    if (!activeTimeWindow.valid) {
      return
    }
    setSnapshot(createDemoSnapshot(selectedSiteRef.current))
    void refreshSnapshot('manual')
  }, [activeTimeWindow.valid, rangeSelectionKey, refreshSnapshot, storageReady])

  // 自动刷新定时器：切换站点或修改间隔后会重建，刷新周期随之重置。
  useEffect(() => {
    if (!storageReady) {
      return
    }
    const timer = window.setInterval(() => {
      void refreshSnapshot('auto')
    }, selectedSite.refreshMinutes * 60_000)
    return () => window.clearInterval(timer)
  }, [refreshSnapshot, selectedSite.refreshMinutes, storageReady])

  useEffect(() => {
    const timer = window.setInterval(() => setClock(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => {
    window.scrollTo({ top: 0, left: 0 })
  }, [activeSection])

  const saveDraft = useCallback(async () => {
    if (Object.keys(validateSite(draftSite)).some((key) => key === 'baseUrl' || key === 'refreshMinutes' || key === 'loginUsername' || key === 'loginPassword')) {
      setSaveState('invalid')
      return
    }
    const siteToSave = siteForStorage(draftSite)
    const nextSites = sites.map((site) => (site.id === siteToSave.id ? siteToSave : site))
    const saved = await persistSites(nextSites)
    selectSite(siteToSave.id)
    setSaveState(saved ? 'saved' : 'invalid')
  }, [draftSite, persistSites, selectSite, sites])

  const loginFromDraft = useCallback(async () => {
    const errors = validateSite(draftSite)
    const blockingError = errors.baseUrl ?? errors.loginUsername ?? errors.loginPassword
    if (blockingError) {
      setSaveState('invalid')
      setLoginState({ status: 'error', message: blockingError })
      return
    }

    const updatedSite = await runSiteLogin(draftSite, 'manual')
    if (updatedSite) {
      selectSite(updatedSite.id)
      void refreshSnapshot('manual')
    }
  }, [draftSite, refreshSnapshot, runSiteLogin, selectSite])

  const addApiKeyProbe = useCallback(() => {
    setTokenImportMessage('')
    setShowKeyProbeEditor(true)
    setDraftSite((site) => ({
      ...site,
      apiKeyProbes: [...(site.apiKeyProbes ?? []), createApiKeyProbe(site.apiKeyProbes?.length ?? 0)],
    }))
  }, [])

  const importApiKeyProbesFromTokens = useCallback(() => {
    const importableTokens = snapshot.tokens.filter((token) => token.key?.trim())
    setShowKeyProbeEditor(true)

    if (!snapshot.tokens.length) {
      setTokenImportMessage('还没有获取到令牌列表。请先登录获取 Cookie，并手动刷新一次。')
      return
    }

    if (!importableTokens.length) {
      setTokenImportMessage('当前站点只返回令牌名称或掩码 Key，未返回可导入的完整 API Key。')
      return
    }

    const importResult = siteWithImportedTokenKeys(draftSite, importableTokens)
    setDraftSite(importResult.site)
    setSaveState('idle')
    setTokenImportMessage(`已导入 ${importResult.imported} 个完整 Key，更新 ${importResult.updated} 个已有配置。确认无误后点击“保存配置”。`)
  }, [draftSite, snapshot.tokens])

  const updateApiKeyProbe = useCallback((id: string, patch: Partial<ApiKeyProbe>) => {
    setTokenImportMessage('')
    const normalizedPatch = patch.tokenName === undefined
      ? patch
      : { ...patch, name: patch.tokenName }
    setDraftSite((site) => ({
      ...site,
      apiKeyProbes: (site.apiKeyProbes ?? []).map((probe) => (probe.id === id ? { ...probe, ...normalizedPatch } : probe)),
    }))
  }, [])

  const removeApiKeyProbe = useCallback((id: string) => {
    setTokenImportMessage('')
    setDraftSite((site) => ({
      ...site,
      apiKeyProbes: (site.apiKeyProbes ?? []).filter((probe) => probe.id !== id),
    }))
  }, [])

  const addSite = useCallback(() => {
    const blank = createBlankSite()
    const nextSites = [...sites, blank]
    persistSites(nextSites)
    selectSite(blank.id)
    setDraftSite(blank)
    setSaveState('idle')
  }, [persistSites, selectSite, sites])

  const deleteSite = useCallback(() => {
    if (sites.length <= 1) {
      return
    }
    const confirmed = window.confirm(`确定删除站点“${selectedSite.name}”吗？该操作不可撤销。`)
    if (!confirmed) {
      return
    }
    const nextSites = sites.filter((site) => site.id !== selectedSite.id)
    persistSites(nextSites)
    selectSite(nextSites[0].id)
  }, [persistSites, selectSite, selectedSite.id, selectedSite.name, sites])

  const applyCustomRange = useCallback(() => {
    if (!customRangePreview.valid) {
      return
    }
    setCustomRangeApplied(customRangeDraft)
    setTimeRange('custom')
  }, [customRangeDraft, customRangePreview.valid])

  const timeScopedLogs = useMemo(() => {
    return snapshot.logs.filter((log) => isInTimeWindow(log.time, activeTimeWindow))
  }, [activeTimeWindow, snapshot.logs])

  const trendBucketMs = useMemo(() => trendBucketSize(timeRange, activeTimeWindow), [activeTimeWindow, timeRange])
  const trendAxisTicks = useMemo(() => buildTrendAxisTicks(activeTimeWindow, trendBucketMs), [activeTimeWindow, trendBucketMs])
  const scopedUsage = useMemo(
    () => computeScopedUsage(timeScopedLogs, snapshot.groups, trendBucketMs, activeTimeWindow),
    [activeTimeWindow, snapshot.groups, timeScopedLogs, trendBucketMs],
  )
  const scopedSnapshot = useMemo<UsageSnapshot>(
    () => ({
      ...snapshot,
      summary: scopedUsage.summary,
      trends: scopedUsage.trends,
      models: scopedUsage.models,
      logs: timeScopedLogs,
    }),
    [scopedUsage.models, scopedUsage.summary, scopedUsage.trends, snapshot, timeScopedLogs],
  )

  const usedRateGroups = useMemo(() => {
    return buildUsedRateGroups(timeScopedLogs, snapshot.groups)
  }, [snapshot.groups, timeScopedLogs])

  const apiKeyTokenName = useMemo(
    () => selectedSite.apiKeyTokenName?.trim() || matchingApiKeyTokenName(selectedSite.apiKey, snapshot.tokens),
    [selectedSite.apiKey, selectedSite.apiKeyTokenName, snapshot.tokens],
  )
  const effectiveTokenFilter = tokenFilter === CURRENT_API_KEY_TOKEN_FILTER ? apiKeyTokenName : tokenFilter
  const availableTokenNames = useMemo(() => {
    const names: string[] = []
    snapshot.tokens.forEach((token) => {
      if (token.name && !names.includes(token.name)) {
        names.push(token.name)
      }
    })
    timeScopedLogs.forEach((log) => {
      if (log.tokenName && !names.includes(log.tokenName)) {
        names.push(log.tokenName)
      }
    })
    snapshot.keyChecks.forEach((check) => {
      if (check.tokenName && !names.includes(check.tokenName)) {
        names.push(check.tokenName)
      }
    })
    return names
  }, [snapshot.keyChecks, snapshot.tokens, timeScopedLogs])

  const filteredLogs = useMemo(() => {
    return timeScopedLogs.filter((log) => {
      const modelMatches = modelFilter === 'all' || log.model === modelFilter
      const tokenMatches = !effectiveTokenFilter || effectiveTokenFilter === 'all' || log.tokenName === effectiveTokenFilter
      const statusMatches =
        statusFilter === 'all' ||
        (statusFilter === 'success' && log.status !== 'error') ||
        (statusFilter === 'error' && log.status === 'error')
      const query = logQuery.trim().toLowerCase()
      const queryMatches =
        !query ||
        [log.id, log.model, log.tokenName, log.group].some((value) =>
          value.toLowerCase().includes(query),
        )
      return modelMatches && tokenMatches && statusMatches && queryMatches
    })
  }, [effectiveTokenFilter, logQuery, modelFilter, statusFilter, timeScopedLogs])

  const logTotalPages = Math.max(1, Math.ceil(filteredLogs.length / logPageSize))
  const safeLogPage = Math.min(logPage, logTotalPages)
  const logStartIndex = filteredLogs.length ? (safeLogPage - 1) * logPageSize : 0
  const visibleLogs = useMemo(() => {
    return filteredLogs.slice(logStartIndex, logStartIndex + logPageSize)
  }, [filteredLogs, logPageSize, logStartIndex])
  const logEndIndex = Math.min(logStartIndex + visibleLogs.length, filteredLogs.length)

  useEffect(() => {
    setLogPage(1)
  }, [activeTimeWindowKey, logPageSize, logQuery, modelFilter, snapshot.logs, statusFilter, tokenFilter])

  useEffect(() => {
    if (tokenFilter !== 'all' && tokenFilter !== CURRENT_API_KEY_TOKEN_FILTER && !availableTokenNames.includes(tokenFilter)) {
      setTokenFilter('all')
    }
  }, [availableTokenNames, tokenFilter])

  useEffect(() => {
    if (tokenFilter === CURRENT_API_KEY_TOKEN_FILTER && !apiKeyTokenName) {
      setTokenFilter('all')
    }
  }, [apiKeyTokenName, tokenFilter])

  useEffect(() => {
    if (logPage > logTotalPages) {
      setLogPage(logTotalPages)
    }
  }, [logPage, logTotalPages])

  const exportFilteredLogs = useCallback(() => {
    if (!filteredLogs.length) {
      return
    }
    const rows: Array<Array<string | number | undefined>> = [
      ['时间', '令牌名称', '模型', '分组', '请求 ID', '状态', '错误码', '错误原因', '输入 Tokens', '输出 Tokens', '真实总 Tokens', '实际成本($)', '缓存创建', '缓存命中', '用时(ms)', '首字(ms)', '对话类型', '输出速度(t/s)', '推理强度'],
      ...filteredLogs.map((log) => [
        log.time,
        log.tokenName,
        log.model,
        log.group,
        log.id,
        logStatusText(log.status),
        log.errorCode,
        log.errorMessage,
        log.input,
        log.output,
        log.total,
        log.cost,
        log.cacheCreation,
        log.cacheHit,
        log.latencyMs,
        log.firstTokenMs,
        formatConversationType(log.isStream),
        log.outputTokensPerSecond,
        log.reasoningEffort,
      ]),
    ]
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
    downloadCsv(`api-usage-logs-${stamp}.csv`, rows)
  }, [filteredLogs])

  const updateRateDraft = useCallback((key: string, field: RateDraftField, value: string) => {
    if (value && !/^\d*\.?\d*$/.test(value)) {
      return
    }
    setRateDrafts((drafts) => ({
      ...drafts,
      [key]: {
        ...drafts[key],
        [field]: value,
      },
    }))
  }, [])

  const resetRateDrafts = useCallback(() => {
    setRateDrafts({})
  }, [])

  const restartCodexFromBrand = useCallback(async () => {
    if (brandRestartState === 'busy') return
    if (!isTauriRuntime()) {
      setBrandRestartState('error')
      window.setTimeout(() => setBrandRestartState('idle'), 2400)
      return
    }
    setBrandRestartState('busy')
    try {
      const result = await callCodex<{ status: string }>('restart_codex_plus', {
        request: { appPath: '', debugPort: 9222, helperPort: 58321 },
      })
      setBrandRestartState(result.status === 'failed' ? 'error' : 'ok')
    } catch {
      setBrandRestartState('error')
    }
    window.setTimeout(() => setBrandRestartState('idle'), 2400)
  }, [brandRestartState])

  const availableModels = useMemo(() => {
    const models: string[] = []
    scopedSnapshot.models.forEach((model) => {
      if (!models.includes(model.model)) {
        models.push(model.model)
      }
    })
    snapshot.groups.forEach((rate) => {
      if (!models.includes(rate.model)) {
        models.push(rate.model)
      }
    })
    return models
  }, [scopedSnapshot.models, snapshot.groups])

  const trendData = useMemo(() => {
    return smoothTrendPoints(scopedSnapshot.trends, trendBucketMs)
  }, [scopedSnapshot.trends, trendBucketMs])

  const modelChartData = useMemo(() => buildModelChartData(scopedSnapshot.models), [scopedSnapshot.models])

  const analytics = useMemo(() => computeAnalytics(scopedSnapshot), [scopedSnapshot])

  const secondsUntilRefresh = Math.max(0, Math.ceil((nextRefreshAt - clock) / 1000))
  const refreshCountdown = `${Math.floor(secondsUntilRefresh / 60)}:${String(secondsUntilRefresh % 60).padStart(2, '0')}`
  const sourceHealth = snapshot.sources.filter((source) => source.ok || source.optional).length
  const hasLiveData = snapshot.mode !== 'demo'
  const isEmptyLive = hasLiveData && timeScopedLogs.length === 0
  const isOverview = activeSection === '概览'
  const isAnalytics = activeSection === '分析'
  const isAccount = activeSection === '账户'
  const isModels = activeSection === '模型'
  const isAvailability = activeSection === '可用性'
  const isProxyLatency = activeSection === '代理测速'
  const isSettings = activeSection === '设置'
  const isCodexSection = CODEX_SECTIONS.has(activeSection as CodexSection)
  const isCodexOnlySection = isCodexSection && !isOverview && !isSettings
  const showAccount = isOverview || isAccount
  const showSummary = isOverview || isAccount
  const showTrend = isOverview || isAccount || isModels
  const showModels = isOverview || isModels
  const showAnalytics = isAnalytics
  const showOverviewRail = isOverview
  const showAvailability = isAvailability
  const showRates = isModels
  const showCostShare = isModels
  const showSettings = isSettings
  const showLogs = isOverview
  const showSources = isAccount || isAvailability || isSettings
  const modeText = snapshot.mode === 'live' ? '实时' : snapshot.mode === 'partial' ? '部分实时' : '示例'
  const subscriptionUsedRaw =
    snapshot.account.subscriptionUsedRaw ??
    (snapshot.account.subscriptionTotalRaw !== undefined &&
    snapshot.account.subscriptionRemainingRaw !== undefined &&
    snapshot.account.subscriptionTotalRaw >= snapshot.account.subscriptionRemainingRaw
      ? snapshot.account.subscriptionTotalRaw - snapshot.account.subscriptionRemainingRaw
      : undefined)
  const hasSubscriptionUsage = Boolean(
    snapshot.account.subscriptionName ||
    snapshot.account.subscriptionRemainingRaw !== undefined ||
    snapshot.account.subscriptionTotalRaw !== undefined,
  )

  return (
    <main className="app-shell">
      <header className="window-bar">
        <div className="brand" data-tauri-drag-region onDoubleClick={() => runWindowAction('toggleMaximize')}>
          <button
            className={`brand-mark brand-restart ${brandRestartState}`}
            type="button"
            aria-label="重启 Codex"
            title={brandRestartState === 'busy' ? '正在重启 Codex…' : brandRestartState === 'ok' ? '已请求重启 Codex' : brandRestartState === 'error' ? '重启失败，请到概览查看状态' : '点击重启 Codex'}
            disabled={brandRestartState === 'busy'}
            onClick={() => void restartCodexFromBrand()}
            onDoubleClick={(event) => event.stopPropagation()}
          >
            <Zap size={18} />
          </button>
          <strong data-tauri-drag-region>Codex_Ultura</strong>
          {brandRestartState !== 'idle' ? <span className={`brand-restart-status ${brandRestartState}`}>{brandRestartState === 'busy' ? '正在重启 Codex…' : brandRestartState === 'ok' ? '已请求重启' : '重启失败'}</span> : null}
        </div>
        <div className="window-drag-region" data-tauri-drag-region onDoubleClick={() => runWindowAction('toggleMaximize')} />
        <div className="window-bar-actions">
          <button
            className="theme-toggle"
            type="button"
            onClick={toggleTheme}
            aria-label={theme === 'dark' ? '切换到浅色主题' : theme === 'light' ? '切换到浅粉主题' : '切换到深色主题'}
            title={theme === 'dark' ? '切换到浅色主题' : theme === 'light' ? '切换到浅粉主题' : '切换到深色主题'}
          >
            {theme === 'dark' ? <Sun size={15} /> : theme === 'light' ? <Palette size={15} /> : <Moon size={15} />}
            {theme === 'dark' ? '浅色' : theme === 'light' ? '浅粉' : '深色'}
          </button>
          <WindowControls />
        </div>
      </header>

      <div className="app-body">
      <aside className="sidebar">
        <nav className="nav-list" aria-label="主导航">
          {navItems.map(([label, Icon]) => (
            <button
              className={activeSection === label ? 'nav-item nav-active' : 'nav-item'}
              key={label}
              type="button"
              aria-pressed={activeSection === label}
              onClick={() => setActiveSection(String(label))}
            >
              <Icon size={18} />
              <span>{label}</span>
            </button>
          ))}
        </nav>

        <section className="site-stack">
          <div className="rail-label">站点</div>
          {sites.map((site) => (
            <button
              className={site.id === selectedSite.id ? 'site-pill site-pill-active' : 'site-pill'}
              key={site.id}
              type="button"
              onClick={() => selectSite(site.id)}
            >
              <span className={siteHasAuth(site) ? 'live-dot' : 'demo-dot'} />
              <span>{site.name}</span>
            </button>
          ))}
        </section>

        <div className="profile">
          <div className="avatar">CW</div>
          <div>
            <strong>{snapshot.account.username}</strong>
            <span>{snapshot.account.group}</span>
          </div>
          <ChevronRight size={14} />
        </div>
        <div className="version">v{appVersion}</div>
      </aside>

      <section className="workspace">
        <header className={isCodexOnlySection ? 'control-bar codex-hidden-control' : 'control-bar'}>
          <label className="select-field">
            <span>站点：</span>
            <select value={selectedSite.id} onChange={(event) => selectSite(event.target.value)}>
              {sites.map((site) => (
                <option key={site.id} value={site.id}>
                  {site.name}
                </option>
              ))}
            </select>
          </label>

          {!isProxyLatency && <div className="range-control">
            <label className="select-field">
              <span>时间范围：</span>
              <select value={timeRange} onChange={(event) => setTimeRange(event.target.value as TimeRange)}>
                <option value="today">今天</option>
                <option value="24h">近 24 小时</option>
                <option value="7d">近 7 天</option>
                <option value="30d">近 30 天</option>
                <option value="custom">自定义时间</option>
              </select>
            </label>
            {timeRange === 'custom' && (
              <div className="custom-range">
                <input
                  aria-label="自定义开始时间"
                  type="datetime-local"
                  value={customRangeDraft.start}
                  onChange={(event) => setCustomRangeDraft((range) => ({ ...range, start: event.target.value }))}
                />
                <span>至</span>
                <input
                  aria-label="自定义结束时间"
                  type="datetime-local"
                  value={customRangeDraft.end}
                  onChange={(event) => setCustomRangeDraft((range) => ({ ...range, end: event.target.value }))}
                />
                <button className="table-button" type="button" onClick={applyCustomRange} disabled={!customRangePreview.valid || loading}>
                  应用
                </button>
                {!customRangePreview.valid && <em>结束时间需晚于开始时间</em>}
              </div>
            )}
          </div>}

          {!isProxyLatency ? <div className="control-actions">
            <button className="icon-button" type="button" onClick={() => refreshSnapshot('manual')} disabled={loading}>
              <RefreshCw className={loading ? 'spin' : ''} size={16} />
              {loading ? '刷新中…' : '手动刷新'}
            </button>
            <div className={loading ? 'refresh-chip paused' : 'refresh-chip'}>
              <span className="live-dot" />
              <Clock3 size={15} />
              每 {selectedSite.refreshMinutes} 分钟
              <strong>{loading ? '——' : refreshCountdown}</strong>
            </div>
            <div className="last-update">
              <span>最后更新：</span>
              <strong>{new Date(snapshot.generatedAt).toLocaleString('zh-CN', { hour12: false })}</strong>
            </div>
          </div> : (
            <div className="proxy-control-hint">
              <ShieldCheck size={15} />
              支持外部或内置 Mihomo 与本地直连测速，不切换当前代理
            </div>
          )}
        </header>

        {!isProxyLatency && !isCodexOnlySection && loading && refreshProgress && (
          <section className="refresh-progress-panel" aria-live="polite" aria-label="刷新进度">
            <div className="refresh-progress-title">
              <RefreshCw className="spin" size={15} />
              <span>正在刷新站点数据</span>
            </div>
            <div
              className={refreshProgress.totalLogs === undefined ? 'refresh-progress-track indeterminate' : 'refresh-progress-track'}
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={refreshProgress.totalLogs}
              aria-valuenow={refreshProgress.totalLogs === undefined ? undefined : refreshProgress.loadedLogs}
            >
              <span
                style={{
                  width: refreshProgress.totalLogs
                    ? `${Math.min(100, (refreshProgress.loadedLogs / refreshProgress.totalLogs) * 100)}%`
                    : '24%',
                }}
              />
            </div>
            <strong className="refresh-progress-count">
              日志 {formatNumber(refreshProgress.loadedLogs)} / {refreshProgress.totalLogs === undefined ? '计算中' : formatNumber(refreshProgress.totalLogs)}
            </strong>
            <div className="refresh-progress-stages">
              <span className={refreshProgress.groupsReady ? 'ready' : undefined}>
                <SlidersHorizontal size={13} />
                倍率{refreshProgress.groupsReady ? '已就绪' : '加载中'}
              </span>
              <span className={refreshProgress.totalKeyChecks !== undefined && refreshProgress.completedKeyChecks >= refreshProgress.totalKeyChecks ? 'ready' : undefined}>
                <ShieldCheck size={13} />
                健康度{refreshProgress.totalKeyChecks === undefined
                  ? '等待中'
                  : refreshProgress.totalKeyChecks === 0
                    ? '无配置'
                  : ` ${refreshProgress.completedKeyChecks}/${refreshProgress.totalKeyChecks}`}
              </span>
            </div>
          </section>
        )}

        {!isOverview && (
          <section className="section-titlebar">
            <div>
              <h1>{activeSection}</h1>
              <p>{isProxyLatency ? '选择一个或多个机场，并比较本地直连、代理节点访问不同 Base URL 的实时延迟' : selectedSite.baseUrl || '未配置站点地址'}</p>
            </div>
          </section>
        )}

        {!isOverview && !isProxyLatency && !isCodexOnlySection && (
          <section className="status-strip">
            <div>
              <span>最后更新</span>
              <strong>{new Date(snapshot.generatedAt).toLocaleString('zh-CN', { hour12: false })}</strong>
            </div>
            <div>
              <span>刷新来源</span>
              <strong>{lastRefreshKind === 'auto' ? '自动刷新' : lastRefreshKind === 'manual' ? '手动刷新' : '初始化'}</strong>
            </div>
            <div>
              <span>数据模式</span>
              <strong className={`mode-${snapshot.mode}`}>{modeText}</strong>
            </div>
            <div>
              <span>接口健康</span>
              <strong>
                {sourceHealth}/{snapshot.sources.length}
              </strong>
            </div>
          </section>
        )}

        {isEmptyLive && (isOverview || isAnalytics) && (
          <div className="error-banner" style={{ marginBottom: 12 }}>
            <AlertTriangle size={16} />
            <span>
              已连接站点，但{activeTimeWindow.label}内没有调用记录，图表暂无数据。可在“设置 → 接口来源”查看各接口状态，或确认 Cookie / API Key 权限。
            </span>
          </div>
        )}

        {isProxyLatency && <Suspense fallback={<div className="lazy-panel-placeholder">正在加载代理测速…</div>}><ProxyLatencyPanel sites={sites} selectedSite={selectedSite} /></Suspense>}

        {isCodexSection && !isOverview && <Suspense fallback={<div className="lazy-panel-placeholder">正在加载 Codex 管理模块…</div>}><CodexWorkspace section={activeSection as CodexSection} /></Suspense>}

        {!isProxyLatency && !isCodexOnlySection && <section className={isOverview ? 'dashboard-grid overview-grid' : 'dashboard-grid section-grid'}>
          {showAccount && (
            <Panel className="account-panel" icon={<WalletCards size={18} />} title="账户数据">
              <div className="account-metrics">
                <Metric
                  accent="blue"
                  icon={<WalletCards size={16} />}
                  label="当前余额"
                  value={formatCny(snapshot.account.currentBalance)}
                  subValue={snapshot.account.quotaRaw ? `额度原值 ${formatCompact(snapshot.account.quotaRaw)}` : '账户可用额度'}
                />
                <Metric
                  accent="purple"
                  icon={<Activity size={16} />}
                  label="历史消耗"
                  value={formatCny(snapshot.account.historicalCost)}
                  subValue={subscriptionUsedRaw !== undefined && subscriptionUsedRaw > 0
                    ? `${formatNumber(snapshot.account.requestCount)} 次请求 · 含订阅 ${formatCny(snapshot.account.subscriptionUsed ?? 0)}`
                    : `${formatNumber(snapshot.account.requestCount)} 次请求`}
                />
              </div>
              {hasSubscriptionUsage && (
                <div className="subscription-usage-card">
                  <div className="subscription-head">
                    <span>订阅使用情况</span>
                  </div>
                  <div className="subscription-grid">
                    <div className="subscription-plan-row">
                      <span>订阅套餐</span>
                      <strong>{snapshot.account.subscriptionName ?? '-'}</strong>
                    </div>
                    <div>
                      <span>订阅剩余</span>
                      <strong>{snapshot.account.subscriptionRemainingRaw !== undefined ? formatNumber(snapshot.account.subscriptionRemainingRaw) : '-'}</strong>
                      <em>额度</em>
                    </div>
                    <div>
                      <span>订阅总额</span>
                      <strong>{snapshot.account.subscriptionTotalRaw !== undefined ? formatNumber(snapshot.account.subscriptionTotalRaw) : '-'}</strong>
                      <em>额度</em>
                    </div>
                  </div>
                </div>
              )}
            </Panel>
          )}

          {showSummary && (
            <Panel className="summary-panel" icon={<Activity size={18} />} title="使用统计（接口汇总）">
              <div className="summary-grid">
                <Metric
                  accent="cyan"
                  icon={<Database size={16} />}
                  label="真实消耗 Tokens"
                  value={formatNumber(scopedSnapshot.summary.realTokens)}
                  subValue={`≈ ${formatCompact(scopedSnapshot.summary.realTokens)}`}
                />
                <Metric accent="amber" icon={<WalletCards size={16} />} label="实际成本" value={formatUsd(scopedSnapshot.summary.cost)} subValue="按调用日志实际扣费汇总" />
                <Metric accent="green" icon={<Save size={16} />} label="缓存创建" value={formatNumber(scopedSnapshot.summary.cacheCreation)} subValue="cache write" />
                <Metric
                  accent="green"
                  icon={<Zap size={16} />}
                  label="缓存命中"
                  value={formatNumber(scopedSnapshot.summary.cacheHit)}
                  subValue={`命中率 ${(scopedSnapshot.summary.cacheHitRate * 100).toFixed(1)}%`}
                />
                <Metric accent="blue" icon={<Download size={16} />} label="输入" value={formatNumber(scopedSnapshot.summary.input)} subValue="含缓存读写" />
                <Metric accent="purple" icon={<Upload size={16} />} label="输出" value={formatNumber(scopedSnapshot.summary.output)} subValue="completion tokens" />
              </div>
            </Panel>
          )}

          {showTrend && (
            <Panel
              action={<span className="panel-total">范围：{activeTimeWindow.label}</span>}
              className="trend-panel"
              icon={<BarChart3 size={18} />}
              title="使用趋势"
            >
              {trendData.length ? (
                <div className="chart-area">
                  <ResponsiveContainer width="100%" height={isOverview ? 300 : 300}>
                    <AreaChart data={trendData} margin={{ top: 8, right: 10, bottom: 30, left: 0 }}>
                      <defs>
                        <linearGradient id="costGradient" x1="0" x2="0" y1="0" y2="1">
                          <stop offset="5%" stopColor="#f4779a" stopOpacity={0.4} />
                          <stop offset="95%" stopColor="#f4779a" stopOpacity={0} />
                        </linearGradient>
                      </defs>
                      <CartesianGrid stroke={chart.grid} strokeDasharray="3 3" />
                      <XAxis
                        dataKey="time"
                        ticks={trendAxisTicks}
                        interval={0}
                        height={58}
                        angle={-38}
                        textAnchor="end"
                        stroke={chart.axis}
                        tick={{ fontSize: 10, fill: chart.axis }}
                        tickFormatter={(value) => formatTrendAxisTick(String(value), trendBucketMs)}
                      />
                      <YAxis stroke={chart.axis} tick={{ fontSize: 12, fill: chart.axis }} />
                      <Tooltip contentStyle={tooltipStyle} formatter={chartTooltipFormatter} />
                      <Legend wrapperStyle={{ fontSize: 12, color: chart.axis }} />
                      <Area type="natural" dataKey="tokens" name="Tokens" stroke="#2f7df6" strokeWidth={2} fill="#2f7df6" fillOpacity={0.14} isAnimationActive={false} />
                      <Area type="natural" dataKey="cost" name="实际成本" stroke="#f4779a" strokeWidth={1.8} fill="url(#costGradient)" isAnimationActive={false} />
                      <Area type="natural" dataKey="cacheHit" name="缓存命中" stroke="#11b6a0" strokeWidth={1.8} fill="#11b6a0" fillOpacity={0.1} isAnimationActive={false} />
                      <Area type="natural" dataKey="input" name="输入(含缓存)" stroke="#38a2ff" strokeWidth={1.8} fill="#38a2ff" fillOpacity={0.08} isAnimationActive={false} />
                      <Area type="natural" dataKey="output" name="输出" stroke="#9f6bff" strokeWidth={1.8} fill="#9f6bff" fillOpacity={0.08} isAnimationActive={false} />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
              ) : (
                <EmptyState hint="连接站点并产生调用后，这里会显示 Tokens、成本与缓存的时间趋势。" />
              )}
            </Panel>
          )}

          {showModels && (
            <Panel
              action={<span className="panel-total">实际成本：{formatUsd(scopedSnapshot.summary.cost)}</span>}
              className="model-panel"
              icon={<Gauge size={18} />}
              title="模型消耗分布"
            >
              {modelChartData.points.length ? (
                <div className="chart-area">
                  <ResponsiveContainer width="100%" height={modelChartData.hiddenCount ? 278 : 300}>
                    <BarChart data={modelChartData.points} layout="vertical" margin={{ top: 8, right: 12, bottom: 8, left: 8 }}>
                      <CartesianGrid stroke={chart.grid} strokeDasharray="3 3" />
                      <XAxis type="number" stroke={chart.axis} tick={{ fontSize: 11, fill: chart.axis }} />
                      <YAxis dataKey="label" type="category" width={104} stroke={chart.axis} tick={{ fontSize: 11, fill: chart.axis }} interval={0} />
                      <Tooltip contentStyle={tooltipStyle} formatter={chartTooltipFormatter} labelFormatter={modelChartTooltipLabel} />
                      <Legend wrapperStyle={{ fontSize: 12, color: chart.axis }} />
                      <Bar dataKey="input" name="输入(含缓存)" stackId="tokens" fill="#2f7df6" />
                      <Bar dataKey="output" name="输出" stackId="tokens" fill="#11b6a0" />
                    </BarChart>
                  </ResponsiveContainer>
                  {modelChartData.hiddenCount > 0 && <div className="model-chart-note">已合并 {modelChartData.hiddenCount} 个低消耗模型到“其他模型”</div>}
                </div>
              ) : (
                <EmptyState hint="暂无模型消耗数据。" />
              )}
            </Panel>
          )}

          {showOverviewRail && (
            <aside className="overview-rail">
              <Panel
                action={
                  <button className="panel-icon-button" type="button" onClick={() => refreshSnapshot('manual')} aria-label="刷新可用性" disabled={loading}>
                    <RefreshCw className={loading ? 'spin' : ''} size={14} />
                  </button>
                }
                className="availability-panel"
                icon={<Server size={18} />}
                title="服务器可用性"
              >
                <AvailabilityList probes={snapshot.availability} />
              </Panel>

              <Panel
                className="rates-panel"
                icon={<SlidersHorizontal size={18} />}
                title="已用模型分组与倍率"
              >
                <RatesTable
                  compact
                  emptyHint="当前时间范围内暂无已用模型倍率；产生调用后会显示日志中的倍率。"
                  footerSuffix="个已用模型"
                  groups={usedRateGroups}
                />
              </Panel>
            </aside>
          )}

          {showAvailability && (
            <Panel
              action={
                <button className="panel-icon-button" type="button" onClick={() => refreshSnapshot('manual')} aria-label="刷新可用性" disabled={loading}>
                  <RefreshCw className={loading ? 'spin' : ''} size={14} />
                </button>
              }
              className="availability-panel"
              icon={<Server size={18} />}
              title="服务器可用性"
            >
              <AvailabilityList probes={snapshot.availability} />
            </Panel>
          )}

          {showRates && (
            <Panel
              action={
                <div className="panel-action-group">
                  {rateEditing && (
                    <button className="panel-edit-button" type="button" onClick={resetRateDrafts}>
                      重置
                    </button>
                  )}
                  <button className={rateEditing ? 'panel-edit-button active' : 'panel-edit-button'} type="button" onClick={() => setRateEditing((value) => !value)}>
                    <Edit3 size={13} />
                    {rateEditing ? '完成' : '编辑'}
                  </button>
                </div>
              }
              className="rates-panel"
              icon={<SlidersHorizontal size={18} />}
              title="已用模型分组与倍率"
            >
              <RatesTable
                drafts={rateDrafts}
                editable={rateEditing}
                emptyHint="当前时间范围内暂无已用模型倍率；产生调用后会显示日志中的倍率。"
                footerSuffix="个已用模型"
                groups={usedRateGroups}
                onDraftChange={updateRateDraft}
              />
            </Panel>
          )}

          {showCostShare && (
            <Panel className="pie-panel" icon={<Network size={18} />} title="成本占比">
              {scopedSnapshot.models.length ? (
                <div className="chart-area">
                  <ResponsiveContainer width="100%" height={214}>
                    <PieChart>
                      <Pie data={scopedSnapshot.models} dataKey="cost" nameKey="model" innerRadius={54} outerRadius={82} paddingAngle={3} isAnimationActive={false}>
                        {scopedSnapshot.models.map((model, index) => (
                          <Cell key={model.model} fill={palette[index % palette.length]} />
                        ))}
                      </Pie>
                      <Tooltip contentStyle={tooltipStyle} formatter={chartTooltipFormatter} />
                    </PieChart>
                  </ResponsiveContainer>
                </div>
              ) : (
                <EmptyState hint="暂无成本占比数据。" />
              )}
            </Panel>
          )}

          {showAnalytics && (
            <>
              <Panel className="analytics-kpi-panel" icon={<Activity size={18} />} title="分析概览">
                <div className="analysis-kpis">
                  <div className="analysis-kpi">
                    <span>平均成本 / 100万 Tokens</span>
                    <strong>{formatUsd(analytics.avgCostPerMillion)}</strong>
                    <em>越低越经济</em>
                  </div>
                  <div className="analysis-kpi">
                    <span>平均响应延迟</span>
                    <strong>{formatLatency(analytics.avgLatency)}</strong>
                    <em>按调用日志计算</em>
                  </div>
                  <div className="analysis-kpi">
                    <span>平均首字用时</span>
                    <strong>{formatLatency(analytics.avgFirstToken)}</strong>
                    <em>TTFT / 首字响应</em>
                  </div>
                  <div className="analysis-kpi">
                    <span>缓存覆盖率</span>
                    <strong>{percent(scopedSnapshot.summary.cacheHitRate)}</strong>
                    <em>缓存读 / 上下文输入</em>
                  </div>
                  <div className="analysis-kpi">
                    <span>成本最高模型</span>
                    <strong title={analytics.topModel?.model}>{analytics.topModel?.model ?? '-'}</strong>
                    <em>{analytics.topModel ? formatUsd(analytics.topModel.cost) : '暂无数据'}</em>
                  </div>
                  <div className="analysis-kpi">
                    <span>成本集中度</span>
                    <strong>{percent(analytics.topModelShare)}</strong>
                    <em>最高模型 / 总成本</em>
                  </div>
                  <div className="analysis-kpi">
                    <span>缓存节省估算</span>
                    <strong>{formatUsd(analytics.cacheSaving)}</strong>
                    <em>按当前均价折算</em>
                  </div>
                </div>
              </Panel>

              <Panel className="efficiency-panel" icon={<Gauge size={18} />} title="模型成本效率散点">
                <div className="chart-area">
                <ResponsiveContainer width="100%" height={286}>
                  <ScatterChart margin={{ top: 18, right: 18, bottom: 14, left: 8 }}>
                    <CartesianGrid stroke={chart.grid} strokeDasharray="3 3" />
                    <XAxis dataKey="tokens" name="Tokens" stroke={chart.axis} tick={{ fontSize: 12, fill: chart.axis }} />
                    <YAxis dataKey="costPerMillion" name="$/百万" stroke={chart.axis} tick={{ fontSize: 12, fill: chart.axis }} />
                    <ZAxis dataKey="requests" range={[70, 420]} name="请求数" />
                    <Tooltip cursor={{ strokeDasharray: '3 3' }} contentStyle={tooltipStyle} formatter={chartTooltipFormatter} />
                    <Scatter data={analytics.modelEfficiency} fill="#2f7df6" name="模型" />
                  </ScatterChart>
                </ResponsiveContainer>
                </div>
              </Panel>

              <Panel className="token-mix-panel" icon={<Network size={18} />} title="Token 结构占比">
                <div className="chart-area">
                <ResponsiveContainer width="100%" height={286}>
                  <PieChart>
                    <Pie data={analytics.tokenMix} dataKey="value" nameKey="name" innerRadius={58} outerRadius={88} paddingAngle={3} isAnimationActive={false}>
                      {analytics.tokenMix.map((item) => (
                        <Cell key={item.name} fill={item.fill} />
                      ))}
                    </Pie>
                    <Legend wrapperStyle={{ fontSize: 12, color: chart.axis }} />
                    <Tooltip contentStyle={tooltipStyle} formatter={chartTooltipFormatter} />
                  </PieChart>
                </ResponsiveContainer>
                </div>
              </Panel>

              <Panel className="radar-panel" icon={<SlidersHorizontal size={18} />} title="模型运营画像">
                <div className="chart-area">
                <ResponsiveContainer width="100%" height={286}>
                  <RadarChart data={analytics.radarModels} margin={{ top: 18, right: 46, bottom: 18, left: 46 }}>
                    <PolarGrid stroke={chart.grid} />
                    <PolarAngleAxis dataKey="model" tick={{ fill: chart.axis, fontSize: 11 }} />
                    <PolarRadiusAxis angle={30} domain={[0, 100]} tick={{ fill: chart.axis, fontSize: 10 }} />
                    <Radar dataKey="成本效率" name="成本效率" stroke="#2f7df6" fill="#2f7df6" fillOpacity={0.14} />
                    <Radar dataKey="缓存覆盖" name="缓存覆盖" stroke="#f7b723" fill="#f7b723" fillOpacity={0.12} />
                    <Radar dataKey="响应速度" name="响应速度" stroke="#11b6a0" fill="#11b6a0" fillOpacity={0.1} />
                    <Radar dataKey="首字速度" name="首字速度" stroke="#8b5cf6" fill="#8b5cf6" fillOpacity={0.08} />
                    <Legend wrapperStyle={{ fontSize: 12, color: chart.axis }} />
                    <Tooltip contentStyle={tooltipStyle} formatter={chartTooltipFormatter} />
                  </RadarChart>
                </ResponsiveContainer>
                </div>
              </Panel>

              <Panel className="model-token-panel" icon={<BarChart3 size={18} />} title="模型 Token 构成">
                <div className="chart-area">
                <ResponsiveContainer width="100%" height={268}>
                  <BarChart data={analytics.modelTokenStack} layout="vertical" margin={{ top: 8, right: 18, bottom: 8, left: 52 }}>
                    <CartesianGrid stroke={chart.grid} strokeDasharray="3 3" />
                    <XAxis type="number" stroke={chart.axis} tick={{ fontSize: 12, fill: chart.axis }} />
                    <YAxis dataKey="model" type="category" width={112} stroke={chart.axis} tick={{ fontSize: 11, fill: chart.axis }} />
                    <Tooltip contentStyle={tooltipStyle} formatter={chartTooltipFormatter} />
                    <Legend wrapperStyle={{ fontSize: 12, color: chart.axis }} />
                    <Bar dataKey="输入" name="输入(含缓存)" stackId="tokens" fill="#2f7df6" />
                    <Bar dataKey="输出" stackId="tokens" fill="#11b6a0" />
                  </BarChart>
                </ResponsiveContainer>
                </div>
              </Panel>

              <Panel className="time-heat-panel" icon={<Clock3 size={18} />} title="时段热力分布">
                <div className="heat-grid">
                  {analytics.timeBuckets.map((bucket) => (
                    <div
                      className="heat-cell"
                      key={bucket.name}
                      style={{
                        '--heat': 0.14 + Math.min(0.62, safeDivide(bucket.cost, Math.max(...analytics.timeBuckets.map((item) => item.cost), 1)) * 0.62),
                      } as CSSProperties}
                    >
                      <span>{bucket.name}</span>
                      <strong>{formatUsd(bucket.cost)}</strong>
                      <em>{formatNumber(bucket.tokens)} tokens</em>
                      <b>{bucket.count} 次</b>
                    </div>
                  ))}
                </div>
              </Panel>

              <Panel className="cache-rank-panel" icon={<Database size={18} />} title="缓存效率排行">
                <div className="analysis-list">
                  {analytics.cacheRanking.map((model) => (
                    <div className="analysis-row" key={model.model}>
                      <strong title={model.model}>{model.model}</strong>
                      <div className="bar-meter">
                        <span style={{ width: `${Math.min(100, model.cacheRate * 100)}%` }} />
                      </div>
                      <b>{percent(model.cacheRate)}</b>
                    </div>
                  ))}
                </div>
              </Panel>

              <Panel className="latency-panel" icon={<Clock3 size={18} />} title="延迟分布与成本">
                <div className="chart-area">
                <ResponsiveContainer width="100%" height={260}>
                  <BarChart data={analytics.latencyBuckets}>
                    <CartesianGrid stroke={chart.grid} strokeDasharray="3 3" />
                    <XAxis dataKey="name" stroke={chart.axis} tick={{ fontSize: 12, fill: chart.axis }} />
                    <YAxis stroke={chart.axis} tick={{ fontSize: 12, fill: chart.axis }} />
                    <Tooltip contentStyle={tooltipStyle} formatter={chartTooltipFormatter} />
                    <Legend wrapperStyle={{ fontSize: 12, color: chart.axis }} />
                    <Bar dataKey="count" name="请求数" fill="#2f7df6" />
                    <Bar dataKey="cost" name="成本" fill="#f4779a" />
                  </BarChart>
                </ResponsiveContainer>
                </div>
              </Panel>

              <Panel className="first-token-panel" icon={<Zap size={18} />} title="首字用时分布">
                <div className="chart-area">
                <ResponsiveContainer width="100%" height={260}>
                  <BarChart data={analytics.firstTokenBuckets}>
                    <CartesianGrid stroke={chart.grid} strokeDasharray="3 3" />
                    <XAxis dataKey="name" stroke={chart.axis} tick={{ fontSize: 12, fill: chart.axis }} />
                    <YAxis stroke={chart.axis} tick={{ fontSize: 12, fill: chart.axis }} />
                    <Tooltip contentStyle={tooltipStyle} formatter={chartTooltipFormatter} />
                    <Legend wrapperStyle={{ fontSize: 12, color: chart.axis }} />
                    <Bar dataKey="count" name="请求数" fill="#8b5cf6" />
                    <Bar dataKey="cost" name="成本" fill="#f7b723" />
                  </BarChart>
                </ResponsiveContainer>
                </div>
              </Panel>

              <Panel className="group-matrix-panel" icon={<WalletCards size={18} />} title="分组成本矩阵">
                <div className="matrix-grid">
                  {analytics.groupMatrix.map((group) => (
                    <div className="matrix-cell" key={group.group}>
                      <span>{group.group}</span>
                      <strong>{formatUsd(group.cost)}</strong>
                      <em>{formatNumber(group.tokens)} tokens</em>
                      <b>{group.requests} 次</b>
                    </div>
                  ))}
                </div>
              </Panel>

              <Panel className="risk-panel" icon={<ShieldCheck size={18} />} title="模型风险评分">
                <div className="analysis-list">
                  {analytics.modelRiskRows.map((model) => (
                    <div className="risk-row" key={model.model}>
                      <div>
                        <strong title={model.model}>{model.model}</strong>
                        <span>{model.reason} · {percent(model.costShare)}</span>
                      </div>
                      <div className="bar-meter">
                        <span style={{ width: `${Math.min(100, model.score * 100)}%` }} />
                      </div>
                      <b>{Math.round(model.score * 100)}</b>
                    </div>
                  ))}
                </div>
              </Panel>

              <Panel className="recommend-panel" icon={<Zap size={18} />} title="成本优化建议">
                <div className="recommend-list">
                  {analytics.recommendations.map((item) => (
                    <div className="recommend-row" key={item.title}>
                      <div>
                        <strong>{item.title}</strong>
                        <span>{item.detail}</span>
                      </div>
                      <b>{item.metric}</b>
                    </div>
                  ))}
                </div>
              </Panel>

              <Panel className="token-concentration-panel" icon={<KeyRound size={18} />} title="令牌成本集中度">
                <div className="analysis-list">
                  {analytics.tokenConcentration.map((token) => (
                    <div className="analysis-row" key={token.name}>
                      <strong title={token.name}>{token.name}</strong>
                      <div className="bar-meter">
                        <span style={{ width: `${Math.min(100, safeDivide(token.cost, scopedSnapshot.summary.cost) * 100)}%` }} />
                      </div>
                      <b>{percent(safeDivide(token.cost, scopedSnapshot.summary.cost))}</b>
                    </div>
                  ))}
                </div>
              </Panel>

              <Panel className="insight-panel" icon={<Search size={18} />} title="重点调用洞察">
                <div className="insight-list">
                  {analytics.anomalyRows.map((log) => (
                    <div className="insight-row" key={log.id}>
                      <div>
                        <strong>{log.model}</strong>
                        <span>{log.id} · {log.group}</span>
                      </div>
                      <b>{formatUsd(log.cost)}</b>
                      <em>{formatLatency(log.latencyMs)}</em>
                    </div>
                  ))}
                </div>
              </Panel>
            </>
          )}

          {showSettings && (
            <Panel className="settings-panel" icon={<Settings size={18} />} title="站点设置">
              <div className="app-preference-block">
                <div className="app-preference-copy">
                  <Power size={17} />
                  <div>
                    <strong>关闭窗口行为</strong>
                    <span>托盘模式下软件会继续执行自动刷新；可从托盘菜单重新打开或彻底退出。</span>
                  </div>
                </div>
                <select
                  value={closeBehavior}
                  aria-label="关闭窗口行为"
                  disabled={closePreferenceState === 'saving'}
                  onChange={(event) => void updateCloseBehavior(event.target.value as CloseBehavior)}
                >
                  <option value="ask">每次关闭时询问</option>
                  <option value="tray">关闭到系统托盘</option>
                  <option value="exit">直接退出软件</option>
                </select>
                <em className={`preference-state preference-${closePreferenceState}`}>
                  {closePreferenceState === 'saving'
                    ? '保存中…'
                    : closePreferenceState === 'saved'
                      ? '已保存'
                      : closePreferenceState === 'error'
                        ? '保存失败'
                        : ''}
                </em>
              </div>
              <div className="settings-grid">
                <label>
                  名称
                  <input value={draftSite.name} onChange={(event) => setDraftSite({ ...draftSite, name: event.target.value })} />
                </label>
                <label className="full-width">
                  Base URL
                  <input
                    className={draftErrors.baseUrl ? 'invalid' : ''}
                    value={draftSite.baseUrl}
                    placeholder="https://your-relay.com"
                    onChange={(event) => setDraftSite({ ...draftSite, baseUrl: event.target.value })}
                  />
                  {draftErrors.baseUrl && <span className="field-error">{draftErrors.baseUrl}</span>}
                </label>
                <div className="key-probe-editor full-width">
                  <div className="key-probe-editor-head">
                    <div>
                      <strong>API Key / 用户访问令牌</strong>
                      <span>默认 Key + {draftSite.apiKeyProbes?.length ?? 0} 个扩展 Key</span>
                    </div>
                    <div className="key-probe-actions">
                      <button className="mini-button" type="button" onClick={() => setShowKeyProbeEditor((prev) => !prev)}>
                        <SlidersHorizontal size={13} />
                        {showKeyProbeEditor ? '收起更多' : '检测更多'}
                      </button>
                      {showKeyProbeEditor && (
                        <>
                          <button className="mini-button" type="button" onClick={importApiKeyProbesFromTokens}>
                            <Upload size={13} />
                            导入令牌
                          </button>
                          <button className="mini-button" type="button" onClick={addApiKeyProbe}>
                            <Plus size={13} />
                            添加 Key
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                  {showKeyProbeEditor && tokenImportMessage && <div className="key-import-message">{tokenImportMessage}</div>}
                  <div className="key-probe-list">
                    <div className="key-probe-row key-probe-row-primary">
                      <div className="probe-primary">
                        <KeyRound size={14} />
                        <span>默认</span>
                      </div>
                      <label>
                        令牌名称
                        <input
                          list="token-name-options"
                          value={draftSite.apiKeyTokenName ?? ''}
                          placeholder="留空则自动匹配"
                          onChange={(event) => setDraftSite({ ...draftSite, apiKeyTokenName: event.target.value })}
                        />
                      </label>
                      <label>
                        API Key
                        <span className="secret-field">
                          <input
                            className={draftErrors.apiKey ? 'invalid' : ''}
                            value={draftSite.apiKey}
                            type={showSecret ? 'text' : 'password'}
                            autoComplete="off"
                            placeholder="sk-... 或用户访问令牌"
                            onChange={(event) => setDraftSite({ ...draftSite, apiKey: event.target.value })}
                          />
                          <button className="secret-toggle" type="button" onClick={() => setShowSecret((prev) => !prev)} aria-label={showSecret ? '隐藏敏感信息' : '显示敏感信息'}>
                            {showSecret ? <EyeOff size={15} /> : <Eye size={15} />}
                          </button>
                        </span>
                        {draftErrors.apiKey && <span className="field-error">{draftErrors.apiKey}</span>}
                      </label>
                      <span className="probe-row-spacer" aria-hidden="true" />
                    </div>
                    {showKeyProbeEditor && (draftSite.apiKeyProbes ?? []).map((probe) => (
                      <div className="key-probe-row" key={probe.id}>
                        <label className="probe-enable">
                          <input
                            type="checkbox"
                            checked={probe.enabled}
                            onChange={(event) => updateApiKeyProbe(probe.id, { enabled: event.target.checked })}
                          />
                          <span>启用</span>
                        </label>
                        <label>
                          令牌名称
                          <input
                            list="token-name-options"
                            value={probe.tokenName ?? probe.name}
                            placeholder="留空则自动匹配"
                            onChange={(event) => updateApiKeyProbe(probe.id, { tokenName: event.target.value })}
                          />
                        </label>
                        <label>
                          API Key
                          <span className="secret-field">
                            <input
                              value={probe.key}
                              type={showSecret ? 'text' : 'password'}
                              autoComplete="off"
                              placeholder="sk-..."
                              onChange={(event) => updateApiKeyProbe(probe.id, { key: event.target.value })}
                            />
                          </span>
                        </label>
                        <button className="panel-icon-button probe-remove" type="button" aria-label="删除扩展 Key" onClick={() => removeApiKeyProbe(probe.id)}>
                          <Trash2 size={14} />
                        </button>
                      </div>
                    ))}
                  </div>
                  {showKeyProbeEditor && !(draftSite.apiKeyProbes ?? []).length && (
                    <button className="empty-action" type="button" onClick={addApiKeyProbe}>
                      <Plus size={14} />
                      添加第一个扩展 Key
                    </button>
                  )}
                  <span className="field-hint">令牌名称用于绑定健康检测卡片和调用日志；留空时会尝试按完整 Key 自动匹配。</span>
                </div>
                <datalist id="token-name-options">
                  {availableTokenNames.map((tokenName) => (
                    <option key={tokenName} value={tokenName} />
                  ))}
                </datalist>
                <label>
                  用户 ID（New-Api-User，可选）
                  <input
                    className={draftErrors.userId ? 'invalid' : ''}
                    value={draftSite.userId ?? ''}
                    placeholder="后台用户 ID（纯数字）"
                    onChange={(event) => setDraftSite({ ...draftSite, userId: event.target.value })}
                  />
                  {draftErrors.userId ? (
                    <span className="field-error">{draftErrors.userId}</span>
                  ) : (
                    <span className="field-hint">账户接口失败时会尝试 /api/user/&lt;ID&gt;</span>
                  )}
                </label>
                <label>
                  Cookie / Session（可选）
                  <span className="secret-field">
                    <input
                      value={draftSite.cookie ?? ''}
                      type={showSecret ? 'text' : 'password'}
                      autoComplete="off"
                      placeholder="session=...; token=..."
                      onChange={(event) => setDraftSite({ ...draftSite, cookie: event.target.value })}
                    />
                    <button className="secret-toggle" type="button" onClick={() => setShowSecret((prev) => !prev)} aria-label={showSecret ? '隐藏敏感信息' : '显示敏感信息'}>
                      {showSecret ? <EyeOff size={15} /> : <Eye size={15} />}
                    </button>
                  </span>
                  <span className="field-hint">登录成功后会自动写入这里，仍可手动粘贴覆盖。</span>
                </label>
                <label>
                  New API 登录账号（可选）
                  <input
                    className={draftErrors.loginUsername ? 'invalid' : ''}
                    value={draftSite.loginUsername ?? ''}
                    autoComplete="username"
                    placeholder="后台登录账号 / 邮箱"
                    onChange={(event) => setDraftSite({ ...draftSite, loginUsername: event.target.value })}
                  />
                  {draftErrors.loginUsername && <span className="field-error">{draftErrors.loginUsername}</span>}
                </label>
                <label>
                  New API 登录密码（可选）
                  <span className="secret-field">
                    <input
                      className={draftErrors.loginPassword ? 'invalid' : ''}
                      value={draftSite.loginPassword ?? ''}
                      type={showSecret ? 'text' : 'password'}
                      autoComplete="current-password"
                      placeholder="用于刷新 Cookie"
                      onChange={(event) => setDraftSite({ ...draftSite, loginPassword: event.target.value })}
                    />
                    <button className="secret-toggle" type="button" onClick={() => setShowSecret((prev) => !prev)} aria-label={showSecret ? '隐藏敏感信息' : '显示敏感信息'}>
                      {showSecret ? <EyeOff size={15} /> : <Eye size={15} />}
                    </button>
                  </span>
                  {draftErrors.loginPassword && <span className="field-error">{draftErrors.loginPassword}</span>}
                </label>
                <label className="settings-toggle full-width">
                  <input
                    type="checkbox"
                    checked={Boolean(draftSite.autoLogin)}
                    onChange={(event) => setDraftSite({ ...draftSite, autoLogin: event.target.checked })}
                  />
                  <span>Cookie 失效时自动登录并刷新 Cookie</span>
                </label>
                <div className="login-actions full-width">
                  <button
                    className="icon-button"
                    type="button"
                    disabled={loginState.status === 'loading' || Boolean(draftErrors.baseUrl) || !draftSite.loginUsername?.trim() || !draftSite.loginPassword}
                    onClick={loginFromDraft}
                  >
                    <RefreshCw className={loginState.status === 'loading' ? 'spin' : undefined} size={16} />
                    登录获取 Cookie
                  </button>
                  {loginState.message ? (
                    <span className={`login-message login-${loginState.status}`}>{loginState.message}</span>
                  ) : (
                    <span className="field-hint">兼容 New API 的 /api/user/login；如站点启用验证码，请继续手动填写 Cookie。</span>
                  )}
                </div>
                <label>
                  类型
                  <select value={draftSite.kind} onChange={(event) => setDraftSite({ ...draftSite, kind: event.target.value as RelaySite['kind'] })}>
                    <option value="auto">自动识别</option>
                    <option value="new-api">New API / One API</option>
                    <option value="openai-compatible">OpenAI 兼容</option>
                  </select>
                </label>
                <label>
                  自动刷新（分钟）
                  <input
                    className={draftErrors.refreshMinutes ? 'invalid' : ''}
                    min={1}
                    type="number"
                    value={draftSite.refreshMinutes}
                    onChange={(event) => setDraftSite({ ...draftSite, refreshMinutes: Number(event.target.value) || 5 })}
                  />
                  {draftErrors.refreshMinutes && <span className="field-error">{draftErrors.refreshMinutes}</span>}
                </label>
              </div>
              <div className="settings-actions">
                <button className="icon-button" type="button" onClick={addSite}>
                  <Plus size={16} />
                  添加站点
                </button>
                <button className="icon-button primary" type="button" onClick={saveDraft}>
                  <Save size={16} />
                  保存配置
                </button>
                <button className="icon-button danger" type="button" disabled={sites.length <= 1} onClick={deleteSite}>
                  <Trash2 size={16} />
                  删除
                </button>
                {saveState === 'saved' && <span className="save-hint ok">已保存并应用</span>}
                {saveState === 'invalid' && <span className="save-hint warn">请先修正标红的必填项</span>}
                {storageError && <span className="save-hint warn">{storageError}</span>}
              </div>
            </Panel>
          )}

          {showSettings && (
            <Panel className="about-panel" icon={<Info size={18} />} title="关于 Codex_Ultura">
              <div className="about-body">
                <div className="about-product">
                  <div className="about-product-mark"><Zap size={22} /></div>
                  <div>
                    <strong>Codex_Ultura</strong>
                    <span>版本 v{appVersion}</span>
                  </div>
                </div>
                <p>统一管理中转站账户监控、Codex 供应商配置与 8787 热切换。</p>
                <div className="about-capabilities">
                  <span>Codex_Ultura 主题界面</span>
                  <span>Codex 兼容核心</span>
                  <span>本地优先存储</span>
                </div>
                <small>敏感配置仅用于本地请求，不会显示在诊断摘要或普通运行日志中。</small>
              </div>
            </Panel>
          )}

          {showLogs && (
            <Panel className="log-panel" icon={<KeyRound size={18} />} title="令牌与调用日志">
              <div className="log-toolbar">
                <select value={modelFilter} onChange={(event) => setModelFilter(event.target.value)}>
                  <option value="all">全部模型</option>
                  {availableModels.map((model) => (
                    <option key={model} value={model}>
                      {model}
                    </option>
                  ))}
                </select>
                <select value={tokenFilter} onChange={(event) => setTokenFilter(event.target.value)}>
                  <option value="all">全部令牌</option>
                  <option value={CURRENT_API_KEY_TOKEN_FILTER} disabled={!apiKeyTokenName}>
                    {apiKeyTokenName ? `当前 API Key：${apiKeyTokenName}` : '当前 API Key：未匹配'}
                  </option>
                  {availableTokenNames.map((tokenName) => (
                    <option key={tokenName} value={tokenName}>
                      {tokenName}
                    </option>
                  ))}
                </select>
                <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}>
                  <option value="all">全部状态</option>
                  <option value="success">成功</option>
                  <option value="error">失败</option>
                </select>
                <label className="search-field">
                  <Search size={15} />
                  <input value={logQuery} placeholder="搜索模型 / 令牌 / 请求 ID" onChange={(event) => setLogQuery(event.target.value)} />
                </label>
                <button className="table-button" type="button" onClick={exportFilteredLogs} disabled={!filteredLogs.length}>
                  <Download size={14} />
                  导出
                </button>
              </div>
              {snapshot.keyChecks.length > 0 && (
                <div className="key-check-strip">
                  {snapshot.keyChecks.map((check) => (
                    <button
                      className={`key-check-card key-check-${check.status}`}
                      type="button"
                      key={check.id}
                      onClick={() => {
                        if (check.tokenName) {
                          setTokenFilter(check.tokenName)
                        }
                      }}
                      disabled={!check.tokenName}
                      title={check.detail}
                    >
                      <span className="key-check-top">
                        <strong>{check.name}</strong>
                        <b>{keyCheckStatusText(check.status)}</b>
                      </span>
                      <span className="key-check-meta">
                        {check.id === 'primary' ? '默认 API Key' : '扩展 API Key'}
                        {check.tokenName ? ` · ${check.tokenName}` : ''}
                      </span>
                      <span className={`key-check-health key-health-${keyHealthTone(check.healthScore)}`}>
                        <span>
                          健康度 <b>{check.healthLabel}</b>
                        </span>
                        <strong>{check.healthScore}%</strong>
                        <i aria-hidden="true">
                          <em style={{ width: `${Math.max(0, Math.min(100, check.healthScore))}%` }} />
                        </i>
                      </span>
                      <span className="key-check-stats">
                        <em>{formatLatency(check.latencyMs)}</em>
                        <em>{formatNumber(check.models)} 模型</em>
                        <em>{formatNumber(check.requests)} 次</em>
                        <em>成功率 {check.successRate === null ? '无调用' : percent(check.successRate)}</em>
                        <em className={check.errors > 0 ? 'danger-text' : undefined}>失败 {formatNumber(check.errors)}</em>
                      </span>
                      <span className="key-check-foot">
                        <small>{formatNumber(check.tokens)} Tokens</small>
                        <small>{formatUsd(check.cost)}</small>
                      </span>
                    </button>
                  ))}
                </div>
              )}
              {filteredLogs.length ? (
                <div className="table-wrap">
                  <table className="usage-log-table">
                    <thead>
                      <tr>
                        <th>时间</th>
                        <th>令牌名称</th>
                        <th>模型</th>
                        <th>分组</th>
                        <th>请求 ID</th>
                        <th>状态</th>
                        <th>输入 Tokens</th>
                        <th>输出 Tokens</th>
                        <th>真实总 Tokens</th>
                        <th>实际成本($)</th>
                        <th>缓存</th>
                        <th>响应耗时</th>
                        <th>操作</th>
                      </tr>
                    </thead>
                    <tbody>
                      {visibleLogs.map((log) => (
                        <tr key={log.id}>
                          <td title={log.time}>{formatLogTime(log.time)}</td>
                          <td>{log.tokenName}</td>
                          <td>{log.model}</td>
                          <td>{log.group}</td>
                          <td title={log.id}>{log.id}</td>
                          <td>
                            <span className={`log-state log-${log.status}`} title={logStatusTitle(log)}>{logStatusText(log.status)}</span>
                          </td>
                          <td>{formatNumber(log.input)}</td>
                          <td>{formatNumber(log.output)}</td>
                          <td>{formatNumber(log.total)}</td>
                          <td>{formatUsd(log.cost)}</td>
                          <td>
                            {log.cacheHit > 0 || log.cacheCreation > 0 ? (
                              <span className="cache-cell">
                                {log.cacheHit > 0 && <b>读 {formatNumber(log.cacheHit)}</b>}
                                {log.cacheCreation > 0 && <em>写 {formatNumber(log.cacheCreation)}</em>}
                              </span>
                            ) : (
                              '-'
                            )}
                          </td>
                          <td>
                            <span className="latency-cell">
                              <strong className="timing-badges">
                                <span className={`timing-badge timing-${totalTimingLevel(log)}`} title="总响应时间">
                                  <i>总</i>{formatTimingBadge(log.latencyMs)}
                                </span>
                                <span className={`timing-badge timing-${firstTokenTimingLevel(log.firstTokenMs)}`} title="首字响应时间（FRT）">
                                  <i>首</i>{formatTimingBadge(log.firstTokenMs)}
                                </span>
                              </strong>
                              <em>{formatConversationMeta(log)}</em>
                            </span>
                          </td>
                          <td><button className="detail-button" type="button" onClick={() => setSelectedLog(log)}>详情</button></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <EmptyState
                  hint={timeScopedLogs.length === 0 ? '当前时间范围内没有调用记录。' : '没有符合筛选条件的日志，试试调整模型、状态或搜索关键字。'}
                />
              )}
              <div className="table-footer">
                <span>
                  {filteredLogs.length
                    ? `显示第 ${formatNumber(logStartIndex + 1)}-${formatNumber(logEndIndex)} 条，共 ${formatNumber(filteredLogs.length)} 条`
                    : '共 0 条'}
                </span>
                <div className="pager">
                  <button type="button" onClick={() => setLogPage((page) => Math.max(1, page - 1))} disabled={safeLogPage <= 1}><ChevronLeft size={14} /></button>
                  <button className="pager-active" type="button">{safeLogPage} / {logTotalPages}</button>
                  <button type="button" onClick={() => setLogPage((page) => Math.min(logTotalPages, page + 1))} disabled={safeLogPage >= logTotalPages}><ChevronRight size={14} /></button>
                </div>
                <select value={logPageSize} onChange={(event) => setLogPageSize(Number(event.target.value))}>
                  <option value="20">20 条/页</option>
                  <option value="50">50 条/页</option>
                  <option value="100">100 条/页</option>
                </select>
              </div>
            </Panel>
          )}

          {isOverview && (
            <div className="overview-codex-tail">
              <Suspense fallback={<div className="lazy-panel-placeholder">正在加载 Codex 管理模块…</div>}>
                <CodexWorkspace section="概览" />
              </Suspense>
            </div>
          )}

          {showSources && (
            <Panel className="source-panel" icon={<Database size={18} />} title="接口来源">
              <div className="source-grid">
                {snapshot.sources.map((source) => (
                  <div className="source-row" key={`${source.label}:${source.endpoint}`}>
                    <span className={sourceTagClass(source)}>{sourceTagText(source)}</span>
                    <strong>{source.label}</strong>
                    <em title={source.detail ? `${source.endpoint} · ${source.detail}` : source.endpoint}>
                      {source.detail ? `${source.endpoint} · ${source.detail}` : source.endpoint}
                    </em>
                    <b>{source.durationMs}ms</b>
                  </div>
                ))}
              </div>
              {snapshot.errors.length > 0 && (
                <div className="error-list">
                  {snapshot.errors.slice(0, 4).map((error) => (
                    <div className="error-banner" key={error}>
                      <AlertTriangle size={15} />
                      <span>{error}</span>
                    </div>
                  ))}
                </div>
              )}
            </Panel>
          )}
        </section>}
      </section>
      </div>
      {closePromptOpen && (
        <div className="modal-backdrop close-modal-backdrop" role="presentation" onMouseDown={() => void handleCloseResolution('cancel')}>
          <section className="close-choice-modal" role="dialog" aria-modal="true" aria-labelledby="close-choice-title" onMouseDown={(event) => event.stopPropagation()}>
            <header>
              <div>
                <span>关闭软件</span>
                <strong id="close-choice-title">关闭窗口后要执行什么操作？</strong>
              </div>
              <button className="panel-icon-button" type="button" onClick={() => void handleCloseResolution('cancel')} aria-label="取消关闭">
                <X size={15} />
              </button>
            </header>
            <div className="close-choice-options">
              <button type="button" disabled={closePromptBusy} onClick={() => void handleCloseResolution('tray')}>
                <span className="close-choice-icon tray"><Minimize2 size={22} /></span>
                <span>
                  <strong>最小化到系统托盘</strong>
                  <em>隐藏主窗口，自动刷新和后台检测继续运行</em>
                </span>
                <ChevronRight size={16} />
              </button>
              <button type="button" disabled={closePromptBusy} onClick={() => void handleCloseResolution('exit')}>
                <span className="close-choice-icon exit"><Power size={22} /></span>
                <span>
                  <strong>直接退出软件</strong>
                  <em>结束所有刷新、测速和后台任务</em>
                </span>
                <ChevronRight size={16} />
              </button>
            </div>
            <footer>
              <label>
                <input type="checkbox" checked={closePromptRemember} onChange={(event) => setClosePromptRemember(event.target.checked)} />
                <span>记住本次选择，可在“设置”中修改</span>
              </label>
              <button type="button" disabled={closePromptBusy} onClick={() => void handleCloseResolution('cancel')}>取消</button>
            </footer>
            {closePromptError && <div className="close-prompt-error">{closePromptError}</div>}
          </section>
        </div>
      )}
      {selectedLog && (
        <div className="modal-backdrop" role="presentation" onMouseDown={() => setSelectedLog(null)}>
          <section className="detail-modal" role="dialog" aria-modal="true" aria-label="调用详情" onMouseDown={(event) => event.stopPropagation()}>
            <header>
              <div>
                <span>调用详情</span>
                <strong title={selectedLog.id}>{selectedLog.id}</strong>
              </div>
              <button className="panel-icon-button" type="button" onClick={() => setSelectedLog(null)} aria-label="关闭详情">
                ×
              </button>
            </header>
            <div className="detail-grid">
              <div><span>时间</span><strong title={selectedLog.time}>{formatLogTime(selectedLog.time)}</strong></div>
              <div><span>状态</span><strong>{logStatusText(selectedLog.status)}</strong></div>
              {selectedLog.errorCode !== undefined && <div className="detail-error"><span>错误码</span><strong>HTTP {selectedLog.errorCode}</strong></div>}
              {selectedLog.errorMessage && <div className="detail-error detail-wide"><span>错误原因</span><strong title={selectedLog.errorMessage}>{selectedLog.errorMessage}</strong></div>}
              <div><span>模型</span><strong title={selectedLog.model}>{selectedLog.model}</strong></div>
              <div><span>分组</span><strong>{selectedLog.group}</strong></div>
              <div><span>令牌</span><strong title={selectedLog.tokenName}>{selectedLog.tokenName}</strong></div>
              <div><span>IP</span><strong>{selectedLog.ip}</strong></div>
              <div><span>输入 Tokens（含缓存读写）</span><strong>{formatNumber(selectedLog.input)}</strong></div>
              <div><span>输出 Tokens</span><strong>{formatNumber(selectedLog.output)}</strong></div>
              <div><span>真实总 Tokens</span><strong>{formatNumber(selectedLog.total)}</strong></div>
              <div><span>实际成本</span><strong>{formatUsd(selectedLog.cost)}</strong></div>
              <div><span>缓存创建</span><strong>{formatNumber(selectedLog.cacheCreation)}</strong></div>
              <div><span>缓存命中</span><strong>{formatNumber(selectedLog.cacheHit)}</strong></div>
              <div className="detail-wide detail-timing">
                <span>响应时间</span>
                <strong className={`timing-${totalTimingLevel(selectedLog)}`}>{formatResponseTiming(selectedLog)}</strong>
              </div>
              <div className="detail-reasoning">
                <span>推理强度</span>
                <strong title="取自调用日志的 reasoning_effort 字段">{selectedLog.reasoningEffort ?? '-'}</strong>
              </div>
              <div><span>对话类型</span><strong>{formatConversationType(selectedLog.isStream)}</strong></div>
              <div><span>输出速度</span><strong>{formatOutputSpeed(selectedLog.outputTokensPerSecond)}</strong></div>
              <div><span>综合倍率</span><strong>{formatRatio(selectedLog.ratio)}</strong></div>
              <div><span>模型倍率</span><strong>{formatRatio(selectedLog.modelRatio)}</strong></div>
              <div><span>分组倍率</span><strong>{formatRatio(selectedLog.groupRatio)}</strong></div>
              <div><span>输出倍率</span><strong>{formatRatio(selectedLog.completionRatio)}</strong></div>
            </div>
            {(selectedLog.billingType === 'subscription' || selectedLog.subscriptionRemaining !== undefined || selectedLog.subscriptionFinalDeduct !== undefined) && (
              <div className="detail-subscription">
                <div className="detail-subscription-title">
                  <span>订阅计费</span>
                  <strong>{selectedLog.subscriptionPlan ?? '订阅套餐'}</strong>
                </div>
                <div className="detail-subscription-grid">
                  {selectedLog.subscriptionInstance && <div><span>订阅实例</span><strong>{selectedLog.subscriptionInstance}</strong></div>}
                  {selectedLog.subscriptionPreDeduct !== undefined && <div><span>预扣</span><strong>{formatNumber(selectedLog.subscriptionPreDeduct)} 额度</strong></div>}
                  {selectedLog.subscriptionSettleDelta !== undefined && <div><span>结算差额</span><strong>{formatNumber(selectedLog.subscriptionSettleDelta)} 额度</strong></div>}
                  {selectedLog.subscriptionFinalDeduct !== undefined && <div><span>最终抵扣</span><strong>{formatNumber(selectedLog.subscriptionFinalDeduct)} 额度</strong></div>}
                  {(selectedLog.subscriptionRemaining !== undefined || selectedLog.subscriptionTotal !== undefined) && (
                    <div>
                      <span>订阅剩余</span>
                      <strong>
                        {selectedLog.subscriptionRemaining !== undefined ? formatNumber(selectedLog.subscriptionRemaining) : '-'}
                        {selectedLog.subscriptionTotal !== undefined ? ` / ${formatNumber(selectedLog.subscriptionTotal)}` : ''}
                        {' '}额度
                      </strong>
                    </div>
                  )}
                </div>
                {selectedLog.billingDetail && <p>{selectedLog.billingDetail}</p>}
                {selectedLog.subscriptionDescription && <p>{selectedLog.subscriptionDescription}</p>}
              </div>
            )}
          </section>
        </div>
      )}
    </main>
  )
}

function Panel({
  action,
  children,
  className,
  icon,
  title,
}: {
  action?: ReactNode
  children: ReactNode
  className?: string
  icon: ReactNode
  title: string
}) {
  return (
    <section className={`panel ${className ?? ''}`}>
      <header className="panel-header">
        <div>
          {icon}
          <h2>{title}</h2>
        </div>
        {action}
      </header>
      {children}
    </section>
  )
}

function Metric({
  accent,
  icon,
  label,
  subValue,
  value,
}: {
  accent: 'amber' | 'blue' | 'cyan' | 'green' | 'purple'
  icon?: ReactNode
  label: string
  subValue: string
  value: string
}) {
  return (
    <div className="metric">
      <span className={`metric-icon metric-${accent}`}>{icon}</span>
      <div>
        <span>{label}</span>
        <strong>{value}</strong>
        <em>{subValue}</em>
      </div>
    </div>
  )
}

function EmptyState({ hint }: { hint: string }) {
  return (
    <div className="empty-state">
      <Inbox size={22} />
      <strong>暂无数据</strong>
      <span>{hint}</span>
    </div>
  )
}

function AvailabilityList({ probes }: { probes: UsageSnapshot['availability'] }) {
  if (!probes.length) {
    return <EmptyState hint="暂无可用性探测结果。" />
  }
  return (
    <div className="availability-list">
      <div className="availability-head">
        <span>服务器</span>
        <span>状态</span>
        <span>可用率</span>
      </div>
      {probes.slice(0, 6).map((probe) => (
        <div className="availability-row" key={probe.name} title={probe.detail}>
          <div>
            <strong>{probe.name}</strong>
          </div>
          <div className="availability-meta">
            <span className={statusClass(probe.status)} />
            <b>{statusLabel(probe.status)}</b>
          </div>
          <em>{probe.availability ? availabilityPercent(probe.availability) : '-'}</em>
        </div>
      ))}
    </div>
  )
}

function RatesTable({
  compact,
  drafts,
  editable,
  emptyHint = '暂无模型倍率数据，请确认 /api/pricing 或 /api/ratio_config 是否可用。',
  footerSuffix = '个分组',
  groups,
  onDraftChange,
}: {
  compact?: boolean
  drafts?: RateDrafts
  editable?: boolean
  emptyHint?: string
  footerSuffix?: string
  groups: UsageSnapshot['groups']
  onDraftChange?: (key: string, field: RateDraftField, value: string) => void
}) {
  if (!groups.length) {
    return <EmptyState hint={emptyHint} />
  }
  return (
    <div className="rate-table">
      {editable && (
        <div className="rate-edit-note">
          本地编辑只影响当前展示，用于校准倍率预览；刷新后仍以中转站接口返回值为准。
        </div>
      )}
      {compact ? (
        <div className="rate-summary rate-summary-compact">
          <span>分组 / 模型</span>
          <span>倍率</span>
        </div>
      ) : (
        <div className="rate-summary">
          <span>分组</span>
          <span>模型</span>
          <span>倍率</span>
        </div>
      )}
      {groups.slice(0, compact ? 5 : 14).map((sourceRate) => {
        const key = rateKey(sourceRate)
        const draft = drafts?.[key]
        const rate = mergedRate(sourceRate, draft)
        return (
          <div className={compact ? 'rate-row rate-row-compact' : 'rate-row'} key={`${rate.group}:${rate.model}`}>
            <div className="rate-main">
              <span title={rate.availableGroups?.join('、') || rate.group}>{rate.group}</span>
              <strong title={rate.model}>{rate.model}</strong>
            </div>
            {compact ? (
              <b className="rate-pill">{formatRatio(rate.ratio)}</b>
            ) : editable ? (
              <div className="rate-edit-grid">
                <label>
                  <span>模型</span>
                  <input
                    inputMode="decimal"
                    value={rateDraftValue(sourceRate, draft, 'modelRatio')}
                    onChange={(event) => onDraftChange?.(key, 'modelRatio', event.target.value)}
                  />
                </label>
                <label>
                  <span>分组</span>
                  <input
                    inputMode="decimal"
                    value={rateDraftValue(sourceRate, draft, 'groupRatio')}
                    onChange={(event) => onDraftChange?.(key, 'groupRatio', event.target.value)}
                  />
                </label>
                <label>
                  <span>输出</span>
                  <input
                    inputMode="decimal"
                    value={rateDraftValue(sourceRate, draft, 'completionRatio')}
                    onChange={(event) => onDraftChange?.(key, 'completionRatio', event.target.value)}
                  />
                </label>
                <label>
                  <span>缓存</span>
                  <input
                    inputMode="decimal"
                    value={rateDraftValue(sourceRate, draft, 'cacheRatio')}
                    onChange={(event) => onDraftChange?.(key, 'cacheRatio', event.target.value)}
                  />
                </label>
                <b className="rate-primary">综合 {formatRatio(rate.ratio)}</b>
              </div>
            ) : (
              <div className="rate-badges">
                <b className="rate-primary">综合 {formatRatio(rate.ratio)}</b>
                <b>模型 {formatRatio(rate.modelRatio)}</b>
                <b>分组 {formatRatio(rate.groupRatio)}</b>
                {rate.completionRatio !== undefined && <b>输出 {formatRatio(rate.completionRatio)}</b>}
                {rate.cacheRatio !== undefined && <b>缓存 {formatRatio(rate.cacheRatio)}</b>}
                {rate.modelPrice !== undefined && <b>定价 {formatDecimal(rate.modelPrice)}</b>}
              </div>
            )}
          </div>
        )
      })}
      <div className="rate-footer">共 {groups.length} {footerSuffix}</div>
    </div>
  )
}

export default App
