import type { CommandResult } from '../types'

export type ThemeVisual = {
  accent: string
  accentSoft: string
  background: string
  surface: string
  surfaceAlt: string
  text: string
  textMuted: string
  border: string
  sidebarOpacity: number
  contentOpacity: number
  wallpaperOpacity: number
  blurPx: number
  radiusPx: number
  fontScale: number
  fontFamily: 'system' | 'serif' | 'mono'
  wallpaperFit: 'cover' | 'contain' | 'center' | 'tile'
}

export type ThemeShowcaseCardIcon = 'code' | 'build' | 'review' | 'repair'

export type ThemeShowcaseCard = {
  title: string
  prompt: string
  icon: ThemeShowcaseCardIcon
}

export type ThemeShowcase = {
  enabled: boolean
  eyebrow: string
  title: string
  subtitle: string
  heroImageDataUrl: string
  portraitImageDataUrl: string
  showCards: boolean
  cards: ThemeShowcaseCard[]
}

export type ThemePresentation = {
  layoutStyle: 'editorial' | 'fortune' | 'future' | 'paper' | 'doodle' | 'cosmic' | 'idol' | 'stage'
  cardStyle: 'glass' | 'paper' | 'solid' | 'outline'
  motifStyle: 'roses' | 'coins' | 'orbit' | 'leaves' | 'doodles' | 'butterflies' | 'stars' | 'jasmine'
  headerBadge: string
  heroPosition: 'center' | 'right' | 'far-right'
  overlayStrength: number
  taskWallpaperOpacity: number
  taskMode: 'ambient' | 'banner' | 'off'
}

export type ThemeDefinition = {
  id: string
  name: string
  description: string
  author: string
  version: string
  license: string
  builtin: boolean
  decorativeStyle: 'botanical' | 'leaves' | 'constellation' | 'manuscript' | 'none'
  wallpaperDataUrl: string
  showcase: ThemeShowcase
  presentation: ThemePresentation
  visual: ThemeVisual
}

export type ThemeStudioSettings = {
  schemaVersion: number
  enabled: boolean
  selectedThemeId: string
  themes: ThemeDefinition[]
  updatedAt: string
}

export type ThemeStudioResult = CommandResult<{
  settings: ThemeStudioSettings
  settingsPath: string
  packageFormat: string
  runtimeConnected: boolean
  runtimeStatus: string
  debugPort: number
}>
