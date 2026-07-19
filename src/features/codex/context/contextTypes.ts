import type { CodexContextEntry } from '../types'

export type ContextKind = CodexContextEntry['kind']

export type ContextDraft = {
  kind: ContextKind
  id: string
  tomlBody: string
  editing: boolean
}

export const CONTEXT_KIND_LABELS: Record<ContextKind, string> = {
  mcp: 'MCP 服务器',
  skill: '技能',
  plugin: '插件',
}

export function setContextEnabled(tomlBody: string, enabled: boolean) {
  const lines = tomlBody.replace(/\r\n/g, '\n').split('\n')
  const nestedTableIndex = lines.findIndex((line) => line.trimStart().startsWith('['))
  const boundary = nestedTableIndex < 0 ? lines.length : nestedTableIndex
  const rootLines = lines.slice(0, boundary).filter((line) => !/^\s*(enabled|disabled)\s*=/.test(line))
  const nestedLines = lines.slice(boundary)
  const normalized = [`enabled = ${enabled ? 'true' : 'false'}`, ...rootLines, ...nestedLines]
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return `${normalized}\n`
}
