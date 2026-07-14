import assert from 'node:assert/strict'
import test from 'node:test'
import { validateMappings } from '../src/features/codex/hotSwitch/mappingValidation.ts'
import { setContextEnabled } from '../src/features/codex/context/contextTypes.ts'
import { normalizeDurationValueMs } from '../src/lib/duration.ts'
import { buildTimeWindow, DAY_MS } from '../src/lib/timeWindow.ts'

const profiles = [
  { id: 'relay-a', name: 'A', relayMode: 'pureApi' },
  { id: 'relay-b', name: 'B', relayMode: 'pureApi' },
  { id: 'aggregate', name: 'Aggregate', relayMode: 'aggregate' },
]

test('valid model mapping accepts a real primary provider and unique fallbacks', () => {
  const result = validateMappings([{
    model: 'gpt-5',
    upstreamModel: 'gpt-5-2025',
    relayId: 'relay-a',
    candidateRelayIds: ['relay-b'],
    fallbackRelayIds: ['relay-b'],
  }], profiles)
  assert.equal(result.valid, true)
  assert.deepEqual(result.messages, [])
})

test('mapping validation rejects duplicate aliases and invalid fallback chains', () => {
  const result = validateMappings([
    { model: 'gpt-5', upstreamModel: 'one', relayId: 'relay-a', candidateRelayIds: [], fallbackRelayIds: ['relay-a', 'missing', 'missing'] },
    { model: 'gpt-5', upstreamModel: '', relayId: 'aggregate', candidateRelayIds: [], fallbackRelayIds: [] },
  ], profiles)
  assert.equal(result.valid, false)
  assert.ok(result.messages.some((message) => message.includes('模型别名“gpt-5”重复')))
  assert.ok(result.messages.some((message) => message.includes('备用供应商不能包含首选供应商')))
  assert.ok(result.messages.some((message) => message.includes('备用供应商 missing 不存在')))
  assert.ok(result.messages.some((message) => message.includes('上游模型不能为空')))
  assert.ok(result.messages.some((message) => message.includes('首选供应商不存在')))
})

test('mapping validation reserves the Codex Compass auto model alias', () => {
  const result = validateMappings([{
    model: 'codex-compass-auto',
    upstreamModel: 'real-model',
    relayId: 'relay-a',
    candidateRelayIds: ['relay-a'],
    fallbackRelayIds: [],
  }], profiles)

  assert.equal(result.valid, false)
  assert.ok(result.messages.some((message) => message.includes('自动模型保留名称')))
})

test('context toggle replaces root flags without changing nested table flags', () => {
  const source = 'enabled = false\ndisabled = true\ncommand = "node"\n\n[environment]\ndisabled = true\n'
  const enabled = setContextEnabled(source, true)
  const rootSection = enabled.split('[environment]')[0]
  assert.match(enabled, /^enabled = true/m)
  assert.doesNotMatch(rootSection, /^disabled = true/m)
  assert.match(enabled, /\[environment\]\ndisabled = true/)
})

test('rolling 24-hour window uses the supplied refresh time', () => {
  const now = Date.parse('2026-07-11T08:30:00.000Z')
  const window = buildTimeWindow('24h', '', '', now)

  assert.equal(window.startMs, now - DAY_MS)
  assert.equal(window.endMs, now)
  assert.equal(window.valid, true)
})

test('rolling window advances both boundaries on a later refresh', () => {
  const firstNow = Date.parse('2026-07-11T08:30:00.000Z')
  const secondNow = firstNow + 15 * 60_000
  const first = buildTimeWindow('24h', '', '', firstNow)
  const second = buildTimeWindow('24h', '', '', secondNow)

  assert.equal(second.startMs - first.startMs, 15 * 60_000)
  assert.equal(second.endMs - first.endMs, 15 * 60_000)
})

test('custom window remains fixed when refresh time advances', () => {
  const customStart = '2026-07-01T09:00'
  const customEnd = '2026-07-02T18:30'
  const first = buildTimeWindow('custom', customStart, customEnd, Date.parse('2026-07-11T08:30:00.000Z'))
  const second = buildTimeWindow('custom', customStart, customEnd, Date.parse('2026-07-12T08:30:00.000Z'))

  assert.deepEqual(second, first)
  assert.equal(first.valid, true)
})

test('usage log keeps New API frt values in milliseconds', () => {
  assert.equal(normalizeDurationValueMs('frt', 3136), 3136)
  assert.equal(normalizeDurationValueMs('ttft', 3339), 3339)
})

test('usage log still accepts fractional frt values in seconds', () => {
  assert.equal(normalizeDurationValueMs('frt', 3.339), 3339)
  assert.equal(normalizeDurationValueMs('ttft', 3.136), 3136)
})
