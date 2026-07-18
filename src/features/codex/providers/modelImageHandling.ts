export type ImageHandling = 'send-as-is' | 'strip' | 'vlm'

export function configuredModelNames(modelList: string): string[] {
  return Array.from(new Set(
    modelList
      .split(/[\r\n,]/)
      .map((model) => model.trim())
      .filter(Boolean),
  ))
}

export function parseModelImageHandling(modelVlm?: string): Record<string, ImageHandling> {
  try {
    const raw = JSON.parse(modelVlm || '{}') as Record<string, unknown>
    return Object.fromEntries(
      Object.entries(raw).filter((entry): entry is [string, ImageHandling] =>
        Boolean(entry[0].trim()) && (entry[1] === 'strip' || entry[1] === 'vlm'),
      ),
    )
  } catch {
    return {}
  }
}

export function updateModelImageHandling(
  modelList: string,
  modelVlm: string | undefined,
  model: string,
  mode: ImageHandling,
): string {
  const configured = new Set(configuredModelNames(modelList))
  const next = parseModelImageHandling(modelVlm)
  if (configured.has(model) && mode !== 'send-as-is') next[model] = mode
  else delete next[model]
  return JSON.stringify(
    Object.fromEntries(Object.entries(next).filter(([name]) => configured.has(name))),
  )
}

export function normalizeModelImageHandling(modelList: string, modelVlm?: string): string {
  const configured = new Set(configuredModelNames(modelList))
  return JSON.stringify(
    Object.fromEntries(
      Object.entries(parseModelImageHandling(modelVlm))
        .filter(([model]) => configured.has(model)),
    ),
  )
}
