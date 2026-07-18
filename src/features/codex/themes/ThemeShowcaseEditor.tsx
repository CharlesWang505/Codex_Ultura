import {
  Blocks,
  Code2,
  ImagePlus,
  LayoutTemplate,
  ListChecks,
  SlidersHorizontal,
  UserRound,
  Wrench,
  X,
} from 'lucide-react'
import { useLanguage } from '../../../lib/i18n'
import type {
  ThemeDefinition,
  ThemePresentation,
  ThemeShowcase,
  ThemeShowcaseCard,
  ThemeShowcaseCardIcon,
} from './types'

type ThemeShowcaseEditorProps = {
  theme: ThemeDefinition
  busy: string
  onPatch: (patch: Partial<ThemeShowcase>) => void
  onPatchPresentation: (patch: Partial<ThemePresentation>) => void
  onPatchCard: (index: number, patch: Partial<ThemeShowcaseCard>) => void
  onPickHero: () => void
  onPickPortrait: () => void
}

const iconOptions: Array<{
  value: ThemeShowcaseCardIcon
  label: string
  Icon: typeof Code2
}> = [
  { value: 'code', label: '理解代码', Icon: Code2 },
  { value: 'build', label: '构建功能', Icon: Blocks },
  { value: 'review', label: '代码审查', Icon: ListChecks },
  { value: 'repair', label: '修复问题', Icon: Wrench },
]

const layoutOptions: Array<{ value: ThemePresentation['layoutStyle']; label: string }> = [
  { value: 'editorial', label: '人物杂志' },
  { value: 'fortune', label: '财神工作台' },
  { value: 'future', label: '未来城市' },
  { value: 'paper', label: '纸张手记' },
  { value: 'doodle', label: '彩色涂鸦' },
  { value: 'cosmic', label: '宇宙星光' },
  { value: 'idol', label: '偶像舞台' },
  { value: 'stage', label: '黑金舞台' },
]

const cardStyleOptions: Array<{ value: ThemePresentation['cardStyle']; label: string }> = [
  { value: 'glass', label: '玻璃卡片' },
  { value: 'paper', label: '纸张卡片' },
  { value: 'solid', label: '实色卡片' },
  { value: 'outline', label: '描边卡片' },
]

const motifOptions: Array<{ value: ThemePresentation['motifStyle']; label: string }> = [
  { value: 'roses', label: '玫瑰' },
  { value: 'coins', label: '金币' },
  { value: 'orbit', label: '轨道' },
  { value: 'leaves', label: '叶片' },
  { value: 'doodles', label: '涂鸦' },
  { value: 'butterflies', label: '蝴蝶' },
  { value: 'stars', label: '星光' },
  { value: 'jasmine', label: '茉莉' },
]

const heroPositionOptions: Array<{ value: ThemePresentation['heroPosition']; label: string }> = [
  { value: 'center', label: '居中' },
  { value: 'right', label: '偏右' },
  { value: 'far-right', label: '最右侧' },
]

const taskModeOptions: Array<{ value: ThemePresentation['taskMode']; label: string }> = [
  { value: 'ambient', label: '环境背景' },
  { value: 'banner', label: '顶部横幅' },
  { value: 'off', label: '任务页关闭' },
]

export function ThemeShowcaseEditor({
  theme,
  busy,
  onPatch,
  onPatchPresentation,
  onPatchCard,
  onPickHero,
  onPickPortrait,
}: ThemeShowcaseEditorProps) {
  const { t } = useLanguage()
  const showcase = theme.showcase
  const presentation = theme.presentation
  const displayText = (value: string) => theme.builtin ? t(value) : value

  return (
    <section className="theme-showcase-controls" aria-label={t('首页展示')}>
      <div className="theme-showcase-heading">
        <div>
          <LayoutTemplate size={16} />
          <span>
            <strong>{t('首页展示')}</strong>
            <small>{t('只在 Codex 新任务首页显示')}</small>
          </span>
        </div>
        <label className="theme-showcase-switch">
          <input
            type="checkbox"
            checked={showcase.enabled}
            onChange={(event) => onPatch({ enabled: event.target.checked })}
          />
          <span aria-hidden="true" />
        </label>
      </div>

      <div className="theme-showcase-copy-fields">
        <label>
          <span>{t('品牌文字')}</span>
          <input
            value={displayText(showcase.eyebrow)}
            maxLength={80}
            onChange={(event) => onPatch({ eyebrow: event.target.value })}
          />
        </label>
        <label>
          <span>{t('首页标题')}</span>
          <input
            value={displayText(showcase.title)}
            maxLength={80}
            onChange={(event) => onPatch({ title: event.target.value })}
          />
        </label>
        <label className="wide">
          <span>{t('首页副标题')}</span>
          <input
            value={displayText(showcase.subtitle)}
            maxLength={180}
            onChange={(event) => onPatch({ subtitle: event.target.value })}
          />
        </label>
      </div>

      <div className="theme-presentation-editor">
        <div className="theme-presentation-heading">
          <SlidersHorizontal size={15} />
          <span>
            <strong>{t('展示布局')}</strong>
            <small>{t('控制首页构图、卡片质感和任务页降噪')}</small>
          </span>
        </div>
        <div className="theme-presentation-selects">
          <label>
            <span>{t('布局风格')}</span>
            <select
              value={presentation.layoutStyle}
              onChange={(event) => onPatchPresentation({
                layoutStyle: event.target.value as ThemePresentation['layoutStyle'],
              })}
            >
              {layoutOptions.map((option) => <option key={option.value} value={option.value}>{t(option.label)}</option>)}
            </select>
          </label>
          <label>
            <span>{t('卡片风格')}</span>
            <select
              value={presentation.cardStyle}
              onChange={(event) => onPatchPresentation({
                cardStyle: event.target.value as ThemePresentation['cardStyle'],
              })}
            >
              {cardStyleOptions.map((option) => <option key={option.value} value={option.value}>{t(option.label)}</option>)}
            </select>
          </label>
          <label>
            <span>{t('主题标志')}</span>
            <select
              value={presentation.motifStyle}
              onChange={(event) => onPatchPresentation({
                motifStyle: event.target.value as ThemePresentation['motifStyle'],
              })}
            >
              {motifOptions.map((option) => <option key={option.value} value={option.value}>{t(option.label)}</option>)}
            </select>
          </label>
          <label>
            <span>{t('主视觉位置')}</span>
            <select
              value={presentation.heroPosition}
              onChange={(event) => onPatchPresentation({
                heroPosition: event.target.value as ThemePresentation['heroPosition'],
              })}
            >
              {heroPositionOptions.map((option) => <option key={option.value} value={option.value}>{t(option.label)}</option>)}
            </select>
          </label>
          <label>
            <span>{t('任务页模式')}</span>
            <select
              value={presentation.taskMode}
              onChange={(event) => onPatchPresentation({
                taskMode: event.target.value as ThemePresentation['taskMode'],
              })}
            >
              {taskModeOptions.map((option) => <option key={option.value} value={option.value}>{t(option.label)}</option>)}
            </select>
          </label>
          <label>
            <span>{t('标题徽标')}</span>
            <input
              value={presentation.headerBadge}
              maxLength={40}
              placeholder={t('例如：限定主题')}
              onChange={(event) => onPatchPresentation({ headerBadge: event.target.value })}
            />
          </label>
        </div>
        <div className="theme-presentation-sliders">
          <label>
            <span>{t('首页遮罩')}<strong>{presentation.overlayStrength}%</strong></span>
            <input
              type="range"
              min="40"
              max="96"
              value={presentation.overlayStrength}
              onChange={(event) => onPatchPresentation({ overlayStrength: Number(event.target.value) })}
            />
          </label>
          <label>
            <span>{t('任务页壁纸')}<strong>{presentation.taskMode === 'off' ? t('关闭') : `${presentation.taskWallpaperOpacity}%`}</strong></span>
            <input
              type="range"
              min="0"
              max="28"
              disabled={presentation.taskMode === 'off'}
              value={presentation.taskWallpaperOpacity}
              onChange={(event) => onPatchPresentation({ taskWallpaperOpacity: Number(event.target.value) })}
            />
          </label>
        </div>
      </div>

      <div className="theme-showcase-image-grid">
        <div>
          <ImagePlus size={17} />
          <span>
            <strong>{t('展示横幅')}</strong>
            <small>{showcase.heroImageDataUrl ? t('本地图片已载入') : t('默认使用主题壁纸')}</small>
          </span>
          {showcase.heroImageDataUrl ? (
            <button
              type="button"
              title={t('移除展示横幅')}
              aria-label={t('移除展示横幅')}
              onClick={() => onPatch({ heroImageDataUrl: '' })}
            >
              <X size={14} />
            </button>
          ) : null}
          <button type="button" disabled={busy === 'showcase-hero'} onClick={onPickHero}>
            <ImagePlus size={14} />{t('选择图片')}
          </button>
        </div>
        <div>
          <UserRound size={17} />
          <span>
            <strong>{t('右侧人物或装饰')}</strong>
            <small>{showcase.portraitImageDataUrl ? t('本地图片已载入') : t('可选，不设置也能使用')}</small>
          </span>
          {showcase.portraitImageDataUrl ? (
            <button
              type="button"
              title={t('移除右侧图片')}
              aria-label={t('移除右侧图片')}
              onClick={() => onPatch({ portraitImageDataUrl: '' })}
            >
              <X size={14} />
            </button>
          ) : null}
          <button type="button" disabled={busy === 'showcase-portrait'} onClick={onPickPortrait}>
            <UserRound size={14} />{t('选择图片')}
          </button>
        </div>
      </div>

      <div className="theme-showcase-card-heading">
        <span>
          <strong>{t('快捷任务')}</strong>
          <small>{t('点击后只填入输入框，不会自动发送')}</small>
        </span>
        <label>
          <input
            type="checkbox"
            checked={showcase.showCards}
            onChange={(event) => onPatch({ showCards: event.target.checked })}
          />
          {t('显示四张快捷卡')}
        </label>
      </div>

      {showcase.showCards ? (
        <div className="theme-showcase-card-list">
          {showcase.cards.slice(0, 4).map((card, index) => {
            const selectedIcon = iconOptions.find((option) => option.value === card.icon) ?? iconOptions[0]
            const Icon = selectedIcon.Icon
            return (
              <article key={`${card.icon}-${index}`}>
                <div className="theme-showcase-card-index">
                  <Icon size={16} />
                  <strong>{t('快捷任务')} {index + 1}</strong>
                </div>
                <label>
                  <span>{t('卡片标题')}</span>
                  <input
                    value={displayText(card.title)}
                    maxLength={48}
                    onChange={(event) => onPatchCard(index, { title: event.target.value })}
                  />
                </label>
                <label>
                  <span>{t('图标')}</span>
                  <select
                    value={card.icon}
                    onChange={(event) => onPatchCard(index, {
                      icon: event.target.value as ThemeShowcaseCardIcon,
                    })}
                  >
                    {iconOptions.map((option) => (
                      <option key={option.value} value={option.value}>{t(option.label)}</option>
                    ))}
                  </select>
                </label>
                <label className="prompt">
                  <span>{t('填入输入框的提示词')}</span>
                  <textarea
                    value={displayText(card.prompt)}
                    maxLength={800}
                    rows={3}
                    onChange={(event) => onPatchCard(index, { prompt: event.target.value })}
                  />
                </label>
              </article>
            )
          })}
        </div>
      ) : null}
    </section>
  )
}
