import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import {
  Blocks,
  Check,
  CircleAlert,
  Code2,
  Copy,
  Image,
  Import,
  ListChecks,
  LoaderCircle,
  MonitorCog,
  Palette,
  Power,
  RefreshCw,
  RotateCcw,
  Save,
  Sparkles,
  Trash2,
  Upload,
  Wrench,
} from 'lucide-react'
import { callCodex } from '../api'
import { CodexNotice } from '../shared/CodexNotice'
import { useLanguage } from '../../../lib/i18n'
import { ThemeShowcaseEditor } from './ThemeShowcaseEditor'
import type {
  ThemeDefinition,
  ThemePresentation,
  ThemeShowcase,
  ThemeShowcaseCard,
  ThemeShowcaseCardIcon,
  ThemeStudioResult,
  ThemeStudioSettings,
  ThemeVisual,
} from './types'
import './ThemeStudioPage.css'

type Notice = { tone: 'ok' | 'warning' | 'error' | 'info'; text: string }

const MAX_WALLPAPER_BYTES = 8 * 1024 * 1024
const MAX_PACKAGE_BYTES = 12 * 1024 * 1024

const colorFields: Array<[keyof ThemeVisual, string]> = [
  ['accent', '强调色'],
  ['accentSoft', '柔和强调色'],
  ['background', '背景色'],
  ['surface', '面板色'],
  ['surfaceAlt', '次级面板色'],
  ['text', '正文色'],
  ['textMuted', '次要文字'],
  ['border', '边框色'],
]

const sliderFields: Array<[keyof ThemeVisual, string, number, number, string]> = [
  ['sidebarOpacity', '侧栏透明度', 45, 100, '%'],
  ['contentOpacity', '内容透明度', 45, 100, '%'],
  ['wallpaperOpacity', '壁纸可见度', 0, 100, '%'],
  ['blurPx', '玻璃模糊', 0, 32, ' px'],
  ['radiusPx', '界面圆角', 0, 24, ' px'],
  ['fontScale', '字体比例', 85, 120, '%'],
]

const showcaseIconComponents: Record<ThemeShowcaseCardIcon, typeof Code2> = {
  code: Code2,
  build: Blocks,
  review: ListChecks,
  repair: Wrench,
}

function noticeFrom(result: ThemeStudioResult): Notice {
  if (result.status === 'ok') return { tone: 'ok', text: result.message }
  if (result.status === 'warning') return { tone: 'warning', text: result.message }
  return { tone: 'error', text: result.message }
}

function safeBackgroundImage(dataUrl: string) {
  if (!dataUrl.startsWith('data:image/')) return undefined
  return `url("${dataUrl.replaceAll('"', '%22')}")`
}

const presentationDefaults: Record<string, ThemePresentation> = {
  'rose-garden': {
    layoutStyle: 'editorial', cardStyle: 'paper', motifStyle: 'roses', headerBadge: '玫瑰灵感限定',
    heroPosition: 'far-right', overlayStrength: 88, taskWallpaperOpacity: 8, taskMode: 'ambient',
  },
  'warm-manuscript': {
    layoutStyle: 'fortune', cardStyle: 'paper', motifStyle: 'coins', headerBadge: '今日财运在线',
    heroPosition: 'far-right', overlayStrength: 90, taskWallpaperOpacity: 7, taskMode: 'ambient',
  },
  'mint-paper': {
    layoutStyle: 'paper', cardStyle: 'paper', motifStyle: 'leaves', headerBadge: '纸笺限定',
    heroPosition: 'far-right', overlayStrength: 90, taskWallpaperOpacity: 7, taskMode: 'ambient',
  },
  'ink-night': {
    layoutStyle: 'cosmic', cardStyle: 'glass', motifStyle: 'butterflies', headerBadge: '蝶光限定',
    heroPosition: 'far-right', overlayStrength: 78, taskWallpaperOpacity: 9, taskMode: 'ambient',
  },
  'starlight-stage': {
    layoutStyle: 'stage', cardStyle: 'solid', motifStyle: 'jasmine', headerBadge: '茉莉舞台',
    heroPosition: 'far-right', overlayStrength: 76, taskWallpaperOpacity: 8, taskMode: 'ambient',
  },
  'red-future-city': {
    layoutStyle: 'future', cardStyle: 'solid', motifStyle: 'orbit', headerBadge: '面向每一个人',
    heroPosition: 'right', overlayStrength: 86, taskWallpaperOpacity: 8, taskMode: 'banner',
  },
  'enfp-doodle': {
    layoutStyle: 'doodle', cardStyle: 'outline', motifStyle: 'doodles', headerBadge: 'ENERGY 100%',
    heroPosition: 'far-right', overlayStrength: 84, taskWallpaperOpacity: 6, taskMode: 'ambient',
  },
  'cyan-virtual-stage': {
    layoutStyle: 'idol', cardStyle: 'glass', motifStyle: 'stars', headerBadge: '未来舞台',
    heroPosition: 'far-right', overlayStrength: 86, taskWallpaperOpacity: 7, taskMode: 'ambient',
  },
}

const fallbackPresentation: ThemePresentation = {
  layoutStyle: 'editorial',
  cardStyle: 'glass',
  motifStyle: 'stars',
  headerBadge: '主题限定',
  heroPosition: 'right',
  overlayStrength: 72,
  taskWallpaperOpacity: 8,
  taskMode: 'ambient',
}

const motifLabels: Record<ThemePresentation['motifStyle'], string> = {
  roses: '玫瑰',
  coins: '金币',
  orbit: '星轨',
  leaves: '叶片',
  doodles: '涂鸦',
  butterflies: '蝴蝶',
  stars: '星光',
  jasmine: '茉莉',
}

const taskModeLabels: Record<ThemePresentation['taskMode'], string> = {
  ambient: '环境背景',
  banner: '顶部横幅',
  off: '关闭壁纸',
}

function presentationFor(theme: Pick<ThemeDefinition, 'id'>): ThemePresentation {
  return structuredClone(presentationDefaults[theme.id] ?? fallbackPresentation)
}

function cloneSettings(settings: ThemeStudioSettings): ThemeStudioSettings {
  const cloned = structuredClone(settings)
  return {
    ...cloned,
    themes: cloned.themes.map((theme) => ({
      ...theme,
      presentation: { ...presentationFor(theme), ...theme.presentation },
    })),
  }
}

async function fileAsDataUrl(file: File) {
  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error ?? new Error('读取图片失败'))
    reader.onload = () => resolve(String(reader.result ?? ''))
    reader.readAsDataURL(file)
  })
}

async function fileAsBase64(file: File) {
  const bytes = new Uint8Array(await file.arrayBuffer())
  let binary = ''
  const chunkSize = 32_768
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize))
  }
  return btoa(binary)
}

export function ThemeStudioPage() {
  const { language, t } = useLanguage()
  const [result, setResult] = useState<ThemeStudioResult | null>(null)
  const [draft, setDraft] = useState<ThemeStudioSettings | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [busy, setBusy] = useState('')
  const wallpaperInput = useRef<HTMLInputElement>(null)
  const showcaseHeroInput = useRef<HTMLInputElement>(null)
  const showcasePortraitInput = useRef<HTMLInputElement>(null)
  const packageInput = useRef<HTMLInputElement>(null)

  const acceptResult = useCallback((next: ThemeStudioResult) => {
    setResult(next)
    setDraft(cloneSettings(next.settings))
    setNotice(noticeFrom(next))
  }, [])

  const run = useCallback(async (
    key: string,
    operation: () => Promise<ThemeStudioResult>,
  ) => {
    setBusy(key)
    try {
      const next = await operation()
      acceptResult(next)
      return next
    } catch (error) {
      setNotice({ tone: 'error', text: error instanceof Error ? error.message : String(error) })
      return null
    } finally {
      setBusy('')
    }
  }, [acceptResult])

  useEffect(() => {
    void run('load', () => callCodex<ThemeStudioResult>('load_codex_theme_studio'))
  }, [run])

  const selectedTheme = useMemo(() => {
    if (!draft) return null
    return draft.themes.find((theme) => theme.id === draft.selectedThemeId) ?? draft.themes[0] ?? null
  }, [draft])

  const patchSelectedTheme = useCallback((patch: Partial<ThemeDefinition>) => {
    setDraft((current) => {
      if (!current) return current
      return {
        ...current,
        themes: current.themes.map((theme) => (
          theme.id === current.selectedThemeId ? { ...theme, ...patch } : theme
        )),
      }
    })
  }, [])

  const patchVisual = useCallback((patch: Partial<ThemeVisual>) => {
    setDraft((current) => {
      if (!current) return current
      return {
        ...current,
        themes: current.themes.map((theme) => (
          theme.id === current.selectedThemeId
            ? { ...theme, visual: { ...theme.visual, ...patch } }
            : theme
        )),
      }
    })
  }, [])

  const patchShowcase = useCallback((patch: Partial<ThemeShowcase>) => {
    setDraft((current) => {
      if (!current) return current
      return {
        ...current,
        themes: current.themes.map((theme) => (
          theme.id === current.selectedThemeId
            ? { ...theme, showcase: { ...theme.showcase, ...patch } }
            : theme
        )),
      }
    })
  }, [])

  const patchPresentation = useCallback((patch: Partial<ThemePresentation>) => {
    setDraft((current) => {
      if (!current) return current
      return {
        ...current,
        themes: current.themes.map((theme) => (
          theme.id === current.selectedThemeId
            ? { ...theme, presentation: { ...theme.presentation, ...patch } }
            : theme
        )),
      }
    })
  }, [])

  const patchShowcaseCard = useCallback((index: number, patch: Partial<ThemeShowcaseCard>) => {
    setDraft((current) => {
      if (!current) return current
      return {
        ...current,
        themes: current.themes.map((theme) => {
          if (theme.id !== current.selectedThemeId) return theme
          return {
            ...theme,
            showcase: {
              ...theme.showcase,
              cards: theme.showcase.cards.map((card, cardIndex) => (
                cardIndex === index ? { ...card, ...patch } : card
              )),
            },
          }
        }),
      }
    })
  }, [])

  const save = useCallback(async () => {
    if (!draft) return
    await run('save', () => callCodex<ThemeStudioResult>('save_codex_theme_studio', {
      request: { settings: draft },
    }))
  }, [draft, run])

  const duplicateSelected = useCallback(() => {
    if (!selectedTheme) return
    const id = `custom-${Date.now().toString(36)}`
    const duplicate: ThemeDefinition = {
      ...structuredClone(selectedTheme),
      id,
      name: language === 'en-US' ? `${t(selectedTheme.name)} Copy` : `${selectedTheme.name} 副本`,
      builtin: false,
      author: '本地用户',
      version: '1.0.0',
      license: 'Private',
    }
    setDraft((current) => current ? {
      ...current,
      selectedThemeId: id,
      themes: [...current.themes, duplicate],
    } : current)
    setNotice({ tone: 'info', text: '已创建主题副本，保存后生效。' })
  }, [language, selectedTheme, t])

  const handleWallpaper = useCallback(async (file: File | undefined) => {
    if (!file) return
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
      setNotice({ tone: 'error', text: '壁纸仅支持 PNG、JPEG 或 WebP。' })
      return
    }
    if (file.size > MAX_WALLPAPER_BYTES) {
      setNotice({ tone: 'error', text: '壁纸不能超过 8 MB。' })
      return
    }
    setBusy('wallpaper')
    try {
      const wallpaperDataUrl = await fileAsDataUrl(file)
      patchSelectedTheme({ wallpaperDataUrl, decorativeStyle: 'none' })
      setNotice({ tone: 'info', text: '壁纸已载入预览，点击“保存并应用”写入配置。' })
    } catch (error) {
      setNotice({ tone: 'error', text: error instanceof Error ? error.message : String(error) })
    } finally {
      setBusy('')
      if (wallpaperInput.current) wallpaperInput.current.value = ''
    }
  }, [patchSelectedTheme])

  const handleShowcaseImage = useCallback(async (
    kind: 'hero' | 'portrait',
    file: File | undefined,
  ) => {
    if (!file) return
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
      setNotice({ tone: 'error', text: t('图片仅支持 PNG、JPEG 或 WebP。') })
      return
    }
    if (file.size > MAX_WALLPAPER_BYTES) {
      setNotice({ tone: 'error', text: t('图片不能超过 8 MB。') })
      return
    }
    const busyKey = kind === 'hero' ? 'showcase-hero' : 'showcase-portrait'
    const inputRef = kind === 'hero' ? showcaseHeroInput : showcasePortraitInput
    setBusy(busyKey)
    try {
      const dataUrl = await fileAsDataUrl(file)
      patchShowcase(kind === 'hero'
        ? { heroImageDataUrl: dataUrl }
        : { portraitImageDataUrl: dataUrl })
      setNotice({ tone: 'info', text: t('展示图片已载入预览，保存后应用到 Codex 首页。') })
    } catch (error) {
      setNotice({ tone: 'error', text: error instanceof Error ? error.message : String(error) })
    } finally {
      setBusy('')
      if (inputRef.current) inputRef.current.value = ''
    }
  }, [patchShowcase, t])

  const handlePackage = useCallback(async (file: File | undefined) => {
    if (!file) return
    if (file.size > MAX_PACKAGE_BYTES) {
      setNotice({ tone: 'error', text: '主题包不能超过 12 MB。' })
      return
    }
    setBusy('import')
    try {
      const contentsBase64 = await fileAsBase64(file)
      const next = await callCodex<ThemeStudioResult>('import_codex_theme_package', {
        request: { fileName: file.name, contentsBase64 },
      })
      acceptResult(next)
    } catch (error) {
      setNotice({ tone: 'error', text: error instanceof Error ? error.message : String(error) })
    } finally {
      setBusy('')
      if (packageInput.current) packageInput.current.value = ''
    }
  }, [acceptResult])

  const deleteSelected = useCallback(async () => {
    if (!selectedTheme || selectedTheme.builtin) return
    const message = language === 'en-US'
      ? `Delete theme "${t(selectedTheme.name)}"?`
      : `确定删除主题“${selectedTheme.name}”吗？`
    if (!window.confirm(message)) return
    await run('delete', () => callCodex<ThemeStudioResult>('delete_codex_theme', {
      request: { themeId: selectedTheme.id },
    }))
  }, [language, run, selectedTheme, t])

  const reset = useCallback(async () => {
    const message = language === 'en-US'
      ? 'Disable themes and restore all built-in presets?'
      : '确定关闭主题并恢复全部内置预设吗？'
    if (!window.confirm(message)) return
    await run('reset', () => callCodex<ThemeStudioResult>('reset_codex_theme_studio'))
  }, [language, run])

  if (!draft || !selectedTheme || !result) {
    return (
      <div className="theme-studio-loading" aria-live="polite">
        {busy === 'load' ? <LoaderCircle className="spin" size={24} /> : <CircleAlert size={24} />}
        <strong>{busy === 'load' ? '正在加载 Codex 主题工坊' : '主题工坊加载失败'}</strong>
        {busy !== 'load' ? <button type="button" onClick={() => void run('load', () => callCodex<ThemeStudioResult>('load_codex_theme_studio'))}><RefreshCw size={15} />重试</button> : null}
      </div>
    )
  }

  const previewStyle = {
    '--theme-preview-accent': selectedTheme.visual.accent,
    '--theme-preview-accent-soft': selectedTheme.visual.accentSoft,
    '--theme-preview-bg': selectedTheme.visual.background,
    '--theme-preview-surface': selectedTheme.visual.surface,
    '--theme-preview-surface-alt': selectedTheme.visual.surfaceAlt,
    '--theme-preview-text': selectedTheme.visual.text,
    '--theme-preview-muted': selectedTheme.visual.textMuted,
    '--theme-preview-border': selectedTheme.visual.border,
    '--theme-preview-radius': `${selectedTheme.visual.radiusPx}px`,
    '--theme-preview-blur': `${selectedTheme.visual.blurPx}px`,
    '--theme-preview-sidebar-opacity': selectedTheme.visual.sidebarOpacity / 100,
    '--theme-preview-content-opacity': selectedTheme.visual.contentOpacity / 100,
    '--theme-preview-wallpaper-opacity': selectedTheme.visual.wallpaperOpacity / 100,
    '--theme-preview-overlay-strength': selectedTheme.presentation.overlayStrength / 100,
    '--theme-preview-task-wallpaper-opacity': selectedTheme.presentation.taskWallpaperOpacity / 100,
    backgroundImage: safeBackgroundImage(selectedTheme.wallpaperDataUrl),
    backgroundSize: selectedTheme.visual.wallpaperFit === 'tile' ? 'auto' : selectedTheme.visual.wallpaperFit,
    backgroundRepeat: selectedTheme.visual.wallpaperFit === 'tile' ? 'repeat' : 'no-repeat',
  } as CSSProperties

  const showcasePreviewStyle = {
    backgroundImage: safeBackgroundImage(
      selectedTheme.showcase.heroImageDataUrl || selectedTheme.wallpaperDataUrl,
    ),
  } as CSSProperties

  return (
    <div className="theme-studio">
      {notice ? <CodexNotice tone={notice.tone} text={notice.text} onDismiss={() => setNotice(null)} /> : null}

      <header className="theme-studio-header">
        <div>
          <span className="theme-studio-eyebrow"><Palette size={15} />Codex 主题工坊</span>
          <h1>{t(selectedTheme.name)}</h1>
          <p>{t(selectedTheme.description)}</p>
        </div>
        <div className="theme-studio-header-actions">
          <div className={`theme-runtime-state ${result.runtimeConnected ? 'connected' : ''}`}>
            <span />
            <div><strong>{result.runtimeConnected ? 'Codex 已连接' : 'Codex 未连接'}</strong><small>CDP {result.debugPort} · {result.runtimeStatus}</small></div>
          </div>
          <label className="theme-master-switch">
            <span>{draft.enabled ? '主题已开启' : '主题已关闭'}</span>
            <input
              type="checkbox"
              checked={draft.enabled}
              onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })}
            />
            <i><Power size={14} /></i>
          </label>
        </div>
      </header>

      <section className="theme-library" aria-label="主题库">
        <div className="theme-section-heading">
          <div><strong>主题库</strong><span>{draft.themes.length} 个主题</span></div>
          <div className="theme-inline-actions">
            <button type="button" onClick={duplicateSelected}><Copy size={15} />复制当前主题</button>
            <button type="button" disabled={busy === 'import'} onClick={() => packageInput.current?.click()}>
              {busy === 'import' ? <LoaderCircle className="spin" size={15} /> : <Import size={15} />}导入主题包
            </button>
          </div>
        </div>
        <div className="theme-card-grid">
          {draft.themes.map((theme) => (
            <button
              className={theme.id === draft.selectedThemeId ? 'theme-card selected' : 'theme-card'}
              key={theme.id}
              type="button"
              onClick={() => setDraft({ ...draft, selectedThemeId: theme.id })}
            >
              <span
                className="theme-card-preview"
                style={{
                  backgroundColor: theme.visual.background,
                  backgroundImage: safeBackgroundImage(theme.wallpaperDataUrl),
                  backgroundSize: 'cover',
                }}
              >
                <i style={{ background: theme.visual.surface, borderColor: theme.visual.border }} />
                <i style={{ background: theme.visual.accentSoft, borderColor: theme.visual.accent }} />
                {theme.id === draft.selectedThemeId ? <b><Check size={14} /></b> : null}
              </span>
              <span className="theme-card-copy"><strong>{t(theme.name)}</strong><small>{theme.builtin ? '内置主题' : theme.author || '自定义主题'}</small></span>
            </button>
          ))}
        </div>
      </section>

      <div className="theme-editor-layout">
        <section className="theme-preview-section">
          <div className="theme-section-heading">
            <div><strong>Codex 实时预览</strong><span>{draft.enabled ? '应用后显示' : '开启主题后显示'}</span></div>
            <button type="button" disabled={busy === 'reload'} onClick={() => void run('reload', () => callCodex<ThemeStudioResult>('reload_codex_theme_studio'))}>
              {busy === 'reload' ? <LoaderCircle className="spin" size={15} /> : <RefreshCw size={15} />}重新加载
            </button>
          </div>
          <div className="theme-codex-preview" style={previewStyle}>
            <div className="theme-preview-wallpaper" />
            <aside>
              <div className="theme-preview-brand"><Sparkles size={15} /><strong>Codex</strong></div>
              <button type="button" className="active"><MonitorCog size={14} />新建任务</button>
              <button type="button"><Check size={14} />已有任务</button>
              <span>项目</span>
              <button type="button">主题工坊开发</button>
              <button type="button">远程控制验证</button>
            </aside>
            <main>
              <header><div><small>Codex Compass Theme</small><strong>{t(selectedTheme.name)}</strong></div><span>{draft.enabled ? 'ON' : 'OFF'}</span></header>
              <div
                className={[
                  'theme-preview-showcase',
                  selectedTheme.showcase.portraitImageDataUrl ? 'has-portrait' : '',
                  selectedTheme.id ? `theme-${selectedTheme.id}` : '',
                ].filter(Boolean).join(' ')}
                style={showcasePreviewStyle}
                data-layout-style={selectedTheme.presentation.layoutStyle}
                data-card-style={selectedTheme.presentation.cardStyle}
                data-motif-style={selectedTheme.presentation.motifStyle}
                data-hero-position={selectedTheme.presentation.heroPosition}
                data-task-mode={selectedTheme.presentation.taskMode}
              >
                <div className="theme-preview-showcase-copy">
                  {selectedTheme.presentation.headerBadge ? (
                    <span className="theme-preview-header-badge"><Sparkles size={11} />{t(selectedTheme.presentation.headerBadge)}</span>
                  ) : null}
                  {selectedTheme.showcase.eyebrow ? <small>{t(selectedTheme.showcase.eyebrow)}</small> : null}
                  <h2>{t(selectedTheme.showcase.title || selectedTheme.name)}</h2>
                  {selectedTheme.showcase.subtitle ? <p>{t(selectedTheme.showcase.subtitle)}</p> : null}
                </div>
                {selectedTheme.showcase.portraitImageDataUrl ? (
                  <img src={selectedTheme.showcase.portraitImageDataUrl} alt="" />
                ) : null}
                <div className="theme-preview-motif" aria-hidden="true">
                  <Sparkles size={13} />
                  <span>{t(motifLabels[selectedTheme.presentation.motifStyle])}</span>
                </div>
                {selectedTheme.showcase.enabled && selectedTheme.showcase.showCards ? (
                  <div className="theme-preview-showcase-cards">
                    {selectedTheme.showcase.cards.slice(0, 4).map((card, index) => {
                      const Icon = showcaseIconComponents[card.icon] ?? Code2
                      return (
                        <button type="button" key={`${card.icon}-${index}`}>
                          <i><Icon size={15} /></i>
                          <span>{t(card.title)}</span>
                        </button>
                      )
                    })}
                  </div>
                ) : null}
              </div>
              <div className="theme-preview-task-hint">
                <span>已有任务页</span>
                <strong>{t(taskModeLabels[selectedTheme.presentation.taskMode])}</strong>
                <i>{selectedTheme.presentation.taskMode === 'off' ? '0%' : `${selectedTheme.presentation.taskWallpaperOpacity}%`}</i>
              </div>
              <footer><span>输入消息或描述任务</span><button type="button"><Upload size={15} /></button></footer>
            </main>
          </div>
        </section>

        <section className="theme-controls-section">
          <div className="theme-section-heading">
            <div><strong>主题参数</strong><span>{selectedTheme.builtin ? '内置预设可编辑' : '自定义主题'}</span></div>
            {!selectedTheme.builtin ? <button className="danger" type="button" disabled={busy === 'delete'} onClick={() => void deleteSelected()}><Trash2 size={15} />删除</button> : null}
          </div>

          <div className="theme-name-fields">
            <label><span>主题名称</span><input value={language === 'en-US' && selectedTheme.builtin ? t(selectedTheme.name) : selectedTheme.name} maxLength={80} onChange={(event) => patchSelectedTheme({ name: event.target.value })} /></label>
            <label><span>主题说明</span><input value={language === 'en-US' && selectedTheme.builtin ? t(selectedTheme.description) : selectedTheme.description} maxLength={240} onChange={(event) => patchSelectedTheme({ description: event.target.value })} /></label>
          </div>

          <ThemeShowcaseEditor
            theme={selectedTheme}
            busy={busy}
            onPatch={patchShowcase}
            onPatchPresentation={patchPresentation}
            onPatchCard={patchShowcaseCard}
            onPickHero={() => showcaseHeroInput.current?.click()}
            onPickPortrait={() => showcasePortraitInput.current?.click()}
          />

          <div className="theme-color-grid">
            {colorFields.map(([key, label]) => (
              <label key={key}>
                <span>{label}</span>
                <div><input type="color" value={String(selectedTheme.visual[key])} onChange={(event) => patchVisual({ [key]: event.target.value })} /><code>{String(selectedTheme.visual[key])}</code></div>
              </label>
            ))}
          </div>

          <div className="theme-slider-list">
            {sliderFields.map(([key, label, min, max, suffix]) => (
              <label key={key}>
                <span>{label}<strong>{Number(selectedTheme.visual[key])}{suffix}</strong></span>
                <input type="range" min={min} max={max} value={Number(selectedTheme.visual[key])} onChange={(event) => patchVisual({ [key]: Number(event.target.value) })} />
              </label>
            ))}
          </div>

          <div className="theme-select-grid">
            <label><span>字体风格</span><select value={selectedTheme.visual.fontFamily} onChange={(event) => patchVisual({ fontFamily: event.target.value as ThemeVisual['fontFamily'] })}><option value="system">系统字体</option><option value="serif">衬线字体</option><option value="mono">等宽字体</option></select></label>
            <label><span>壁纸显示</span><select value={selectedTheme.visual.wallpaperFit} onChange={(event) => patchVisual({ wallpaperFit: event.target.value as ThemeVisual['wallpaperFit'] })}><option value="cover">填充</option><option value="contain">适应</option><option value="center">居中</option><option value="tile">平铺</option></select></label>
          </div>

          <div className="theme-wallpaper-row">
            <div><Image size={17} /><span><strong>主题壁纸</strong><small>{selectedTheme.wallpaperDataUrl ? '本地图片已载入' : '未设置壁纸'}</small></span></div>
            <button type="button" disabled={busy === 'wallpaper'} onClick={() => wallpaperInput.current?.click()}>{busy === 'wallpaper' ? <LoaderCircle className="spin" size={15} /> : <Image size={15} />}选择图片</button>
          </div>

          <div className="theme-primary-actions">
            <button className="primary" type="button" disabled={busy === 'save'} onClick={() => void save()}>{busy === 'save' ? <LoaderCircle className="spin" size={15} /> : <Save size={15} />}保存并应用</button>
            <button type="button" disabled={busy === 'reset'} onClick={() => void reset()}><RotateCcw size={15} />恢复默认</button>
          </div>
        </section>
      </div>

      <footer className="theme-studio-footer">
        <span><MonitorCog size={14} />配置：{result.settingsPath}</span>
        <span><CircleAlert size={14} />主题包仅允许声明文件和本地图片，不执行脚本。</span>
      </footer>

      <input ref={wallpaperInput} className="theme-hidden-input" type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => void handleWallpaper(event.target.files?.[0])} />
      <input ref={showcaseHeroInput} className="theme-hidden-input" type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => void handleShowcaseImage('hero', event.target.files?.[0])} />
      <input ref={showcasePortraitInput} className="theme-hidden-input" type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => void handleShowcaseImage('portrait', event.target.files?.[0])} />
      <input ref={packageInput} className="theme-hidden-input" type="file" accept=".zip,.cc-theme,application/zip" onChange={(event) => void handlePackage(event.target.files?.[0])} />
    </div>
  )
}
