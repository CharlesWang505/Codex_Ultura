import { createDemoSnapshot } from './sampleData'
import { isTauriRuntime, relayRequest } from './desktop'
import { normalizeDurationValueMs } from './duration'
import {
  asRecord,
  classifySource,
  collectNestedRecords,
  extractList,
  normalizeCacheTokens,
  pickNumber,
  pickNumberDeep,
  pickNumberDeepWithKey,
  pickString,
  pickStringDeep,
  quotaToCurrency,
  quotaUnitsToCurrency,
  unwrapData,
  type PlainRecord,
} from './normalize'
import type {
  AccountData,
  ApiKeyProbe,
  ApiKeyProbeResult,
  AvailabilityProbe,
  EndpointSource,
  GroupRate,
  ModelUsage,
  RelaySite,
  RequestInput,
  RequestResult,
  SourceStatus,
  TokenRecord,
  TrendPoint,
  UsageLog,
  UsageSnapshot,
  UsageSummary,
} from '../types'

const ZERO_ACCOUNT: AccountData = {
  currentBalance: 0,
  historicalCost: 0,
  requestCount: 0,
  username: '未登录',
  group: 'unknown',
}

const ZERO_SUMMARY: UsageSummary = {
  realTokens: 0,
  cost: 0,
  cacheCreation: 0,
  cacheHit: 0,
  input: 0,
  output: 0,
  cacheHitRate: 0,
  totalRequests: 0,
}

const LOG_PAGE_SIZE = 100
const MAX_LOG_ROWS = 30000
const MAX_LOG_PAGES = Math.ceil(MAX_LOG_ROWS / LOG_PAGE_SIZE)
const LOG_PAGE_CONCURRENCY = 12

export type UsageFetchRange = {
  startTimestamp: number
  endTimestamp: number
  label: string
}

export type UsageFetchProgress =
  | {
      kind: 'logs'
      logs: UsageLog[]
      loadedLogs: number
      totalLogs?: number
    }
  | {
      kind: 'groups'
      groups: GroupRate[]
    }
  | {
      kind: 'keyChecks'
      keyChecks: ApiKeyProbeResult[]
      completedKeyChecks: number
      totalKeyChecks: number
    }

function normalizeBaseUrl(baseUrl: string) {
  const trimmed = baseUrl.trim().replace(/\/+$/, '')
  return trimmed || 'https://'
}

function endpointUrl(site: RelaySite, path: string) {
  return `${normalizeBaseUrl(site.baseUrl)}${path}`
}

async function sendRequest(input: RequestInput): Promise<RequestResult> {
  if (isTauriRuntime()) {
    return relayRequest(input)
  }

  const startedAt = performance.now()
  const controller = new AbortController()
  const timeout = window.setTimeout(() => controller.abort(), input.timeoutMs ?? 12000)

  try {
    const response = await fetch(input.url, {
      method: input.method ?? 'GET',
      headers: input.headers,
      body: input.body === undefined ? undefined : JSON.stringify(input.body),
      credentials: 'include',
      signal: controller.signal,
    })
    const text = await response.text()
    let data: unknown = null

    try {
      data = text ? JSON.parse(text) : null
    } catch {
      data = text
    }

    const headers: Record<string, string> = {}
    if (input.includeHeaders) {
      response.headers.forEach((value, key) => {
        headers[key.toLowerCase()] = value
      })
    }

    return {
      ok: response.ok,
      status: response.status,
      statusText: response.statusText,
      data,
      durationMs: performance.now() - startedAt,
      headers: input.includeHeaders ? headers : undefined,
    }
  } catch (error) {
    return {
      ok: false,
      status: 0,
      statusText: error instanceof Error ? error.message : 'Request failed',
      data: null,
      durationMs: performance.now() - startedAt,
    }
  } finally {
    window.clearTimeout(timeout)
  }
}

function authHeaders(site: RelaySite, path: string) {
  const headers: Record<string, string> = {}
  const apiKey = site.apiKey.trim()
  const userId = site.userId?.trim()
  const cookie = site.cookie?.trim()
  const preferCookie = Boolean(cookie && path.startsWith('/api/'))

  if (apiKey && !preferCookie) {
    headers.Authorization = `Bearer ${apiKey}`
  }

  if (userId) {
    headers['New-Api-User'] = userId
  }

  if (cookie) {
    headers.Cookie = cookie
  }

  return headers
}

async function request(input: { site: RelaySite; path: string; label: string; timeoutMs?: number }) {
  const url = endpointUrl(input.site, input.path)
  const headers = authHeaders(input.site, input.path)
  const result = await sendRequest({
    url,
    headers,
    timeoutMs: input.timeoutMs ?? 12000,
  })
  return { source: sourceFromResult(input.label, input.path, result), result }
}

export type NewApiLoginResult = {
  ok: boolean
  message: string
  cookie?: string
  token?: string
  userId?: string
}

function getHeaderValue(headers: Record<string, string> | undefined, name: string) {
  const target = name.toLowerCase()
  return Object.entries(headers ?? {}).find(([key]) => key.toLowerCase() === target)?.[1]
}

function setCookieParts(header: string) {
  return header
    .split(/\r?\n/)
    .flatMap((line) => line.split(/,(?=\s*[^;,=\s]+=)/g))
    .map((part) => part.trim())
    .filter(Boolean)
}

function cookieHeaderFromSetCookie(header: string | undefined) {
  const seen = new Set<string>()
  const pairs: string[] = []
  const attributeNames = new Set(['path', 'expires', 'max-age', 'domain', 'samesite', 'secure', 'httponly'])

  for (const part of setCookieParts(header ?? '')) {
    const pair = part.split(';')[0]?.trim()
    const separator = pair?.indexOf('=') ?? -1
    if (!pair || separator <= 0) {
      continue
    }

    const name = pair.slice(0, separator).trim()
    const key = name.toLowerCase()
    if (attributeNames.has(key) || seen.has(key)) {
      continue
    }

    seen.add(key)
    pairs.push(pair)
  }

  return pairs.join('; ')
}

function extractLoginToken(value: unknown) {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    return trimmed.length > 12 ? trimmed : undefined
  }

  return pickStringDeep(collectRecordsDeep(value), [
    'token',
    'access_token',
    'accessToken',
    'user_access_token',
    'userAccessToken',
    'session_token',
    'sessionToken',
    'jwt',
  ]) || undefined
}

function extractLoginUserId(value: unknown) {
  const userId = pickStringDeep(collectRecordsDeep(value), ['id', 'user_id', 'userId', 'uid'])
  return /^\d+$/.test(userId) ? userId : undefined
}

function loginFailureMessage(result: RequestResult, apiError: string | null) {
  if (apiError) {
    return `登录失败：${apiError}`
  }
  if (result.status === 401 || result.status === 403) {
    return `登录失败（HTTP ${result.status}）：账号或密码错误，或该站点禁止密码登录`
  }
  if (result.status === 404) {
    return '登录失败：当前站点没有 /api/user/login 接口，请确认它是否兼容 New API'
  }
  if (result.status === 0) {
    return `登录请求失败：${result.statusText || '网络异常或请求超时'}`
  }
  return `登录失败：HTTP ${result.status} ${result.statusText || '请求失败'}`
}

export async function loginNewApi(site: RelaySite, username: string, password: string): Promise<NewApiLoginResult> {
  const loginName = username.trim()
  if (!loginName || !password) {
    return { ok: false, message: '请先填写 New API 登录账号和密码' }
  }

  const result = await sendRequest({
    url: endpointUrl(site, '/api/user/login'),
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: {
      username: loginName,
      password,
    },
    timeoutMs: 15000,
    includeHeaders: true,
  })
  const apiError = apiFailureMessage(result.data)

  if (!result.ok || apiError) {
    return { ok: false, message: loginFailureMessage(result, apiError) }
  }

  const cookie = cookieHeaderFromSetCookie(getHeaderValue(result.headers, 'set-cookie'))
  const token = extractLoginToken(result.data)
  const userId = extractLoginUserId(result.data)

  if (!cookie && !token) {
    return {
      ok: false,
      message: '登录成功，但站点没有返回可用 Cookie 或用户访问令牌；若站点启用了验证码或两步验证，请继续手动填写 Cookie',
    }
  }

  return {
    ok: true,
    message: cookie ? '登录成功，已更新 Cookie' : '登录成功，已获取用户访问令牌',
    cookie,
    token,
    userId,
  }
}

function extractLogTotal(value: unknown) {
  const record = asRecord(unwrapData(value))
  const total = pickNumber(record, ['total', 'total_count', 'totalCount', 'records_total', 'recordsTotal'])
  return total !== undefined && total >= 0 ? Math.floor(total) : undefined
}

function logPageRowIdentity(value: unknown, index: number) {
  const record = asRecord(value)
  const id = pickString(record, ['id', 'request_id', 'requestId'])
  if (id) {
    return `id:${id}`
  }
  return [
    pickString(record, ['created_at', 'createdAt', 'time', 'timestamp']),
    pickString(record, ['model_name', 'model', 'modelName']),
    pickString(record, ['token_name', 'tokenName', 'key_name', 'keyName']),
    index,
  ].join('|')
}

function logPagesOverlap(leftValue: unknown, rightValue: unknown) {
  const leftRows = extractList(leftValue)
  const rightRows = extractList(rightValue)
  if (!leftRows.length || !rightRows.length) {
    return false
  }

  const leftIds = new Set(leftRows.map(logPageRowIdentity))
  const overlap = rightRows.reduce<number>(
    (count, row, index) => count + (leftIds.has(logPageRowIdentity(row, index)) ? 1 : 0),
    0,
  )
  return overlap / Math.min(leftRows.length, rightRows.length) >= 0.8
}

function yieldToProgressPaint() {
  return new Promise<void>((resolve) => setTimeout(resolve, 0))
}

async function fetchLogPages(
  site: RelaySite,
  start: number,
  end: number,
  onProgress?: (progress: UsageFetchProgress) => void,
) {
  const startedAt = Date.now()
  const results: RequestResult[] = []
  const first = await request({
    site,
    label: '调用日志',
    path: `/api/log/self?p=0&size=${LOG_PAGE_SIZE}&start_timestamp=${start}&end_timestamp=${end}`,
    timeoutMs: 15000,
  })
  results.push(first.result)

  let loadedRows = extractList(first.result.data).length
  const reportedTotal = extractLogTotal(first.result.data)
  const totalRows = reportedTotal !== undefined
    ? Math.min(reportedTotal, MAX_LOG_ROWS)
    : loadedRows < LOG_PAGE_SIZE
      ? loadedRows
      : undefined

  if (first.source.ok) {
    onProgress?.({
      kind: 'logs',
      logs: parseLogs(results, undefined, undefined, start, end),
      loadedLogs: Math.min(loadedRows, MAX_LOG_ROWS),
      totalLogs: totalRows,
    })
  }
  if (!first.source.ok || loadedRows < LOG_PAGE_SIZE) {
    return {
      source: {
        ...first.source,
        detail: first.source.detail ?? `已加载 ${loadedRows} 条`,
      },
      results,
    }
  }

  const totalPages = reportedTotal !== undefined
    ? Math.min(MAX_LOG_PAGES, Math.ceil(Math.min(reportedTotal, MAX_LOG_ROWS) / LOG_PAGE_SIZE))
    : MAX_LOG_PAGES
  let pageLimitExclusive = totalPages
  let pageZeroAliasesPageOne = false

  for (let page = 1; page < pageLimitExclusive && loadedRows < MAX_LOG_ROWS; page += LOG_PAGE_CONCURRENCY) {
    const pageIndexes = Array.from(
      { length: Math.min(LOG_PAGE_CONCURRENCY, pageLimitExclusive - page) },
      (_, offset) => page + offset,
    )
    const batch = await Promise.all(
      pageIndexes.map((pageIndex) => request({
        site,
        label: `调用日志 ${pageIndex + 1}`,
        path: `/api/log/self?p=${pageIndex}&size=${LOG_PAGE_SIZE}&start_timestamp=${start}&end_timestamp=${end}`,
        timeoutMs: 15000,
      })),
    )

    if (page === 1 && batch[0]?.source.ok) {
      pageZeroAliasesPageOne = logPagesOverlap(first.result.data, batch[0].result.data)
      if (pageZeroAliasesPageOne) {
        pageLimitExclusive = Math.min(MAX_LOG_PAGES + 1, totalPages + 1)
      }
    }

    let reachedLastPage = false
    for (const [batchIndex, next] of batch.entries()) {
      if (!next.source.ok) {
        reachedLastPage = reportedTotal === undefined
        continue
      }
      if (pageZeroAliasesPageOne && pageIndexes[batchIndex] === 1) {
        continue
      }
      const pageRows = extractList(next.result.data).length
      if (pageRows === 0) {
        reachedLastPage = true
        continue
      }
      results.push(next.result)
      loadedRows += pageRows
      if (pageRows < LOG_PAGE_SIZE) {
        reachedLastPage = true
      }
    }
    if (onProgress) {
      onProgress({
        kind: 'logs',
        logs: parseLogs(results, undefined, undefined, start, end),
        loadedLogs: Math.min(loadedRows, MAX_LOG_ROWS),
        totalLogs: totalRows,
      })
      await yieldToProgressPaint()
    }
    if (reachedLastPage && reportedTotal === undefined) {
      break
    }
  }

  return {
    source: {
      ...first.source,
      durationMs: Date.now() - startedAt,
      detail: first.source.detail
        ? `${first.source.detail}；已加载 ${Math.min(loadedRows, MAX_LOG_ROWS)} 条`
        : `已加载 ${Math.min(loadedRows, MAX_LOG_ROWS)} 条`,
    },
    results,
  }
}

function sourceFromResult(label: string, endpoint: string, result: RequestResult): EndpointSource {
  const apiError = apiFailureMessage(result.data)
  const ok = result.ok && !apiError
  const kind = classifySource(result, apiError)

  return {
    label,
    endpoint,
    ok,
    kind,
    status: result.status,
    durationMs: Math.round(result.durationMs),
    detail: apiError ?? (result.ok ? undefined : friendlyStatus(result)),
  }
}

function friendlyStatus(result: RequestResult) {
  if (result.status === 401 || result.status === 403) {
    return `鉴权失败（HTTP ${result.status}），请检查 API Key、Cookie 或 User ID`
  }
  if (result.status === 404) {
    return `接口不存在（HTTP 404）`
  }
  if (result.status === 0) {
    return result.statusText || '网络异常或请求超时'
  }
  return `HTTP ${result.status}: ${result.statusText || '请求失败'}`
}

function apiFailureMessage(value: unknown): string | null {
  const record = asRecord(value)
  if (!record) {
    return null
  }

  if (record.success === false || record.ok === false) {
    return pickString(record, ['message', 'msg', 'error', 'detail'], '业务返回失败')
  }

  const code = Number(record.code)
  if (Number.isFinite(code) && code !== 0 && code !== 200) {
    return pickString(record, ['message', 'msg', 'error', 'detail'], `业务状态码 ${code}`)
  }

  return null
}

function appendUnique(target: string[], value: string) {
  const trimmed = value.trim()
  if (trimmed && !target.includes(trimmed)) {
    target.push(trimmed)
  }
}

function parseStringList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .flatMap((item) => parseStringList(item))
      .map((item) => item.trim())
      .filter(Boolean)
  }

  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed) {
      return []
    }

    if (trimmed.startsWith('[')) {
      try {
        const parsed = JSON.parse(trimmed) as unknown
        return parseStringList(parsed)
      } catch {
        return trimmed
          .split(',')
          .map((item) => item.trim())
          .filter(Boolean)
      }
    }

    return trimmed
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean)
  }

  if (typeof value === 'number') {
    return [String(value)]
  }

  const record = asRecord(value)
  if (record) {
    return [pickString(record, ['id', 'model', 'model_name', 'name'])].filter(Boolean)
  }

  return []
}

const accountFieldKeys = [
  'remain_quota',
  'remaining_quota',
  'remaining_balance',
  'quota_remaining',
  'remaining',
  'balance',
  'credit',
  'current_balance',
  'available_quota',
  'available_balance',
  'total_quota',
  'quota',
  'used_quota',
  'used_amount',
  'historical_cost',
  'total_used',
  'total_used_quota',
  'consumed_quota',
  'request_count',
  'requestCount',
  'username',
  'name',
  'display_name',
  'displayName',
  'email',
  'group',
  'group_name',
  'user_group',
  'quota_group',
  'subscription_remaining_quota',
  'subscription_remain_quota',
  'subscription_used_quota',
  'subscription_total_quota',
  'subscription_quota',
  'subscription_name',
]

const SUBSCRIPTION_REMAINING_KEYS = [
  '订阅剩余',
  '剩余额度',
  'subscription remaining',
  'remaining subscription',
  'subscription_remain',
  'subscriptionRemain',
  'subscription_remaining_quota',
  'subscriptionRemainingQuota',
  'subscription_remain_quota',
  'subscriptionRemainQuota',
  'remaining_subscription_quota',
  'remain_subscription_quota',
  'subscription_quota_remaining',
  'subscriptionQuotaRemaining',
  'subscription_remaining',
  'subscriptionRemaining',
  'sub_remaining_quota',
  'sub_remain_quota',
  'subscription_balance',
  'subscriptionBalance',
]

const SUBSCRIPTION_TOTAL_KEYS = [
  '订阅总额',
  '订阅额度',
  '总额度',
  'subscription total',
  'subscription quota',
  'subscription_total',
  'subscriptionTotal',
  'subscription_total_quota',
  'subscriptionTotalQuota',
  'subscription_quota_total',
  'subscriptionQuotaTotal',
  'subscription_quota',
  'subscriptionQuota',
  'sub_total_quota',
  'sub_quota',
]

const SUBSCRIPTION_USED_KEYS = [
  '订阅已用',
  '已用额度',
  '消耗额度',
  'subscription used',
  'used subscription',
  'subscription_used',
  'subscriptionUsed',
  'subscription_used_quota',
  'subscriptionUsedQuota',
  'used_subscription_quota',
  'subscription_consumed_quota',
  'subscriptionConsumedQuota',
  'sub_used_quota',
]

const SUBSCRIPTION_NAME_KEYS = [
  '订阅套餐',
  '套餐名称',
  '套餐',
  'subscription plan',
  'subscription package',
  'subscription_plan_title',
  'subscriptionPlanTitle',
  'subscription_name',
  'subscriptionName',
  'subscription_plan',
  'subscriptionPlan',
  'subscription_plan_name',
  'subscriptionPlanName',
  'plan_name',
  'planName',
  'package_name',
  'packageName',
  'name',
  'title',
]

const SUBSCRIPTION_EXPIRES_KEYS = [
  '订阅到期',
  '到期时间',
  '有效期至',
  'subscription expires',
  'subscription end',
  'subscription_expires_at',
  'subscriptionExpiresAt',
  'subscription_end_at',
  'subscriptionEndAt',
  'expire_time',
  'expireTime',
  'expires_at',
  'expiresAt',
  'end_time',
  'endTime',
]

const SUBSCRIPTION_INSTANCE_KEYS = [
  '订阅实例',
  '实例编号',
  '实例',
  'subscription instance',
  'subscription instance id',
  'subscription_instance',
  'subscriptionInstance',
  'subscription_instance_id',
  'subscriptionInstanceId',
  'instance_id',
  'instanceId',
  'sub_instance',
  'subInstance',
]

const SUBSCRIPTION_PRE_DEDUCT_KEYS = [
  '预扣',
  '预扣额度',
  'subscription pre deduct',
  'pre deduct',
  'subscription_pre_consumed',
  'subscriptionPreConsumed',
  'subscription_pre_deduct_quota',
  'subscriptionPreDeductQuota',
  'subscription_pre_deduct',
  'subscriptionPreDeduct',
  'pre_deduct_quota',
  'preDeductQuota',
  'pre_deduct',
  'preDeduct',
  'estimated_quota',
  'estimatedQuota',
]

const SUBSCRIPTION_SETTLE_DELTA_KEYS = [
  '结算差额',
  '差额结算',
  'subscription settle delta',
  'settle delta',
  'settlement delta',
  'subscription_post_delta',
  'subscriptionPostDelta',
  'subscription_settle_delta_quota',
  'subscriptionSettleDeltaQuota',
  'subscription_settle_delta',
  'subscriptionSettleDelta',
  'settle_delta_quota',
  'settleDeltaQuota',
  'settlement_delta_quota',
  'settlementDeltaQuota',
  'settle_delta',
  'settleDelta',
]

const SUBSCRIPTION_FINAL_DEDUCT_KEYS = [
  '最终抵扣',
  '实际抵扣',
  '实际扣费',
  'subscription final deduct',
  'final deduct',
  'actual deduct',
  'subscription_final_deduct_quota',
  'subscriptionFinalDeductQuota',
  'subscription_final_deduct',
  'subscriptionFinalDeduct',
  'final_deduct_quota',
  'finalDeductQuota',
  'final_deduct',
  'finalDeduct',
  'actual_deduct_quota',
  'actualDeductQuota',
]

const SUBSCRIPTION_DESCRIPTION_KEYS = [
  '订阅说明',
  '说明',
  'subscription description',
  'subscription_description',
  'subscriptionDescription',
  'subscription_desc',
  'subscriptionDesc',
  'billing_description',
  'billingDescription',
  'description',
  'desc',
  'remark',
]

const SUBSCRIPTION_BILLING_DETAIL_KEYS = [
  '计费过程',
  '日志详情',
  '计费详情',
  'billing_detail',
  'billingDetail',
  'billing_process',
  'billingProcess',
  'calculation',
]

function numberFromText(value: unknown) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value
  }
  if (typeof value !== 'string') {
    return undefined
  }
  const match = value.replace(/,/g, '').match(/-?\d+(?:\.\d+)?/)
  if (!match) {
    return undefined
  }
  const parsed = Number(match[0])
  return Number.isFinite(parsed) ? parsed : undefined
}

function pickNumberLoose(record: PlainRecord | null, keys: string[]) {
  const direct = pickNumber(record, keys)
  if (direct !== undefined) {
    return direct
  }
  if (!record) {
    return undefined
  }

  for (const key of keys) {
    const parsed = numberFromText(record[key])
    if (parsed !== undefined) {
      return parsed
    }
  }

  return undefined
}

function pickNumberDeepLoose(records: PlainRecord[], keys: string[]) {
  for (const record of records) {
    const parsed = pickNumberLoose(record, keys)
    if (parsed !== undefined) {
      return parsed
    }
  }
  return undefined
}

function quotaPairFromText(value: unknown) {
  if (typeof value !== 'string') {
    return undefined
  }
  const match = value.replace(/,/g, '').match(/(-?\d+(?:\.\d+)?)\s*\/\s*(-?\d+(?:\.\d+)?)/)
  if (!match) {
    return undefined
  }
  const remaining = Number(match[1])
  const total = Number(match[2])
  return Number.isFinite(remaining) && Number.isFinite(total) ? { remaining, total } : undefined
}

function pickSubscriptionQuotaPair(records: PlainRecord[]) {
  const keys = [...SUBSCRIPTION_REMAINING_KEYS, ...SUBSCRIPTION_TOTAL_KEYS]
  for (const record of records) {
    for (const key of keys) {
      const pair = quotaPairFromText(record[key])
      if (pair) {
        return pair
      }
    }
  }

  for (const record of records) {
    for (const value of Object.values(record)) {
      if (typeof value === 'string' && /订阅|额度|quota|subscription/i.test(value)) {
        const pair = quotaPairFromText(value)
        if (pair) {
          return pair
        }
      }
    }
  }

  return undefined
}

function collectRecordsDeep(value: unknown, seen = new Set<PlainRecord>(), depth = 0): PlainRecord[] {
  if (depth > 5 || value === null || value === undefined) {
    return []
  }

  const unwrapped = unwrapData(value)
  if (Array.isArray(unwrapped)) {
    return unwrapped.flatMap((item) => collectRecordsDeep(item, seen, depth + 1))
  }

  const record = asRecord(unwrapped)
  if (!record || seen.has(record)) {
    return []
  }

  seen.add(record)
  const nestedRecords = collectNestedRecords(record).filter((item) => {
    if (seen.has(item)) {
      return false
    }
    seen.add(item)
    return true
  })
  const children = Object.values(record).flatMap((item) => collectRecordsDeep(item, seen, depth + 1))
  return [record, ...nestedRecords, ...children]
}

function hasSubscriptionMarker(record: PlainRecord) {
  const keyText = Object.keys(record).join(' ').toLowerCase()
  if (/(subscription|subscribe|sub_|plan|package|订阅|套餐)/.test(keyText)) {
    return true
  }
  return Object.values(record).some((value) => typeof value === 'string' && /订阅|套餐|subscription/i.test(value))
}

function subscriptionStatusEnabled(record: PlainRecord) {
  const raw = record.status ?? record.enabled ?? record.enable ?? record.active ?? record.valid
  if (raw === undefined || raw === null || raw === '') {
    return true
  }
  if (typeof raw === 'boolean') {
    return raw
  }
  const text = String(raw).toLowerCase()
  return !['0', 'false', 'disabled', 'disable', 'inactive', 'expired', 'cancelled', 'canceled', 'off', '失效', '过期'].includes(text)
}

function subscriptionRecords(...values: unknown[]) {
  const records = values
    .flatMap((value) => collectRecordsDeep(value))
    .filter((record) => hasSubscriptionMarker(record) && subscriptionStatusEnabled(record))
  return Array.from(new Set(records))
}

function sumPickedNumbers(records: PlainRecord[], keys: string[]) {
  return records.reduce((sum, record) => sum + (pickNumberLoose(record, keys) ?? 0), 0)
}

function firstPickedString(records: PlainRecord[], keys: string[]) {
  for (const record of records) {
    const value = pickString(record, keys)
    if (value) {
      return value
    }
  }
  return undefined
}

function joinedRecordText(records: PlainRecord[]) {
  return records
    .flatMap((record) => Object.values(record))
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .join('\n')
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function labelValuePattern(label: string) {
  const escaped = escapeRegExp(label)
  return new RegExp(`(?:^|[^A-Za-z0-9_])${escaped}(?![A-Za-z0-9_])"?\\s*[：:=]?\\s*"?([^"\\n\\r,}]+)`, 'i')
}

function pickNumberFromRecordText(records: PlainRecord[], labels: string[]) {
  const text = joinedRecordText(records).replace(/,/g, '')
  for (const label of labels) {
    const match = text.match(labelValuePattern(label))
    if (match) {
      const value = numberFromText(match[1])
      if (Number.isFinite(value)) {
        return value
      }
    }
  }
  return undefined
}

function pickStringFromRecordText(records: PlainRecord[], labels: string[]) {
  const text = joinedRecordText(records)
  for (const label of labels) {
    const match = text.match(labelValuePattern(label))
    const value = match?.[1]?.trim()
    if (value) {
      return value
    }
  }
  return undefined
}

function findAccountRecord(value: unknown, depth = 0): PlainRecord | null {
  if (depth > 4) {
    return null
  }

  const record = asRecord(value)
  if (!record) {
    return null
  }

  if (accountFieldKeys.some((key) => key in record)) {
    return record
  }

  for (const key of ['data', 'user', 'account', 'profile', 'self', 'result']) {
    const candidate = findAccountRecord(record[key], depth + 1)
    if (candidate) {
      return candidate
    }
  }

  for (const candidate of Object.values(record)) {
    if (asRecord(candidate)) {
      const found = findAccountRecord(candidate, depth + 1)
      if (found) {
        return found
      }
    }
  }

  return null
}

function parseAccount(result: RequestResult | undefined, ...subscriptionData: unknown[]): AccountData {
  const record = findAccountRecord(result?.data)
  if (!record || !result?.ok) {
    return ZERO_ACCOUNT
  }

  const currentRaw = pickNumber(record, [
    'remain_quota',
    'remaining_quota',
    'remaining_balance',
    'quota_remaining',
    'remaining',
    'balance',
    'credit',
    'current_balance',
    'available_quota',
    'available_balance',
    'total_quota',
    'quota',
  ])
  const usedRaw = pickNumber(record, [
    'used_quota',
    'used_amount',
    'historical_cost',
    'used',
    'total_used',
    'total_used_quota',
    'consumed_quota',
  ])
  const activeSubscriptions = subscriptionRecords(result.data, ...subscriptionData)
  const subscriptionPair = pickSubscriptionQuotaPair(activeSubscriptions)
  const subscriptionRemainingRaw =
    sumPickedNumbers(activeSubscriptions, SUBSCRIPTION_REMAINING_KEYS) ||
    subscriptionPair?.remaining ||
    pickNumberFromRecordText(activeSubscriptions, SUBSCRIPTION_REMAINING_KEYS) ||
    0
  const subscriptionTotalRaw =
    sumPickedNumbers(activeSubscriptions, SUBSCRIPTION_TOTAL_KEYS) ||
    subscriptionPair?.total ||
    pickNumberFromRecordText(activeSubscriptions, SUBSCRIPTION_TOTAL_KEYS) ||
    0
  const explicitSubscriptionUsedRaw =
    sumPickedNumbers(activeSubscriptions, SUBSCRIPTION_USED_KEYS) ||
    pickNumberFromRecordText(activeSubscriptions, SUBSCRIPTION_USED_KEYS) ||
    0
  const inferredSubscriptionUsedRaw = subscriptionTotalRaw > subscriptionRemainingRaw
    ? subscriptionTotalRaw - subscriptionRemainingRaw
    : 0
  const subscriptionUsedRaw = explicitSubscriptionUsedRaw || inferredSubscriptionUsedRaw

  return {
    currentBalance: quotaToCurrency(currentRaw),
    historicalCost: quotaToCurrency(usedRaw) + quotaToCurrency(subscriptionUsedRaw || undefined),
    requestCount: pickNumber(record, ['request_count', 'requestCount', 'requests', 'total_requests']) ?? 0,
    username: pickString(record, ['username', 'display_name', 'displayName', 'name', 'email'], '当前账户'),
    group: pickString(record, ['group', 'group_name', 'user_group', 'quota_group', 'default_group'], 'default'),
    quotaRaw: currentRaw,
    usedQuotaRaw: usedRaw,
    subscriptionBalance: quotaToCurrency(subscriptionRemainingRaw || undefined),
    subscriptionUsed: quotaToCurrency(subscriptionUsedRaw || undefined),
    subscriptionRemainingRaw: subscriptionRemainingRaw || undefined,
    subscriptionTotalRaw: subscriptionTotalRaw || undefined,
    subscriptionUsedRaw: subscriptionUsedRaw || undefined,
    subscriptionPreDeductRaw: sumPickedNumbers(activeSubscriptions, SUBSCRIPTION_PRE_DEDUCT_KEYS) || pickNumberFromRecordText(activeSubscriptions, SUBSCRIPTION_PRE_DEDUCT_KEYS) || undefined,
    subscriptionSettleDeltaRaw: sumPickedNumbers(activeSubscriptions, SUBSCRIPTION_SETTLE_DELTA_KEYS) || pickNumberFromRecordText(activeSubscriptions, SUBSCRIPTION_SETTLE_DELTA_KEYS) || undefined,
    subscriptionFinalDeductRaw: sumPickedNumbers(activeSubscriptions, SUBSCRIPTION_FINAL_DEDUCT_KEYS) || pickNumberFromRecordText(activeSubscriptions, SUBSCRIPTION_FINAL_DEDUCT_KEYS) || undefined,
    subscriptionName: firstPickedString(activeSubscriptions, SUBSCRIPTION_NAME_KEYS) ?? pickStringFromRecordText(activeSubscriptions, SUBSCRIPTION_NAME_KEYS),
    subscriptionInstance: firstPickedString(activeSubscriptions, SUBSCRIPTION_INSTANCE_KEYS) ?? pickStringFromRecordText(activeSubscriptions, SUBSCRIPTION_INSTANCE_KEYS),
    subscriptionExpiresAt: firstPickedString(activeSubscriptions, SUBSCRIPTION_EXPIRES_KEYS) ?? pickStringFromRecordText(activeSubscriptions, SUBSCRIPTION_EXPIRES_KEYS),
    subscriptionDescription: firstPickedString(activeSubscriptions, SUBSCRIPTION_DESCRIPTION_KEYS) ?? pickStringFromRecordText(activeSubscriptions, SUBSCRIPTION_DESCRIPTION_KEYS),
    subscriptionActiveCount: activeSubscriptions.length || undefined,
  }
}

function hasAccountPayload(result: RequestResult | undefined) {
  return Boolean(result?.ok && !apiFailureMessage(result.data) && findAccountRecord(result.data))
}

function accountIssue(_label: string, result: RequestResult | undefined) {
  if (!result) {
    return '未执行'
  }
  if (result.status === 401 || result.status === 403) {
    return `鉴权失败（HTTP ${result.status}）：API Key 无权限或 Cookie/Session 已失效，请重新填写`
  }
  if (!result.ok) {
    return `HTTP ${result.status || 0}: ${result.statusText || '请求失败，请检查 Base URL 是否正确'}`
  }

  const apiError = apiFailureMessage(result.data)
  if (apiError) {
    return `业务失败: ${apiError}`
  }

  return '未返回可识别的账户字段，请确认 User ID 是否与该账户匹配'
}

function parseTokenStatus(value: unknown): TokenRecord['status'] {
  if (typeof value === 'boolean') {
    return value ? 'enabled' : 'disabled'
  }

  const text = String(value ?? '').toLowerCase()
  if (['enabled', 'enable', 'active', '1', 'true', 'ok'].includes(text)) {
    return 'enabled'
  }
  if (['disabled', 'disable', 'inactive', '0', 'false'].includes(text)) {
    return 'disabled'
  }
  return 'unknown'
}

function maskKey(value: string) {
  if (!value) {
    return 'not returned'
  }
  if (value.length <= 12) {
    return `${value.slice(0, 3)}***`
  }
  return `${value.slice(0, 6)}********${value.slice(-4)}`
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
  if (masked === key || masked === maskKey(key)) {
    return true
  }

  const keyVariants = apiKeyCompareVariants(key)
  if (apiKeyCompareVariants(masked).some((variant) => keyVariants.includes(variant))) {
    return true
  }

  const visibleParts = previewVisibleParts(masked)
  if (visibleParts.length === 0) {
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

function tokenNameForKey(apiKey: string, tokens: TokenRecord[]) {
  return tokens.find((token) => apiKeyMatchesPreview(apiKey, token.keyPreview))?.name ?? ''
}

function tokenKeyPreview(record: PlainRecord | null) {
  const key = pickString(record, ['key', 'token', 'api_key'])
  if (key) {
    return maskKey(key)
  }
  return pickString(record, ['key_preview', 'keyPreview', 'token_preview', 'tokenPreview', 'api_key_preview', 'apiKeyPreview'], 'not returned')
}

function tokenKeySecret(record: PlainRecord | null) {
  const key = pickString(record, ['key', 'token', 'api_key', 'apiKey', 'access_token', 'accessToken'])
  if (!key || key.includes('*') || key.includes('•') || key.toLowerCase() === 'not returned') {
    return undefined
  }

  return key.length >= 16 ? key : undefined
}

function parseTokens(result: RequestResult | undefined): TokenRecord[] {
  if (!result?.ok) {
    return []
  }

  return extractList(result.data)
    .map((item, index) => {
      const record = asRecord(item)
      const models = record?.models
      const modelList = Array.isArray(models)
        ? models.map(String)
        : String(models ?? '')
            .split(',')
            .map((model) => model.trim())
            .filter(Boolean)

      return {
        id: pickString(record, ['id', 'key', 'name'], `token_${index}`),
        name: pickString(record, ['name', 'token_name', 'tokenName', 'key_name', 'keyName', 'remark'], `Token ${index + 1}`),
        status: parseTokenStatus(record?.status ?? record?.enabled),
        remaining: quotaToCurrency(pickNumber(record, ['remain_quota', 'quota', 'unlimited_quota'])),
        used: quotaToCurrency(pickNumber(record, ['used_quota', 'used_amount', 'used'])),
        group: pickString(record, ['group', 'group_name'], 'default'),
        models: modelList.length ? modelList : ['unlimited'],
        key: tokenKeySecret(record),
        keyPreview: tokenKeyPreview(record),
      }
    })
    .slice(0, 50)
}

function configuredKeyProbes(site: RelaySite, tokens: TokenRecord[]): ApiKeyProbe[] {
  const probes: ApiKeyProbe[] = []
  const primaryKey = site.apiKey.trim()
  if (primaryKey) {
    const primaryTokenName = site.apiKeyTokenName?.trim() || tokenNameForKey(primaryKey, tokens)
    probes.push({
      id: 'primary',
      name: primaryTokenName || '默认 API Key',
      key: primaryKey,
      tokenName: primaryTokenName,
      enabled: true,
    })
  }

  ;(site.apiKeyProbes ?? []).forEach((probe, index) => {
    const key = probe.key.trim()
    if (!probe.enabled || !key) {
      return
    }
    const tokenName = probe.tokenName?.trim() || probe.name.trim() || tokenNameForKey(key, tokens)
    probes.push({
      id: probe.id || `probe_${index}`,
      name: tokenName || `检测 Key ${index + 1}`,
      key,
      tokenName,
      enabled: true,
    })
  })

  return probes.slice(0, 20)
}

function keyProbeStatus(source: EndpointSource): SourceStatus {
  return source.ok ? 'ok' : source.kind
}

function keyProbeStats(logs: UsageLog[], tokenName: string) {
  const matched = tokenName ? logs.filter((log) => log.tokenName === tokenName) : []
  const latencyLogs = matched.filter((log) => log.latencyMs > 0)
  const latest = [...matched].sort((a, b) => (parseTimestampValue(b.time) ?? 0) - (parseTimestampValue(a.time) ?? 0))[0]
  const errors = matched.filter((log) => log.status === 'error').length
  return {
    requests: matched.length,
    errors,
    tokens: matched.reduce((sum, log) => sum + log.total, 0),
    cost: matched.reduce((sum, log) => sum + log.cost, 0),
    avgLatencyMs: latencyLogs.length
      ? Math.round(latencyLogs.reduce((sum, log) => sum + log.latencyMs, 0) / latencyLogs.length)
      : 0,
    successRate: matched.length ? Math.max(0, (matched.length - errors) / matched.length) : null,
    lastUsedAt: latest?.time,
  }
}

function keyProbeHealth(
  source: Pick<EndpointSource, 'ok' | 'kind' | 'durationMs'>,
  stats: ReturnType<typeof keyProbeStats>,
) {
  if (!source.ok) {
    return {
      healthScore: 0,
      healthLabel: source.kind === 'timeout' ? '超时' : source.kind === 'forbidden' ? '权限' : '异常',
    }
  }

  let healthScore = stats.successRate === null ? 100 : Math.round(stats.successRate * 100)
  if (source.durationMs >= 8000) {
    healthScore = Math.min(healthScore, 60)
  } else if (source.durationMs >= 5000) {
    healthScore = Math.min(healthScore, 80)
  } else if (source.durationMs >= 3000) {
    healthScore = Math.min(healthScore, 90)
  }

  const healthLabel = healthScore >= 95 ? '健康' : healthScore >= 80 ? '观察' : healthScore >= 60 ? '偏慢' : '异常'
  return { healthScore, healthLabel }
}

function applyApiKeyLogStats(keyChecks: ApiKeyProbeResult[], logs: UsageLog[]) {
  return keyChecks.map((check) => {
    const stats = keyProbeStats(logs, check.tokenName)
    const health = keyProbeHealth(
      { ok: check.ok, kind: check.status, durationMs: check.latencyMs },
      stats,
    )
    return { ...check, ...stats, ...health }
  })
}

async function fetchApiKeyChecks(
  site: RelaySite,
  tokens: TokenRecord[],
  onProgress?: (progress: UsageFetchProgress) => void,
): Promise<ApiKeyProbeResult[]> {
  const probes = configuredKeyProbes(site, tokens)
  const checkedAt = new Date().toISOString()
  const completed = new Array<ApiKeyProbeResult | undefined>(probes.length)
  let completedCount = 0

  if (!probes.length) {
    onProgress?.({
      kind: 'keyChecks',
      keyChecks: [],
      completedKeyChecks: 0,
      totalKeyChecks: 0,
    })
    return []
  }

  onProgress?.({
    kind: 'keyChecks',
    keyChecks: [],
    completedKeyChecks: 0,
    totalKeyChecks: probes.length,
  })

  return Promise.all(
    probes.map(async (probe, index) => {
      const result = await request({
        site: { ...site, apiKey: probe.key, cookie: '' },
        label: `Key 检测：${probe.name}`,
        path: '/v1/models',
        timeoutMs: 10000,
      })
      const source = result.source
      const models = source.ok ? parseModels(result.result).length : 0
      const stats = keyProbeStats([], probe.tokenName ?? '')
      const health = keyProbeHealth(source, stats)
      const check: ApiKeyProbeResult = {
        id: probe.id,
        name: probe.name,
        tokenName: probe.tokenName ?? '',
        enabled: probe.enabled,
        ok: source.ok,
        status: keyProbeStatus(source),
        latencyMs: source.durationMs,
        detail: source.ok ? `模型列表可读，返回 ${models} 个模型` : source.detail ?? `HTTP ${source.status}`,
        models,
        checkedAt,
        ...stats,
        ...health,
      }
      completed[index] = check
      completedCount += 1
      onProgress?.({
        kind: 'keyChecks',
        keyChecks: completed.flatMap((item) => (item ? [item] : [])),
        completedKeyChecks: completedCount,
        totalKeyChecks: probes.length,
      })
      return check
    }),
  )
}

function collectModelNames(value: unknown, target: string[], depth = 0) {
  if (depth > 4 || value === null || value === undefined) {
    return
  }

  const unwrapped = unwrapData(value)
  if (Array.isArray(unwrapped)) {
    unwrapped.forEach((item) => {
      if (typeof item === 'string' || typeof item === 'number') {
        appendUnique(target, String(item))
        return
      }

      const record = asRecord(item)
      const model = pickString(record, ['id', 'model', 'model_name', 'modelName', 'name'])
      if (model) {
        appendUnique(target, model)
      }
      collectModelNames(item, target, depth + 1)
    })
    return
  }

  if (typeof unwrapped === 'string' || typeof unwrapped === 'number') {
    parseStringList(unwrapped).forEach((model) => appendUnique(target, model))
    return
  }

  const record = asRecord(unwrapped)
  if (!record) {
    return
  }

  parseStringList(record.models).forEach((model) => appendUnique(target, model))

  const directModel = pickString(record, ['id', 'model', 'model_name', 'modelName', 'name'])
  if (directModel && ('object' in record || 'model_name' in record || 'model' in record)) {
    appendUnique(target, directModel)
  }

  const modelRatios = asRecord(record.model_ratio ?? record.model_ratios ?? record.modelRatio)
  if (modelRatios) {
    Object.keys(modelRatios).forEach((model) => appendUnique(target, model))
  }

  for (const key of ['data', 'items', 'models', 'records', 'list', 'rows']) {
    collectModelNames(record[key], target, depth + 1)
  }

  if (!directModel) {
    Object.values(record).forEach((candidate) => {
      if (Array.isArray(candidate)) {
        collectModelNames(candidate, target, depth + 1)
      }
    })
  }
}

function parseModels(...results: Array<RequestResult | undefined>) {
  const models: string[] = []
  results.forEach((result) => collectModelNames(result?.data, models))
  return models.slice(0, 300)
}

function inferGroup(model: string) {
  if (model.includes('claude')) {
    return 'claude'
  }
  if (model.includes('gpt')) {
    return model.includes('pro') ? 'gpt-pro' : 'gpt'
  }
  if (model.includes('gemini')) {
    return 'gemini'
  }
  if (model.includes('deepseek')) {
    return 'deepseek'
  }
  return model.split('-')[0] || 'default'
}

function parseGroupNames(groupsResult: RequestResult | undefined) {
  const groupList = extractList(groupsResult?.data)
  if (groupList.length) {
    return groupList.map((item) => pickString(asRecord(item), ['name', 'group', 'id'])).filter(Boolean)
  }

  const groupRecord = asRecord(unwrapData(groupsResult?.data))
  return groupRecord ? Object.keys(groupRecord) : []
}

function pickNumberMap(...values: unknown[]) {
  const map = new Map<string, number>()

  values.forEach((value) => {
    const record = asRecord(value)
    if (!record) {
      return
    }

    Object.entries(record).forEach(([key, raw]) => {
      const numberValue = typeof raw === 'string' ? Number(raw.replace(/,/g, '')) : Number(raw)
      if (Number.isFinite(numberValue)) {
        map.set(key, numberValue)
      }
    })
  })

  return map
}

function enabledFromRecord(record: PlainRecord | null) {
  const raw = record?.enabled ?? record?.enable ?? record?.status
  if (raw === undefined || raw === null || raw === '') {
    return true
  }

  if (typeof raw === 'boolean') {
    return raw
  }

  const text = String(raw).toLowerCase()
  return !['0', 'false', 'disabled', 'disable', 'off'].includes(text)
}

function buildRateEntry(input: {
  group: string
  model: string
  modelRatio?: number
  groupRatio?: number
  completionRatio?: number
  cacheRatio?: number
  modelPrice?: number
  quotaType?: number
  enabled?: boolean
  availableGroups?: string[]
}): GroupRate {
  const modelRatio = input.modelRatio ?? 1
  const groupRatio = input.groupRatio ?? 1

  return {
    group: input.group,
    model: input.model,
    ratio: modelRatio * groupRatio,
    enabled: input.enabled ?? true,
    modelRatio: input.modelRatio,
    groupRatio: input.groupRatio,
    completionRatio: input.completionRatio,
    cacheRatio: input.cacheRatio,
    modelPrice: input.modelPrice,
    quotaType: input.quotaType,
    availableGroups: input.availableGroups,
  }
}

function parseGroups(
  pricingResult: RequestResult | undefined,
  modelResults: Array<RequestResult | undefined>,
  groupsResult: RequestResult | undefined,
  ratioConfigResult: RequestResult | undefined,
): GroupRate[] {
  const pricingRoot = asRecord(pricingResult?.data)
  const pricing = asRecord(unwrapData(pricingResult?.data))
  const ratioRoot = asRecord(unwrapData(ratioConfigResult?.data))
  const explicitGroups = parseGroupNames(groupsResult)
  const rates: GroupRate[] = []

  const groupRatios = pickNumberMap(
    pricingRoot?.group_ratio,
    pricing?.group_ratio,
    ratioRoot?.group_ratio,
    ratioRoot?.groupRatio,
  )
  const modelRatios = pickNumberMap(
    ratioRoot?.model_ratio,
    ratioRoot?.model_ratios,
    ratioRoot?.modelRatio,
    pricingRoot?.model_ratio,
    pricingRoot?.model_ratios,
    pricing?.model_ratio,
    pricing?.model_ratios,
    pricing?.modelRatio,
    pricing?.ratios,
  )
  const completionRatios = pickNumberMap(
    ratioRoot?.completion_ratio,
    ratioRoot?.completion_ratios,
    ratioRoot?.completionRatio,
    pricingRoot?.completion_ratio,
    pricing?.completion_ratio,
    pricing?.completionRatio,
  )
  const modelPrices = pickNumberMap(
    ratioRoot?.model_price,
    ratioRoot?.model_prices,
    ratioRoot?.modelPrice,
    pricingRoot?.model_price,
    pricing?.model_price,
    pricing?.modelPrice,
  )

  const pricingList = extractList(pricingResult?.data)
  pricingList.forEach((item) => {
    const record = asRecord(item)
    const model = pickString(record, ['model_name', 'model', 'name', 'id'])
    if (!model) {
      return
    }

    const availableGroups = parseStringList(record?.enable_group ?? record?.enabled_group ?? record?.groups)
    const modelRatio = pickNumber(record, ['model_ratio', 'modelRatio', 'ratio']) ?? modelRatios.get(model)
    const completionRatio =
      pickNumber(record, ['completion_ratio', 'completionRatio', 'completion_price_ratio']) ??
      completionRatios.get(model)
    const cacheRatio = pickNumber(record, [
      'cache_ratio',
      'cacheRatio',
      'cache_read_ratio',
      'cacheReadRatio',
      'cached_ratio',
    ])
    const modelPrice = pickNumber(record, ['model_price', 'modelPrice', 'price']) ?? modelPrices.get(model)
    const quotaType = pickNumber(record, ['quota_type', 'quotaType'])
    const targetGroups = availableGroups.length
      ? availableGroups
      : [pickString(record, ['group', 'group_name', 'groupName'], inferGroup(model))]

    targetGroups.forEach((group) => {
      rates.push({
        ...buildRateEntry({
          group,
          model,
          modelRatio,
          groupRatio: groupRatios.get(group),
          completionRatio,
          cacheRatio,
          modelPrice,
          quotaType,
          enabled: enabledFromRecord(record),
          availableGroups,
        }),
      })
    })
  })

  if (modelRatios.size) {
    modelRatios.forEach((modelRatio, model) => {
      if (rates.some((rate) => rate.model === model)) {
        return
      }

      const completionRatio = completionRatios.get(model)
      const modelPrice = modelPrices.get(model)
      const group = inferGroup(model)
      rates.push(
        buildRateEntry({
          group,
          model,
          modelRatio,
          groupRatio: groupRatios.get(group),
          completionRatio,
          modelPrice,
          enabled: true,
        }),
      )
    })
  }

  parseModels(...modelResults).forEach((model) => {
    if (rates.some((rate) => rate.model === model)) {
      return
    }

    const group = inferGroup(model)
    rates.push(
      buildRateEntry({
        group,
        model,
        modelRatio: modelRatios.get(model),
        groupRatio: groupRatios.get(group),
        completionRatio: completionRatios.get(model),
        modelPrice: modelPrices.get(model),
        enabled: true,
      }),
    )
  })

  if (rates.length) {
    return dedupeRates(rates)
      .sort((a, b) => a.group.localeCompare(b.group) || a.model.localeCompare(b.model))
      .slice(0, 120)
  }

  const models = parseModels(...modelResults).slice(0, 60)
  if (models.length) {
    return models.map((model) => ({
      group: inferGroup(model),
      model,
      ratio: 1,
      enabled: true,
    }))
  }

  return explicitGroups.map((group) => ({
    group,
    model: 'all models',
    ratio: 1,
    enabled: true,
  }))
}

function dedupeRates(rates: GroupRate[]) {
  const seen = new Set<string>()
  return rates.filter((rate) => {
    const key = `${rate.group}:${rate.model}`
    if (seen.has(key)) {
      return false
    }
    seen.add(key)
    return true
  })
}

const LOG_STATUS_KEYS = ['status', 'state', 'type', 'result', 'level']

const LOG_STATUS_CODE_KEYS = [
  'status_code',
  'statusCode',
  'http_status',
  'httpStatus',
  'http_status_code',
  'httpStatusCode',
  'response_status',
  'responseStatus',
  'response_status_code',
  'responseStatusCode',
  'response_code',
  'responseCode',
  'http_code',
  'httpCode',
  'error_status',
  'errorStatus',
]

const LOG_ERROR_CODE_KEYS = ['error_code', 'errorCode', 'code']

const LOG_ERROR_MESSAGE_KEYS = [
  'error_message',
  'errorMessage',
  'message',
  'msg',
  'error',
  'reason',
  'detail',
  'details',
  'content',
  'response',
  'response_body',
  'responseBody',
  'body',
  'result',
  'status_text',
  'statusText',
]

const LOG_ERROR_TEXT_PATTERN =
  /(status[_\s-]*code\s*[:=]\s*[45]\d{2}|http\s*[45]\d{2}|\berror\b|\bfailed?\b|\bfailure\b|\bexception\b|\btimeout\b|\btimed out\b|\brate limit\b|too many requests|unauthori[sz]ed|forbidden|invalid|insufficient|not enough|quota exceeded|out of quota|account balance|service temporarily|unavailable|overloaded|bad gateway|gateway timeout|错误|失败|异常|超时|限流|拒绝|无效|不可用|服务暂时|余额不足|额度不足|权限|认证|鉴权|过载)/i

const LOG_SUCCESS_TEXT_PATTERN = /^(ok|success|succeed|succeeded|completed|done|成功|完成|正常)$/i
const LOG_CACHE_TEXT_PATTERN = /(cache|cached|缓存)/i

function collectLogTexts(records: PlainRecord[]) {
  const texts: string[] = []
  const seenTexts = new Set<string>()
  const seenObjects = new Set<object>()

  const add = (value: string) => {
    const trimmed = value.trim()
    if (trimmed && !seenTexts.has(trimmed)) {
      seenTexts.add(trimmed)
      texts.push(trimmed)
    }
  }

  const visit = (value: unknown, depth: number) => {
    if (value === null || value === undefined || depth > 4) {
      return
    }
    if (typeof value === 'string') {
      add(value)
      return
    }
    if (typeof value === 'number' || typeof value === 'boolean') {
      add(String(value))
      return
    }
    if (Array.isArray(value)) {
      value.forEach((item) => visit(item, depth + 1))
      return
    }

    const record = asRecord(value)
    if (!record || seenObjects.has(record)) {
      return
    }
    seenObjects.add(record)
    Object.values(record).forEach((item) => visit(item, depth + 1))
  }

  records.forEach((record) => visit(record, 0))
  return texts
}

function normalizeHttpStatusCode(value: number | undefined) {
  if (!Number.isFinite(value)) {
    return undefined
  }
  const rounded = Math.round(Number(value))
  return rounded >= 100 && rounded <= 599 ? rounded : undefined
}

function statusCodeFromText(text: string) {
  const match =
    text.match(/\b(?:status|http|response)[_\s-]*(?:code|status)?\s*[:=]\s*([1-5]\d{2})\b/i) ??
    text.match(/\bhttp\s*[:=]?\s*([1-5]\d{2})\b/i)
  if (!match) {
    return undefined
  }
  return normalizeHttpStatusCode(Number(match[1]))
}

function pickLogStatusCode(records: PlainRecord[], texts: string[]) {
  const explicitCode = normalizeHttpStatusCode(pickNumberDeep(records, LOG_STATUS_CODE_KEYS))
  if (explicitCode !== undefined) {
    return explicitCode
  }

  const genericErrorCode = normalizeHttpStatusCode(pickNumberDeep(records, LOG_ERROR_CODE_KEYS))
  if (genericErrorCode !== undefined && genericErrorCode >= 400) {
    return genericErrorCode
  }

  for (const text of texts) {
    const code = statusCodeFromText(text)
    if (code !== undefined) {
      return code
    }
  }

  return undefined
}

function compactLogMessage(value: string) {
  return value
    .replace(/\s+/g, ' ')
    .replace(/^["'`]+|["'`]+$/g, '')
    .trim()
    .slice(0, 600)
}

function pickLogErrorMessage(records: PlainRecord[], texts: string[]) {
  const picked = firstPickedString(records, LOG_ERROR_MESSAGE_KEYS)
  if (picked && !LOG_SUCCESS_TEXT_PATTERN.test(picked)) {
    return compactLogMessage(picked)
  }

  const matchedText = texts.find((text) => LOG_ERROR_TEXT_PATTERN.test(text))
  return matchedText ? compactLogMessage(matchedText) : undefined
}

function parseLogErrorInfo(records: PlainRecord[]): Pick<UsageLog, 'errorCode' | 'errorMessage'> {
  const texts = collectLogTexts(records)
  const errorCode = pickLogStatusCode(records, texts)
  const errorMessage = pickLogErrorMessage(records, texts)
  const statusText = pickStringDeep(records, LOG_STATUS_KEYS)

  if (errorCode !== undefined && errorCode >= 400) {
    return { errorCode, errorMessage: errorMessage ?? `HTTP ${errorCode}` }
  }

  if (statusText && !LOG_SUCCESS_TEXT_PATTERN.test(statusText) && LOG_ERROR_TEXT_PATTERN.test(statusText)) {
    return { errorCode, errorMessage: errorMessage ?? statusText }
  }

  if (errorMessage && LOG_ERROR_TEXT_PATTERN.test(errorMessage)) {
    return { errorCode, errorMessage }
  }

  return {}
}

function parseLogStatus(records: PlainRecord[], cachedTokens: number, errorInfo: Pick<UsageLog, 'errorCode' | 'errorMessage'>): UsageLog['status'] {
  if ((errorInfo.errorCode !== undefined && errorInfo.errorCode >= 400) || errorInfo.errorMessage) {
    return 'error'
  }

  const text = pickStringDeep(records, LOG_STATUS_KEYS).toLowerCase()
  if (LOG_ERROR_TEXT_PATTERN.test(text)) {
    return 'error'
  }
  if (LOG_CACHE_TEXT_PATTERN.test(text) || cachedTokens > 0) {
    return 'cached'
  }
  return 'success'
}

const LATENCY_KEYS = [
  'latency_ms',
  'latencyMs',
  'duration_ms',
  'durationMs',
  'elapsed_ms',
  'elapsedMs',
  'response_time_ms',
  'responseTimeMs',
  'request_time_ms',
  'requestTimeMs',
  'time_cost_ms',
  'timeCostMs',
  'cost_time_ms',
  'costTimeMs',
  'latency',
  'duration',
  'elapsed',
  'response_time',
  'responseTime',
  'request_time',
  'requestTime',
  'time_cost',
  'timeCost',
  'use_time',
  'useTime',
  'used_time',
  'usedTime',
  'consume_time',
  'consumeTime',
  'completion_time',
  'completionTime',
  'cost_time',
  'costTime',
]

const FIRST_TOKEN_DURATION_KEYS = [
  'frt_ms',
  'frtMs',
  'ttft_ms',
  'ttftMs',
  'time_to_first_token_ms',
  'timeToFirstTokenMs',
  'first_token_ms',
  'firstTokenMs',
  'first_token_latency_ms',
  'firstTokenLatencyMs',
  'first_response_ms',
  'firstResponseMs',
  'first_byte_ms',
  'firstByteMs',
  'first_char_ms',
  'firstCharMs',
  'first_word_ms',
  'firstWordMs',
  'ttft',
  'time_to_first_token',
  'timeToFirstToken',
  'first_token_time',
  'firstTokenTime',
  'first_token_latency',
  'firstTokenLatency',
  'first_byte_time',
  'firstByteTime',
  'first_char_time',
  'firstCharTime',
  'first_word_time',
  'firstWordTime',
  'frt',
]

// New API / One API 的 first_response_time 在不同版本中有两种含义：
// 一些版本返回首字耗时，另一些版本返回首包到达的 Unix 时间戳。
const FIRST_TOKEN_TIMESTAMP_KEYS = [
  'first_response_time',
  'firstResponseTime',
  'first_response_at',
  'firstResponseAt',
  'first_token_at',
  'firstTokenAt',
]

const REQUEST_START_TIMESTAMP_KEYS = [
  'created_at',
  'createdAt',
  'created_time',
  'createdTime',
  'started_at',
  'startedAt',
  'start_time',
  'startTime',
]

const OUTPUT_TPS_KEYS = [
  'output_tps',
  'outputTps',
  'completion_tps',
  'completionTps',
  'tokens_per_second',
  'tokensPerSecond',
  'output_tokens_per_second',
  'outputTokensPerSecond',
  'tps',
]

const REASONING_EFFORT_KEYS = [
  'reasoning_effort',
  'reasoningEffort',
  'reasoning_effort_level',
  'reasoningEffortLevel',
  'reasoning_level',
  'reasoningLevel',
  'thinking_level',
  'thinkingLevel',
  'effort',
]

function parseTimestampValue(value: unknown) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 9999999999 ? value : value * 1000
  }
  if (typeof value !== 'string' || !value.trim()) {
    return undefined
  }
  const trimmed = value.trim()
  const numericValue = Number(trimmed)
  if (Number.isFinite(numericValue)) {
    return parseTimestampValue(numericValue)
  }

  const hasTimezone = /(?:z|[+-]\d{2}:?\d{2})$/i.test(trimmed)
  if (hasTimezone) {
    const parsed = Date.parse(trimmed)
    if (!Number.isNaN(parsed)) {
      return parsed
    }
  }

  const normalized = trimmed
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

  const parsed = Date.parse(trimmed)
  return Number.isNaN(parsed) ? undefined : parsed
}

function formatFullTime(timestamp: number) {
  return new Date(timestamp).toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  })
}

function normalizePickedDurationMs(records: PlainRecord[], keys: string[]) {
  const direct = pickNumberDeepWithKey(records, keys)
  if (direct) {
    return normalizeDurationValueMs(direct.key, direct.value)
  }
  return 0
}

function pickTimestampDeep(records: PlainRecord[], keys: string[]) {
  for (const record of records) {
    for (const key of keys) {
      if (!(key in record)) {
        continue
      }
      const parsed = parseTimestampValue(record[key])
      if (parsed !== undefined) {
        return parsed
      }
    }
  }
  return undefined
}

function normalizeLatencyMs(records: PlainRecord[]) {
  const direct = normalizePickedDurationMs(records, LATENCY_KEYS)
  if (direct > 0) {
    return direct
  }

  const start =
    parseTimestampValue(pickStringDeep(records, ['started_at', 'start_time', 'startTime', 'created_at', 'createdAt', 'created_time', 'createdTime'])) ??
    pickNumberDeep(records, ['start_timestamp', 'startTimestamp'])
  const end =
    parseTimestampValue(pickStringDeep(records, ['completed_at', 'complete_time', 'completeTime', 'finished_at', 'finishedAt', 'end_time', 'endTime', 'updated_at', 'updatedAt'])) ??
    pickNumberDeep(records, ['end_timestamp', 'endTimestamp'])
  if (Number.isFinite(start) && Number.isFinite(end) && Number(end) > Number(start)) {
    const startMs = Number(start) > 9999999999 ? Number(start) : Number(start) * 1000
    const endMs = Number(end) > 9999999999 ? Number(end) : Number(end) * 1000
    return Math.max(0, Math.round(endMs - startMs))
  }

  return 0
}

function normalizeFirstTokenMs(records: PlainRecord[], latencyMs: number) {
  const firstTokenTimestamp = pickTimestampDeep(records, FIRST_TOKEN_TIMESTAMP_KEYS)
  const requestStartTimestamp = pickTimestampDeep(records, REQUEST_START_TIMESTAMP_KEYS)
  if (
    firstTokenTimestamp !== undefined &&
    requestStartTimestamp !== undefined &&
    firstTokenTimestamp > requestStartTimestamp
  ) {
    const elapsed = Math.max(0, Math.round(firstTokenTimestamp - requestStartTimestamp))
    return latencyMs > 0 ? Math.min(elapsed, latencyMs) : elapsed
  }

  const timestampPick = pickNumberDeepWithKey(records, FIRST_TOKEN_TIMESTAMP_KEYS)
  const timestampValue = timestampPick?.value ?? 0
  const direct = normalizePickedDurationMs(records, FIRST_TOKEN_DURATION_KEYS)
  if (direct > 0) {
    return latencyMs > 0 ? Math.min(direct, latencyMs) : direct
  }

  // 兼容把 first_response_time 直接作为秒数或毫秒数返回的旧版本。
  if (timestampPick && Math.abs(timestampValue) < 100_000_000) {
    const legacyDuration = Math.max(
      0,
      Math.round(Math.abs(timestampValue) >= 1000 ? timestampValue : timestampValue * 1000),
    )
    return latencyMs > 0 ? Math.min(legacyDuration, latencyMs) : legacyDuration
  }

  return 0
}

function normalizeStreamFlag(records: PlainRecord[]) {
  const keys = ['is_stream', 'isStream', 'stream', 'streaming', 'stream_mode', 'streamMode']
  for (const record of records) {
    for (const key of keys) {
      const value = record[key]
      if (typeof value === 'boolean') {
        return value
      }
      if (typeof value === 'number' && Number.isFinite(value)) {
        return value !== 0
      }
      if (typeof value === 'string') {
        const normalized = value.trim().toLowerCase()
        if (['true', '1', 'yes', 'stream', 'streaming', '流', '流式'].includes(normalized)) {
          return true
        }
        if (['false', '0', 'no', 'standard', 'non-stream', 'non_stream', '非流', '非流式'].includes(normalized)) {
          return false
        }
      }
    }
  }
  return undefined
}

function normalizeOutputTokensPerSecond(records: PlainRecord[], output: number, latencyMs: number) {
  const direct = pickNumberDeep(records, OUTPUT_TPS_KEYS)
  if (direct !== undefined && direct >= 0) {
    return direct
  }
  if (output <= 0 || latencyMs <= 0) {
    return undefined
  }
  return output / (latencyMs / 1000)
}

function normalizeReasoningEffort(records: PlainRecord[]) {
  const value = pickStringDeep(records, REASONING_EFFORT_KEYS).trim()
  if (!value) {
    return undefined
  }

  const normalized = value.toLowerCase().replace(/[\s_-]+/g, '')
  const aliases: Record<string, string> = {
    none: '无',
    off: '无',
    disabled: '无',
    minimal: 'minimal',
    low: 'low',
    medium: 'medium',
    med: 'medium',
    high: 'high',
    xhigh: 'xhigh',
    extrahigh: 'xhigh',
  }
  return aliases[normalized] ?? value
}

function normalizeTokenLabel(records: PlainRecord[], index: number) {
  const candidate = pickStringDeep(records, [
    'token_name',
    'tokenName',
    'key_name',
    'keyName',
    'api_key_name',
    'apiKeyName',
    'token_label',
    'tokenLabel',
    'remark',
    'name',
    'token',
  ])
  const normalized = candidate.trim()
  const lower = normalized.toLowerCase()
  if (normalized && !['unknown', 'unkonw', 'undefined', 'null', '-'].includes(lower)) {
    return normalized.startsWith('sk-') || normalized.length > 48 ? maskKey(normalized) : normalized
  }

  const tokenId = pickStringDeep(records, ['token_id', 'tokenId', 'key_id', 'keyId', 'api_key_id', 'apiKeyId'])
  return tokenId ? `令牌 #${tokenId}` : `未命名令牌 ${index + 1}`
}

function normalizeSubscriptionUsage(records: PlainRecord[]) {
  const pair = pickSubscriptionQuotaPair(records)
  const subscriptionPlan = firstPickedString(records, SUBSCRIPTION_NAME_KEYS) ?? pickStringFromRecordText(records, SUBSCRIPTION_NAME_KEYS)
  const subscriptionInstance = firstPickedString(records, SUBSCRIPTION_INSTANCE_KEYS) ?? pickStringFromRecordText(records, SUBSCRIPTION_INSTANCE_KEYS)
  const subscriptionPreDeduct = pickNumberDeepLoose(records, SUBSCRIPTION_PRE_DEDUCT_KEYS) ?? pickNumberFromRecordText(records, SUBSCRIPTION_PRE_DEDUCT_KEYS)
  const subscriptionSettleDelta = pickNumberDeepLoose(records, SUBSCRIPTION_SETTLE_DELTA_KEYS) ?? pickNumberFromRecordText(records, SUBSCRIPTION_SETTLE_DELTA_KEYS)
  const explicitFinalDeduct = pickNumberDeepLoose(records, SUBSCRIPTION_FINAL_DEDUCT_KEYS) ?? pickNumberFromRecordText(records, SUBSCRIPTION_FINAL_DEDUCT_KEYS)
  const inferredFinalDeduct =
    subscriptionPreDeduct !== undefined && subscriptionSettleDelta !== undefined
      ? subscriptionPreDeduct + subscriptionSettleDelta
      : undefined
  const subscriptionFinalDeduct = explicitFinalDeduct ?? inferredFinalDeduct
  const subscriptionRemaining = pickNumberDeepLoose(records, SUBSCRIPTION_REMAINING_KEYS) ?? pair?.remaining ?? pickNumberFromRecordText(records, SUBSCRIPTION_REMAINING_KEYS)
  const subscriptionTotal = pickNumberDeepLoose(records, SUBSCRIPTION_TOTAL_KEYS) ?? pair?.total ?? pickNumberFromRecordText(records, SUBSCRIPTION_TOTAL_KEYS)
  const subscriptionDescription = firstPickedString(records, SUBSCRIPTION_DESCRIPTION_KEYS) ?? pickStringFromRecordText(records, SUBSCRIPTION_DESCRIPTION_KEYS)
  const billingDetail = firstPickedString(records, SUBSCRIPTION_BILLING_DETAIL_KEYS) ?? pickStringFromRecordText(records, SUBSCRIPTION_BILLING_DETAIL_KEYS)
  const hasSubscription =
    Boolean(subscriptionPlan || subscriptionInstance || subscriptionDescription) ||
    [subscriptionPreDeduct, subscriptionSettleDelta, subscriptionFinalDeduct, subscriptionRemaining, subscriptionTotal].some((value) => value !== undefined) ||
    records.some((record) => hasSubscriptionMarker(record))

  return {
    hasSubscription,
    billingDetail,
    subscriptionPlan,
    subscriptionInstance,
    subscriptionPreDeduct,
    subscriptionSettleDelta,
    subscriptionFinalDeduct,
    subscriptionRemaining,
    subscriptionTotal,
    subscriptionDescription,
  }
}

export function normalizeUsageLog(row: unknown, index = 0): UsageLog {
  const record = asRecord(row)
  const records = collectNestedRecords(record)
  const rawInput =
    pickNumberDeep(records, [
      'input_tokens_total',
      'prompt_tokens_total',
      'inputTokens',
      'input_tokens',
      'prompt_tokens',
      'promptTokens',
      'input',
      'prompt',
    ]) ?? 0
  const output =
    pickNumberDeep(records, [
      'outputTokens',
      'output_tokens',
      'completion_tokens',
      'completionTokens',
      'output',
      'completion',
    ]) ?? 0
  const model = pickStringDeep(records, ['model_name', 'model', 'modelName'], 'unknown-model')
  const group = pickStringDeep(records, ['group', 'group_name', 'groupName'], inferGroup(model))
  const { cacheCreation, cacheHit, additive } = normalizeCacheTokens(records)
  const reportedTotal = pickNumberDeep(records, ['total_tokens', 'totalTokens', 'tokens', 'used_tokens'])
  const isClaudeLog = `${model} ${group}`.toLowerCase().includes('claude')
  const expandsCacheTokens = additive || isClaudeLog
  const input = expandsCacheTokens ? rawInput + cacheHit + cacheCreation : rawInput
  const expandedContextTotal = input + output
  const total = expandsCacheTokens
    ? Math.max(reportedTotal ?? 0, expandedContextTotal)
    : reportedTotal ?? input + output
  const subscription = normalizeSubscriptionUsage(records)
  const billedQuotaCost = pickNumberDeep(records, [
    'quota',
    'used_quota',
    'usedQuota',
    'quota_used',
    'quotaUsed',
    'consumed_quota',
    'consumedQuota',
  ])
  const walletQuotaCost = pickNumberDeep(records, [
    'wallet_quota_deducted',
    'walletQuotaDeducted',
    'quota_deducted',
    'quotaDeducted',
  ])
  const quotaCost = subscription.subscriptionFinalDeduct !== undefined
    ? subscription.subscriptionFinalDeduct + (walletQuotaCost ?? 0)
    : billedQuotaCost ?? walletQuotaCost
  const currencyCost = pickNumberDeep(records, [
    'actual_cost',
    'actualCost',
    'cost_usd',
    'costUsd',
    'usd_cost',
    'usdCost',
    'cost',
    'amount',
    'price',
  ])
  const cost = quotaCost !== undefined ? quotaUnitsToCurrency(quotaCost) : currencyCost ?? 0
  const groupRatio = pickNumberDeep(records, ['group_ratio', 'groupRatio'])
  const ratio =
    pickNumberDeep(records, ['ratio', 'total_ratio', 'totalRatio', 'billing_ratio', 'billingRatio', 'quota_ratio', 'quotaRatio']) ??
    groupRatio
  const latencyMs = normalizeLatencyMs(records)
  const errorInfo = parseLogErrorInfo(records)

  return {
    id: pickStringDeep(records, ['id', 'request_id', 'requestId'], `row_${index}`),
    time: normalizeTime(record?.created_at ?? record?.createdAt ?? record?.time ?? record?.timestamp),
    tokenName: normalizeTokenLabel(records, index),
    model,
    group,
    status: parseLogStatus(records, cacheCreation + cacheHit, errorInfo),
    errorCode: errorInfo.errorCode,
    errorMessage: errorInfo.errorMessage,
    input,
    output,
    total,
    cost,
    cacheCreation,
    cacheHit,
    latencyMs,
    firstTokenMs: normalizeFirstTokenMs(records, latencyMs),
    isStream: normalizeStreamFlag(records),
    outputTokensPerSecond: normalizeOutputTokensPerSecond(records, output, latencyMs),
    reasoningEffort: normalizeReasoningEffort(records),
    ip: pickStringDeep(records, ['ip', 'ip_address', 'client_ip'], '-'),
    ratio,
    modelRatio: pickNumberDeep(records, ['model_ratio', 'modelRatio']),
    groupRatio,
    completionRatio: pickNumberDeep(records, ['completion_ratio', 'completionRatio']),
    cacheRatio: pickNumberDeep(records, ['cache_ratio', 'cacheRatio', 'cache_read_ratio', 'cacheReadRatio']),
    billingType: subscription.hasSubscription ? 'subscription' : 'quota',
    billingDetail: subscription.billingDetail,
    subscriptionPlan: subscription.subscriptionPlan,
    subscriptionInstance: subscription.subscriptionInstance,
    subscriptionPreDeduct: subscription.subscriptionPreDeduct,
    subscriptionSettleDelta: subscription.subscriptionSettleDelta,
    subscriptionFinalDeduct: subscription.subscriptionFinalDeduct,
    subscriptionRemaining: subscription.subscriptionRemaining,
    subscriptionTotal: subscription.subscriptionTotal,
    subscriptionDescription: subscription.subscriptionDescription,
  }
}

function normalizeTime(value: unknown) {
  const timestamp = parseTimestampValue(value)
  if (timestamp !== undefined) {
    return formatFullTime(timestamp)
  }

  if (typeof value === 'string' && value.trim()) {
    return value.trim()
  }

  return formatFullTime(Date.now())
}

function rowTimestampValue(row: unknown) {
  const record = asRecord(row)
  const records = collectNestedRecords(record)
  return (
    parseTimestampValue(
      pickStringDeep(records, [
        'created_at',
        'createdAt',
        'created_time',
        'createdTime',
        'start_time',
        'startTime',
        'time',
        'timestamp',
      ]),
    ) ??
    pickNumberDeep(records, [
      'created_at',
      'createdAt',
      'created_time',
      'createdTime',
      'start_timestamp',
      'startTimestamp',
      'time',
      'timestamp',
    ])
  )
}

function parseLogs(
  logResults: RequestResult[] | RequestResult | undefined,
  statResult: RequestResult | undefined,
  dataResult: RequestResult | undefined,
  startTimestamp?: number,
  endTimestamp?: number,
) {
  const logResultList = Array.isArray(logResults) ? logResults : logResults ? [logResults] : []
  const rows = [
    ...logResultList.flatMap((result) => extractList(result.data).map((row) => ({ row, requireTimestamp: false }))),
    ...extractList(statResult?.data).map((row) => ({ row, requireTimestamp: true })),
    ...extractList(dataResult?.data).map((row) => ({ row, requireTimestamp: true })),
  ]
  const seen = new Set<string>()
  const startMs = Number.isFinite(startTimestamp) ? Number(startTimestamp) * 1000 : undefined
  const endMs = Number.isFinite(endTimestamp) ? Number(endTimestamp) * 1000 : undefined

  return rows
    .map(({ row, requireTimestamp }, index) => ({ log: normalizeUsageLog(row, index), requireTimestamp, timestamp: rowTimestampValue(row) }))
    .filter(({ requireTimestamp, timestamp }) => {
      if (timestamp === undefined) {
        return !requireTimestamp
      }
      const value = timestamp > 9999999999 ? timestamp : timestamp * 1000
      return (startMs === undefined || value >= startMs) && (endMs === undefined || value <= endMs)
    })
    .map(({ log }) => log)
    .filter((log) => {
      if (seen.has(log.id)) {
        return false
      }
      seen.add(log.id)
      return true
    })
    .sort((a, b) => (parseTimestampValue(b.time) ?? 0) - (parseTimestampValue(a.time) ?? 0))
    .slice(0, MAX_LOG_ROWS)
}

function accountWithLogSubscription(account: AccountData, logs: UsageLog[]): AccountData {
  const latestSubscriptionLog = logs.find((log) => log.billingType === 'subscription')
  if (!latestSubscriptionLog && account.subscriptionUsedRaw === undefined) {
    return account
  }

  const subscriptionRemainingRaw = account.subscriptionRemainingRaw ?? latestSubscriptionLog?.subscriptionRemaining
  const subscriptionTotalRaw = account.subscriptionTotalRaw ?? latestSubscriptionLog?.subscriptionTotal
  const inferredUsedRaw =
    subscriptionTotalRaw !== undefined && subscriptionRemainingRaw !== undefined && subscriptionTotalRaw >= subscriptionRemainingRaw
      ? subscriptionTotalRaw - subscriptionRemainingRaw
      : undefined
  const finalDeductTotal = logs.reduce((sum, log) => sum + (log.subscriptionFinalDeduct ?? 0), 0)
  const subscriptionUsedRaw = account.subscriptionUsedRaw ?? inferredUsedRaw ?? (finalDeductTotal || undefined)
  const subscriptionUsed = quotaToCurrency(subscriptionUsedRaw)
  const shouldAddHistorical = account.subscriptionUsedRaw === undefined && subscriptionUsed > 0
  const hasAccountSubscriptionBalance = account.subscriptionRemainingRaw !== undefined
  const hasAccountSubscriptionUsed = account.subscriptionUsedRaw !== undefined

  return {
    ...account,
    historicalCost: account.historicalCost + (shouldAddHistorical ? subscriptionUsed : 0),
    subscriptionBalance: hasAccountSubscriptionBalance ? account.subscriptionBalance : quotaToCurrency(subscriptionRemainingRaw),
    subscriptionUsed: hasAccountSubscriptionUsed ? account.subscriptionUsed : subscriptionUsed,
    subscriptionRemainingRaw,
    subscriptionTotalRaw,
    subscriptionUsedRaw,
    subscriptionPreDeductRaw: account.subscriptionPreDeductRaw ?? latestSubscriptionLog?.subscriptionPreDeduct,
    subscriptionSettleDeltaRaw: account.subscriptionSettleDeltaRaw ?? latestSubscriptionLog?.subscriptionSettleDelta,
    subscriptionFinalDeductRaw: account.subscriptionFinalDeductRaw ?? latestSubscriptionLog?.subscriptionFinalDeduct,
    subscriptionName: account.subscriptionName ?? latestSubscriptionLog?.subscriptionPlan,
    subscriptionInstance: account.subscriptionInstance ?? latestSubscriptionLog?.subscriptionInstance,
    subscriptionDescription: account.subscriptionDescription ?? latestSubscriptionLog?.subscriptionDescription,
  }
}

function formatHour(time: string) {
  const timestamp = parseTimestampValue(time)
  if (timestamp !== undefined) {
    const date = new Date(timestamp)
    return `${String(date.getMonth() + 1).padStart(2, '0')}/${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:00`
  }
  return time.slice(0, 16)
}

function buildUsage(logs: UsageLog[], groups: GroupRate[]) {
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
    { ...ZERO_SUMMARY },
  )

  summary.cacheHitRate = summary.input > 0 ? summary.cacheHit / summary.input : 0

  const trendMap = new Map<string, TrendPoint>()
  const trendSortMap = new Map<string, number>()
  const modelMap = new Map<string, ModelUsage>()
  const ratioMap = new Map(groups.map((group) => [group.model, group.ratio]))

  logs.forEach((log) => {
    const hour = formatHour(log.time)
    const timestamp = parseTimestampValue(log.time)
    const trend = trendMap.get(hour) ?? {
      time: hour,
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
    trendMap.set(hour, trend)
    if (timestamp !== undefined) {
      const hourStart = Math.floor(timestamp / 3_600_000) * 3_600_000
      trendSortMap.set(hour, Math.min(trendSortMap.get(hour) ?? hourStart, hourStart))
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

  return {
    summary,
    trends: Array.from(trendMap.values()).sort((a, b) => {
      return (trendSortMap.get(a.time) ?? Number.MAX_SAFE_INTEGER) - (trendSortMap.get(b.time) ?? Number.MAX_SAFE_INTEGER)
    }),
    models: Array.from(modelMap.values()).sort((a, b) => b.cost - a.cost),
  }
}

function availabilityFromResult(name: string, endpoint: string, result: RequestResult | undefined): AvailabilityProbe {
  if (!result) {
    return {
      name,
      endpoint,
      status: 'unknown',
      latencyMs: 0,
      availability: 0,
      detail: '未执行',
    }
  }

  const ok = result.ok
  const status = ok ? (result.durationMs > 2000 ? 'slow' : 'ok') : 'down'
  return {
    name,
    endpoint,
    status,
    latencyMs: Math.round(result.durationMs),
    availability: ok ? (status === 'slow' ? 0.92 : 1) : 0,
    detail: ok
      ? status === 'slow'
        ? `响应较慢（${Math.round(result.durationMs)}ms）`
        : `正常（${Math.round(result.durationMs)}ms）`
      : result.status === 401 || result.status === 403
        ? `鉴权失败 HTTP ${result.status}`
        : result.statusText || `HTTP ${result.status}`,
  }
}

function collectErrors(sources: EndpointSource[]) {
  return sources
    .filter((source) => !source.ok && !source.optional && source.status !== 404)
    .map((source) => `${source.label}：${source.detail ?? source.status ?? source.endpoint}`)
}

function optionalSourceFromFallback(source: EndpointSource, fallback: EndpointSource, fallbackEndpoint: string): EndpointSource {
  if (source.ok) {
    return source
  }

  // /api/ratio_config 是可选接口：只要 /api/pricing 可用，就降级为“可选/未启用”，
  // 不再显示为严重 FAIL。
  if (fallback.ok) {
    return {
      ...source,
      ok: false,
      optional: true,
      kind: 'optional',
      detail: `可选接口未启用；已使用 ${fallbackEndpoint} 获取倍率与定价`,
    }
  }

  return { ...source, optional: true, kind: 'optional' }
}

export async function fetchUsageSnapshot(
  site: RelaySite,
  range?: UsageFetchRange,
  onProgress?: (progress: UsageFetchProgress) => void,
): Promise<UsageSnapshot> {
  const hasExtraApiKey = (site.apiKeyProbes ?? []).some((probe) => probe.enabled && probe.key.trim())
  if (!site.apiKey.trim() && !site.cookie?.trim() && !hasExtraApiKey) {
    return createDemoSnapshot(site)
  }

  const fallbackEnd = Math.floor(Date.now() / 1000)
  const now = range?.endTimestamp ?? fallbackEnd
  const start = range?.startTimestamp ?? now - 24 * 60 * 60
  const rangeLabel = range?.label ?? '最近 24 小时'

  const accountPromise = request({ site, label: '账户信息', path: '/api/user/self' })
  const statPromise = request({ site, label: '用量统计', path: `/api/log/self/stat?start_timestamp=${start}&end_timestamp=${now}` })
  const dataPromise = request({ site, label: '自助数据', path: `/api/data/self?start_timestamp=${start}&end_timestamp=${now}` })
  const logPagesPromise = fetchLogPages(site, start, now, onProgress)
  const tokensPromise = request({ site, label: '令牌列表', path: '/api/token/?p=0&size=50' })
  const groupsPromise = request({ site, label: '分组列表', path: '/api/user/self/groups' })
  const pricingPromise = request({ site, label: '模型定价', path: '/api/pricing' })
  const ratioConfigPromise = request({ site, label: '倍率配置', path: '/api/ratio_config' })
  const statusPromise = request({ site, label: '站点状态', path: '/api/status', timeoutMs: 8000 })
  const modelsPromise = request({ site, label: '兼容模型接口', path: '/v1/models', timeoutMs: 10000 })
  const apiModelsPromise = request({ site, label: '可用模型', path: '/api/models', timeoutMs: 10000 })

  const groupBundlePromise = Promise.all([
    groupsPromise,
    pricingPromise,
    ratioConfigPromise,
    modelsPromise,
    apiModelsPromise,
  ]).then(([groupsResponse, pricingResponse, ratioConfigResponse, modelsResponse, apiModelsResponse]) => {
    const groups = parseGroups(
      pricingResponse.result,
      [apiModelsResponse.result, modelsResponse.result, pricingResponse.result, ratioConfigResponse.result],
      groupsResponse.result,
      ratioConfigResponse.result,
    )
    onProgress?.({ kind: 'groups', groups })
    return { groupsResponse, pricingResponse, ratioConfigResponse, modelsResponse, apiModelsResponse, groups }
  })

  const keyChecksPromise = tokensPromise.then((tokensResponse) =>
    fetchApiKeyChecks(site, parseTokens(tokensResponse.result), onProgress),
  )

  const [
    accountResponse,
    statResponse,
    dataResponse,
    logPagesResponse,
    tokensResponse,
    statusResponse,
    groupBundle,
    earlyKeyChecks,
  ] = await Promise.all([
    accountPromise,
    statPromise,
    dataPromise,
    logPagesPromise,
    tokensPromise,
    statusPromise,
    groupBundlePromise,
    keyChecksPromise,
  ])
  const { groupsResponse, pricingResponse, ratioConfigResponse, modelsResponse, apiModelsResponse, groups } = groupBundle

  const userId = site.userId?.trim()
  const accountUserResponse =
    !hasAccountPayload(accountResponse.result) && userId
      ? await request({ site, label: '账户信息（按 ID）', path: `/api/user/${encodeURIComponent(userId)}` })
      : null
  const accountResult = hasAccountPayload(accountResponse.result)
    ? accountResponse.result
    : accountUserResponse?.result
  const baseAccount = parseAccount(accountResult)
  const accountResolved = hasAccountPayload(accountResult)
  const accountIssues = accountResolved
    ? []
    : [
        accountIssue('account', accountResponse.result),
        ...(accountUserResponse ? [accountIssue('account-user', accountUserResponse.result)] : []),
      ]
  const accountSource: EndpointSource = {
    ...accountResponse.source,
    ok: accountResponse.source.ok && (hasAccountPayload(accountResponse.result) || accountResolved),
    kind: accountResponse.source.ok && (hasAccountPayload(accountResponse.result) || accountResolved)
      ? 'ok'
      : accountResponse.source.kind === 'ok'
        ? 'fail'
        : accountResponse.source.kind,
    detail: hasAccountPayload(accountResponse.result)
      ? accountResponse.source.detail
      : accountResolved
        ? `已通过 /api/user/${userId} 获取账户`
        : accountIssues[0],
  }
  const accountUserSource: EndpointSource | null = accountUserResponse
    ? {
        ...accountUserResponse.source,
        ok: accountUserResponse.source.ok && hasAccountPayload(accountUserResponse.result),
        kind: accountUserResponse.source.ok && hasAccountPayload(accountUserResponse.result)
          ? 'ok'
          : accountUserResponse.source.kind === 'ok'
            ? 'fail'
            : accountUserResponse.source.kind,
        detail: hasAccountPayload(accountUserResponse.result)
          ? accountUserResponse.source.detail
          : accountIssue('account-user', accountUserResponse.result),
      }
    : null

  const ratioConfigSource = optionalSourceFromFallback(ratioConfigResponse.source, pricingResponse.source, '/api/pricing')
  const sources = [
    accountSource,
    ...(accountUserSource ? [accountUserSource] : []),
    statResponse.source,
    dataResponse.source,
    logPagesResponse.source,
    tokensResponse.source,
    groupsResponse.source,
    pricingResponse.source,
    ratioConfigSource,
    statusResponse.source,
    modelsResponse.source,
    apiModelsResponse.source,
  ]

  const logs = parseLogs(logPagesResponse.results, statResponse.result, dataResponse.result, start, now)
  const account = accountWithLogSubscription(baseAccount, logs)
  const usage = buildUsage(logs, groups)
  const tokens = parseTokens(tokensResponse.result)
  const keyChecks = applyApiKeyLogStats(earlyKeyChecks, logs)
  const availability: AvailabilityProbe[] = [
    availabilityFromResult('站点状态', '/api/status', statusResponse.result),
    availabilityFromResult('兼容模型接口', '/v1/models', modelsResponse.result),
    availabilityFromResult('可用模型', '/api/models', apiModelsResponse.result),
    availabilityFromResult('管理接口', accountUserResponse ? `/api/user/${userId}` : '/api/user/self', accountResult),
  ]

  const hasLiveUsage = logs.length > 0
  const demo = hasLiveUsage ? null : createDemoSnapshot(site)
  const errors = collectErrors(sources)
  const modelFallback = parseModels(apiModelsResponse.result, modelsResponse.result, pricingResponse.result, ratioConfigResponse.result)
  const fallbackGroups = groups.length
    ? groups
    : modelFallback.map((model) => ({ group: inferGroup(model), model, ratio: 1, enabled: true }))

  return {
    generatedAt: new Date().toISOString(),
    mode: errors.length || !hasLiveUsage ? 'partial' : 'live',
    account,
    summary: hasLiveUsage ? usage.summary : { ...ZERO_SUMMARY },
    trends: hasLiveUsage ? usage.trends : [],
    models: hasLiveUsage ? usage.models : [],
    availability,
    groups: fallbackGroups.length ? fallbackGroups : demo?.groups ?? [],
    tokens: tokens.length ? tokens : demo?.tokens ?? [],
    keyChecks: keyChecks.length ? keyChecks : demo?.keyChecks ?? [],
    logs: hasLiveUsage ? logs : [],
    sources,
    errors: hasLiveUsage ? errors : [...errors, `未获取到${rangeLabel}调用日志：图表暂无数据。请确认该账户在该时间范围内有调用记录，或检查 Cookie/API Key 权限。`],
  }
}
