import type { HotSwitchModelMapping, RelayProfile } from '../types'

const AUTO_MODEL_ID = 'codex-compass-auto'

export type MappingValidation = {
  valid: boolean
  messages: string[]
  rowErrors: Record<number, string[]>
}

export function validateMappings(mappings: HotSwitchModelMapping[], profiles: RelayProfile[]): MappingValidation {
  const providerIds = new Set(profiles.filter((profile) => profile.relayMode !== 'aggregate').map((profile) => profile.id))
  const aliases = new Map<string, number[]>()
  const rowErrors: Record<number, string[]> = {}

  const addError = (index: number, message: string) => {
    rowErrors[index] = [...(rowErrors[index] ?? []), message]
  }

  mappings.forEach((mapping, index) => {
    const alias = mapping.model.trim()
    const upstream = mapping.upstreamModel.trim()
    if (!alias) addError(index, 'Codex 模型别名不能为空。')
    if (alias === AUTO_MODEL_ID) addError(index, `“${AUTO_MODEL_ID}”是自动模型保留名称。`)
    if (!upstream) addError(index, '上游模型不能为空。')
    if (!mapping.relayId || !providerIds.has(mapping.relayId)) addError(index, '首选供应商不存在或已失效。')

    if (alias) aliases.set(alias, [...(aliases.get(alias) ?? []), index])

    const fallbacks = mapping.fallbackRelayIds ?? []
    const seen = new Set<string>()
    for (const relayId of fallbacks) {
      if (relayId === mapping.relayId) addError(index, '备用供应商不能包含首选供应商。')
      if (!providerIds.has(relayId)) addError(index, `备用供应商 ${relayId} 不存在。`)
      if (seen.has(relayId)) addError(index, '备用供应商列表中存在重复项。')
      seen.add(relayId)
    }
  })

  for (const [alias, indexes] of aliases) {
    if (indexes.length < 2) continue
    indexes.forEach((index) => addError(index, `模型别名“${alias}”重复。`))
  }

  const messages = Object.entries(rowErrors).flatMap(([index, errors]) => errors.map((error) => `第 ${Number(index) + 1} 条：${error}`))
  return { valid: messages.length === 0, messages, rowErrors }
}
