import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { chromium } from 'playwright'

const repoRoot = path.resolve(import.meta.dirname, '..', '..')
const cssPath = path.join(
  repoRoot,
  'src-tauri',
  'codex-plus',
  'assets',
  'theme-studio',
  'concepts',
  'mint-paper.css',
)
const contractPath = path.join(
  repoRoot,
  'src-tauri',
  'codex-plus',
  'assets',
  'theme-studio',
  'concepts',
  'mint-paper.json',
)

const [css, contractText] = await Promise.all([
  readFile(cssPath, 'utf8'),
  readFile(contractPath, 'utf8'),
])
const contract = JSON.parse(contractText)

let browser
let page

before(async () => {
  browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
  })
  page = await context.newPage()
  await page.setContent(fixtureHtml(), { waitUntil: 'domcontentloaded' })
  await page.addStyleTag({ content: css })
})

after(async () => {
  await browser?.close()
})

test('concept contract records the wallpaper, native UI, appearance, and QA invariants', () => {
  assert.equal(contract.themeId, 'mint-paper')
  assert.equal(contract.displayName, '清透定制')
  assert.equal(contract.runtimeBinding.layoutStyle, 'paper')
  assert.equal(contract.runtimeBinding.cardStyle, 'paper')
  assert.equal(contract.runtimeBinding.appearance.requiredMode, 'light')
  assert.deepEqual(contract.runtimeBinding.appearance.runtimeAction, {
    type: 'app.appearance.set_mode',
    mode: 'light',
  })
  assert.equal(contract.wallpaperContract.subject.identityMode, 'original-fictional-adult')
  assert.equal(contract.wallpaperContract.subject.presentation, 'adult-male')
  assert.equal(contract.uiComposition.nativeUiOnly, true)
  assert.equal(contract.uiComposition.quickCards.requiredCount, 4)
  assert.equal(contract.uiComposition.quickCards.desktopColumns, 4)
  assert.equal(contract.uiComposition.quickCards.compactColumns, 2)
  assert.equal(contract.uiComposition.sidebar.scrollOwner, '[data-app-action-sidebar-scroll]')
  assert.equal(contract.uiComposition.sidebar.rowOverflow, 'clip')
  assert.equal(contract.scopeContract.mutationContract.includes('MutationObserver'), true)
  assert.equal(contract.scopeContract.eventContract.includes('不注册'), true)

  const decorationIds = contract.decorations.map((decoration) => decoration.id)
  assert.deepEqual(decorationIds, [
    'paper-fiber',
    'leaf-shadows',
    'paper-crane',
    'star-points',
    'stitched-brand-line',
    'composer-thread',
  ])

  for (const surface of ['设置', '菜单', '弹窗', '代码块', '图片预览']) {
    assert.ok(
      contract.qa.requiredAssertions.some((item) => item.includes(surface)),
      `QA contract did not cover ${surface}`,
    )
  }

  assert.doesNotMatch(
    contract.wallpaperContract.subject.identityMode,
    /celebrity|public-figure|private-person|licensed-identity/i,
  )
  assert.match(contract.wallpaperContract.subject.description, /原创虚构成年男性/)
})

test('every style rule is mint-paper scoped and excludes operation surfaces', async () => {
  const report = await page.evaluate(() => {
    const sheet = Array.from(document.styleSheets).at(-1)
    const selectors = []
    const visit = (rules) => {
      for (const rule of rules) {
        if (rule.type === CSSRule.STYLE_RULE) selectors.push(rule.selectorText)
        if ('cssRules' in rule) visit(rule.cssRules)
      }
    }
    visit(sheet.cssRules)
    return {
      selectors,
      styleRuleCount: selectors.length,
    }
  })

  assert.ok(report.styleRuleCount >= 70, `Expected a substantive slice, got ${report.styleRuleCount} rules`)
  for (const selectorText of report.selectors) {
    for (const selector of selectorText.split(',')) {
      assert.match(
        selector.trim(),
        /^html\[data-codex-compass-theme="mint-paper"\]/,
        `Unscoped selector: ${selectorText}`,
      )
    }
  }

  const forbiddenTargets = [
    '[role="dialog"]',
    '[role="menu"]',
    '[role="listbox"]',
    '[data-slot="dialog-content"]',
    '[data-slot="popover-content"]',
    '.monaco-editor',
    '[data-testid*="diff"]',
    '[data-testid*="terminal"]',
    '[aria-label="图片预览"]',
  ]
  for (const target of forbiddenTargets) {
    assert.equal(
      report.selectors.some((selector) => selector.includes(target)),
      false,
      `Concept CSS leaked into operation surface ${target}`,
    )
  }

  assert.match(css, /color-scheme:\s*light/)
  assert.match(css, /overflow-x:\s*clip\s*!important/)
  assert.match(css, /overflow-y:\s*clip\s*!important/)
  assert.match(css, /grid-template-columns:\s*repeat\(4,\s*minmax\(0,\s*1fr\)\)/)
  assert.match(css, /@media\s*\(max-width:\s*980px\)/)
  assert.match(css, /grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/)
})

test('desktop layout renders the brand bar, horizontal title, four real cards, sidebar, and native composer', async () => {
  await page.setViewportSize({ width: 1440, height: 900 })
  const metrics = await page.evaluate(() => {
    const root = document.documentElement
    const showcase = document.querySelector('.cc-theme-showcase')
    const title = document.querySelector('.cc-theme-showcase-title')
    const cards = document.querySelector('.cc-theme-showcase-cards')
    const cardNodes = Array.from(document.querySelectorAll('.cc-theme-showcase-card'))
    const sidebar = document.querySelector('.cc-theme-shell-sidebar')
    const sidebarScroll = document.querySelector('[data-app-action-sidebar-scroll]')
    const composer = document.querySelector('.cc-theme-shell-composer')
    const showcaseBox = showcase.getBoundingClientRect()
    const composerBox = composer.getBoundingClientRect()
    const motif = document.querySelector('.cc-theme-showcase-motif')
    const crane = getComputedStyle(motif, '::before')
    const stars = getComputedStyle(motif, '::after')
    const leafShadow = getComputedStyle(showcase, '::after')
    return {
      colorScheme: getComputedStyle(root).colorScheme,
      titleWhiteSpace: getComputedStyle(title).whiteSpace,
      titleTextWrap: getComputedStyle(title).textWrap,
      cardCount: cardNodes.length,
      cardsAreButtons: cardNodes.every((card) => card.tagName === 'BUTTON'),
      cardColumns: getComputedStyle(cards).gridTemplateColumns.split(' ').length,
      cardBackgrounds: cardNodes.map((card) => getComputedStyle(card).backgroundColor),
      cardsNoScroll: cardNodes.every((card) => {
        const style = getComputedStyle(card)
        card.scrollTop = 10
        return style.overflowX === 'clip'
          && style.overflowY === 'clip'
          && card.scrollTop === 0
          && card.offsetWidth - card.clientWidth <= 2
      }),
      sidebarBackground: getComputedStyle(sidebar).backgroundColor,
      sidebarScrollOwner: getComputedStyle(sidebarScroll).overflowY === 'auto',
      composerBackground: getComputedStyle(composer).backgroundColor,
      composerNative: composer.dataset.codexThemeNativeComposer === 'true',
      showcaseAboveComposer: showcaseBox.bottom <= composerBox.top + 1,
      noHorizontalOverflow: document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      craneVisible: crane.clipPath !== 'none' && Number.parseFloat(crane.opacity) > 0,
      starsVisible: stars.content !== 'none' && stars.content !== 'normal',
      leafShadowVisible: leafShadow.backgroundImage !== 'none',
      motifIgnoresPointer: getComputedStyle(motif).pointerEvents === 'none',
      brandPointerSafe: getComputedStyle(document.querySelector('.cc-theme-showcase-brandline')).pointerEvents === 'none',
    }
  })

  assert.equal(metrics.colorScheme, 'light')
  assert.equal(metrics.titleWhiteSpace, 'nowrap')
  assert.equal(metrics.titleTextWrap, 'nowrap')
  assert.equal(metrics.cardCount, 4)
  assert.equal(metrics.cardsAreButtons, true)
  assert.equal(metrics.cardColumns, 4)
  assert.equal(metrics.cardBackgrounds.every((color) => alphaOf(color) === 1), true)
  assert.equal(metrics.cardsNoScroll, true)
  assert.equal(alphaOf(metrics.sidebarBackground), 1)
  assert.equal(metrics.sidebarScrollOwner, true)
  assert.equal(alphaOf(metrics.composerBackground), 1)
  assert.equal(metrics.composerNative, true)
  assert.equal(metrics.showcaseAboveComposer, true)
  assert.equal(metrics.noHorizontalOverflow, true)
  assert.equal(metrics.craneVisible, true)
  assert.equal(metrics.starsVisible, true)
  assert.equal(metrics.leafShadowVisible, true)
  assert.equal(metrics.motifIgnoresPointer, true)
  assert.equal(metrics.brandPointerSafe, true)

  await page.locator('.cc-theme-showcase-card').first().click()
  assert.match(
    await page.locator('.cc-theme-shell-composer textarea').inputValue(),
    /阅读当前项目|关键结构/,
  )
  assert.equal(await page.evaluate(() => window.fixtureState.composerInputs), 1)
})

test('window controls retain the light-appearance contrast and native events', async () => {
  const controls = page.locator('.cc-theme-shell-window-control')
  assert.equal(await controls.count(), 3)
  const controlMetrics = await page.evaluate(() => {
    const header = document.querySelector('.cc-theme-shell-topbar')
    const background = getComputedStyle(header).backgroundColor
    return Array.from(document.querySelectorAll('.cc-theme-shell-window-control')).map((control) => {
      const style = getComputedStyle(control)
      return {
        label: control.getAttribute('aria-label'),
        color: style.color,
        background,
        opacity: style.opacity,
        pointerEvents: style.pointerEvents,
      }
    })
  })
  for (const control of controlMetrics) {
    const ratio = contrastRatio(control.color, control.background)
    assert.ok(ratio >= 7, `${control.label} contrast was ${ratio.toFixed(2)}`)
    assert.equal(control.opacity, '1')
    assert.equal(control.pointerEvents, 'auto')
  }

  for (const label of ['最小化', '最大化或还原', '关闭']) {
    await page.getByRole('button', { name: label, exact: true }).click()
  }
  assert.deepEqual(
    await page.evaluate(() => window.fixtureState.windowClicks),
    ['minimize', 'maximize', 'close'],
  )
})

test('sidebar rows have no internal scrollbars and wheel input reaches the main sidebar scroll owner', async () => {
  const metrics = await page.evaluate(() => {
    const scroll = document.querySelector('[data-app-action-sidebar-scroll]')
    const row = document.querySelector('.cc-theme-shell-project-row')
    scroll.scrollTop = 0
    row.scrollTop = 0
    const event = new WheelEvent('wheel', {
      bubbles: true,
      cancelable: true,
      deltaY: 180,
      deltaMode: WheelEvent.DOM_DELTA_PIXEL,
    })
    const defaultAllowed = row.dispatchEvent(event)
    const rowStyle = getComputedStyle(row)
    return {
      defaultAllowed,
      defaultPrevented: event.defaultPrevented,
      sidebarScrollTop: scroll.scrollTop,
      rowScrollTop: row.scrollTop,
      overflowX: rowStyle.overflowX,
      overflowY: rowStyle.overflowY,
      scrollbarThickness: row.offsetWidth - row.clientWidth,
    }
  })

  assert.equal(metrics.defaultAllowed, false)
  assert.equal(metrics.defaultPrevented, true)
  assert.ok(metrics.sidebarScrollTop > 0, JSON.stringify(metrics))
  assert.equal(metrics.rowScrollTop, 0)
  assert.equal(metrics.overflowX, 'clip')
  assert.equal(metrics.overflowY, 'clip')
  assert.ok(metrics.scrollbarThickness <= 2)
})

test('settings, menus, popovers, code, and image preview keep their native opaque operation surfaces', async () => {
  const metrics = await page.evaluate(() => {
    const selectors = [
      '#settings-dialog',
      '#model-menu',
      '#settings-listbox',
      '#attach-popover',
      '#code-block',
      '#diff-view',
      '#terminal-panel',
      '#monaco-editor',
      '#image-download',
      '#image-close',
    ]
    const surfaces = Object.fromEntries(selectors.map((selector) => {
      const element = document.querySelector(selector)
      const style = getComputedStyle(element)
      return [selector, {
        background: style.backgroundColor,
        pointerEvents: style.pointerEvents,
        backdropFilter: style.backdropFilter,
      }]
    }))
    const preview = document.querySelector('#image-preview')
    const previewStyle = getComputedStyle(preview)
    return {
      surfaces,
      previewBackground: previewStyle.backgroundColor,
      previewPosition: previewStyle.position,
      previewWidth: Math.round(preview.getBoundingClientRect().width),
      previewHeight: Math.round(preview.getBoundingClientRect().height),
      downloadTag: document.querySelector('#image-download').tagName,
    }
  })

  for (const [selector, surface] of Object.entries(metrics.surfaces)) {
    assert.equal(alphaOf(surface.background), 1, `${selector} became transparent`)
    assert.equal(surface.pointerEvents, 'auto', `${selector} lost pointer events`)
    assert.equal(surface.backdropFilter, 'none', `${selector} gained a backdrop filter`)
  }
  assert.equal(alphaOf(metrics.previewBackground), 0)
  assert.equal(metrics.previewPosition, 'fixed')
  assert.equal(metrics.previewWidth, 1440)
  assert.equal(metrics.previewHeight, 900)
  assert.equal(metrics.downloadTag, 'A')

  await page.getByRole('button', { name: '确认设置' }).click()
  await page.getByRole('menuitem', { name: '模型选项' }).click()
  await page.getByRole('option', { name: '工作区' }).click()
  await page.getByRole('button', { name: '选择文件' }).click()
  await page.getByRole('button', { name: '关闭图片预览' }).click()
  assert.deepEqual(await page.evaluate(() => window.fixtureState.operationClicks), [
    'settings',
    'menu',
    'listbox',
    'popover',
    'image-close',
  ])
})

test('compact layout uses a stable 2x2 card grid without title or composer overlap', async () => {
  await page.setViewportSize({ width: 900, height: 820 })
  const metrics = await page.evaluate(() => {
    const showcase = document.querySelector('.cc-theme-showcase')
    const composer = document.querySelector('.cc-theme-shell-composer')
    const card = document.querySelector('.cc-theme-showcase-card')
    return {
      titleWhiteSpace: getComputedStyle(document.querySelector('.cc-theme-showcase-title')).whiteSpace,
      cardColumns: getComputedStyle(document.querySelector('.cc-theme-showcase-cards'))
        .gridTemplateColumns
        .split(' ')
        .length,
      cardOverflowX: getComputedStyle(card).overflowX,
      cardOverflowY: getComputedStyle(card).overflowY,
      noHorizontalOverflow: document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      noComposerOverlap: showcase.getBoundingClientRect().bottom <= composer.getBoundingClientRect().top + 1,
    }
  })

  assert.deepEqual(metrics, {
    titleWhiteSpace: 'normal',
    cardColumns: 2,
    cardOverflowX: 'clip',
    cardOverflowY: 'clip',
    noHorizontalOverflow: true,
    noComposerOverlap: true,
  })
})

function fixtureHtml() {
  const card = (index, title, prompt) => `
    <button type="button" class="cc-theme-showcase-card" data-prompt="${prompt}">
      <span class="cc-theme-showcase-card-icon" aria-hidden="true">
        <svg viewBox="0 0 24 24"><path d="M5 12h14M12 5v14"></path></svg>
      </span>
      <span class="cc-theme-showcase-card-copy">
        <span class="cc-theme-showcase-card-label">${title}</span>
        <span class="cc-theme-showcase-card-description">${prompt}</span>
      </span>
      <span class="cc-theme-showcase-card-arrow" aria-hidden="true">→</span>
      <span class="cc-theme-showcase-card-index">${String(index).padStart(2, '0')}</span>
    </button>`

  return `<!doctype html>
<html
  lang="zh-CN"
  data-codex-compass-theme="mint-paper"
  data-codex-compass-theme-page="home"
  data-codex-compass-showcase="mint-paper"
  data-codex-compass-layout="paper"
>
<head>
  <meta charset="utf-8">
  <title>Mint Paper Concept QA</title>
  <style>
    * { box-sizing: border-box; }
    html, body { width: 100%; min-height: 100%; margin: 0; color: #303326; background: #f7f5eb; }
    body { min-height: 100vh; font: 14px/1.5 "Microsoft YaHei", sans-serif; overflow-x: hidden; }
    button, input, textarea { font: inherit; }
    button { cursor: pointer; }
    .app-header-tint {
      position: fixed;
      z-index: 50;
      inset: 0 0 auto 0;
      height: 44px;
      display: flex;
      align-items: center;
      padding-left: 18px;
      border-bottom: 1px solid #d8d8c3;
      background: #fffdf8;
    }
    .window-controls { margin-left: auto; height: 100%; display: flex; }
    .cc-theme-shell-window-control {
      width: 28px;
      min-width: 28px;
      height: 100%;
      padding: 0;
      display: grid;
      place-items: center;
      color: #303326;
      border: 0;
      background: transparent;
    }
    #app-shell {
      min-height: 100vh;
      padding-top: 44px;
      display: grid;
      grid-template-columns: minmax(220px, 260px) minmax(0, 1fr);
    }
    .cc-theme-shell-sidebar {
      position: fixed;
      z-index: 20;
      top: 44px;
      bottom: 0;
      left: 0;
      width: clamp(220px, 18vw, 260px);
      padding: 10px;
      display: grid;
      grid-template-rows: auto auto minmax(0, 1fr) auto;
      overflow: hidden;
      background: #fbf9ef;
    }
    .cc-theme-shell-product-button,
    .cc-theme-shell-search-button,
    .cc-theme-shell-new-task,
    .cc-theme-shell-account-row {
      position: relative;
      width: 100%;
      min-height: 38px;
      border: 1px solid #d8d8c3;
      background: #fffdf7;
    }
    .sidebar-actions { display: grid; grid-template-columns: minmax(0, 1fr) 38px; gap: 6px; }
    [data-app-action-sidebar-scroll] {
      min-height: 0;
      height: 100%;
      padding: 6px 0;
      display: flex;
      flex-direction: column;
      gap: 3px;
      overflow-y: auto;
    }
    .cc-theme-shell-group-heading { margin-top: 6px; padding: 8px 6px 2px; }
    .cc-theme-shell-project-row,
    .cc-theme-shell-thread-row {
      width: 100%;
      min-height: 34px;
    }
    .cc-theme-shell-project-row button,
    .cc-theme-shell-thread-row button {
      width: 100%;
      min-height: 34px;
      border: 0;
      background: transparent;
      text-align: left;
    }
    .sidebar-spacer { flex: 0 0 720px; }
    #workspace {
      grid-column: 2;
      min-width: 0;
      padding: 24px;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 18px;
    }
    .cc-theme-showcase-host {
      width: min(100%, 1120px);
      min-width: 0;
    }
    .cc-theme-showcase {
      position: relative;
      isolation: isolate;
      width: 100%;
      display: grid;
      background-image:
        linear-gradient(90deg, transparent 0 56%, rgb(247 245 235 / 10%) 72%),
        radial-gradient(circle at 80% 36%, #d9d7c4 0 12%, transparent 13%),
        linear-gradient(120deg, #f7f5eb, #e8e5d6);
      background-size: cover;
    }
    .cc-theme-showcase::before,
    .cc-theme-showcase::after,
    .cc-theme-shell-sidebar::before,
    .cc-theme-shell-sidebar::after {
      content: "";
      position: absolute;
      z-index: -1;
      pointer-events: none;
    }
    .cc-theme-showcase-copy { position: relative; z-index: 2; }
    .cc-theme-showcase-eyebrow { display: block; }
    .cc-theme-showcase-title,
    .cc-theme-showcase-subtitle { margin: 0; }
    .cc-theme-showcase-brandline {
      position: absolute;
      z-index: 4;
      display: flex;
      align-items: center;
    }
    .cc-theme-showcase-brandmark { display: grid; place-items: center; }
    .cc-theme-showcase-brandcopy { display: grid; }
    .cc-theme-showcase-status { margin-left: auto; }
    .cc-theme-showcase-motif,
    .cc-theme-showcase-companion { position: absolute; z-index: 2; pointer-events: none; }
    .cc-theme-showcase-cards { position: relative; z-index: 3; display: grid; }
    .cc-theme-showcase-card { position: relative; display: grid; }
    .cc-theme-showcase-card-icon { display: grid; place-items: center; border-radius: 50%; }
    .cc-theme-showcase-card-icon svg { fill: none; stroke: currentColor; }
    .cc-theme-showcase-card-index,
    .cc-theme-showcase-card-arrow { position: absolute; }
    .cc-theme-shell-composer {
      width: min(100%, 1080px);
      min-height: 116px;
      padding: 18px;
      display: grid;
      grid-template-columns: auto minmax(0, 1fr) auto auto;
      align-items: end;
      gap: 10px;
      border: 1px solid #d8d8c3;
      background: #fffdf8;
    }
    .cc-theme-shell-composer::before,
    .cc-theme-shell-composer::after {
      content: "";
      position: absolute;
      z-index: 0;
      pointer-events: none;
    }
    .cc-theme-shell-composer textarea {
      min-width: 0;
      min-height: 68px;
      resize: none;
      border: 0;
      background: transparent;
    }
    .cc-theme-shell-composer button { position: relative; z-index: 2; min-height: 32px; }
    #operation-fixtures {
      position: fixed;
      z-index: 200;
      inset: 72px 24px auto auto;
      display: grid;
      gap: 8px;
      pointer-events: none;
    }
    #settings-dialog,
    #model-menu,
    #settings-listbox,
    #attach-popover,
    #code-block,
    #diff-view,
    #terminal-panel,
    #monaco-editor,
    #image-download,
    #image-close {
      color: #20231a;
      border: 1px solid #bfc2ad;
      background-color: #fffef9;
      backdrop-filter: none;
      pointer-events: auto;
    }
    #settings-dialog,
    #model-menu,
    #settings-listbox,
    #attach-popover { padding: 8px; }
    #code-block,
    #diff-view,
    #terminal-panel,
    #monaco-editor { width: 180px; min-height: 34px; padding: 6px; }
    #image-preview {
      position: fixed;
      z-index: 300;
      inset: 0;
      width: 100vw;
      height: 100vh;
      pointer-events: none;
      background: transparent;
    }
    .preview-actions {
      position: absolute;
      top: 86px;
      right: 24px;
      display: flex;
      gap: 8px;
      pointer-events: auto;
    }
    #image-download,
    #image-close {
      width: 40px;
      height: 40px;
      padding: 0;
      display: grid;
      place-items: center;
      text-decoration: none;
    }
    @media (max-width: 980px) {
      #app-shell { grid-template-columns: 220px minmax(0, 1fr); }
      .cc-theme-shell-sidebar { width: 220px; }
      #workspace { padding: 14px; }
    }
  </style>
</head>
<body>
  <header class="app-header-tint cc-theme-shell-topbar">
    <span>Codex</span>
    <div class="window-controls">
      <button class="cc-theme-shell-window-control cc-theme-shell-window-minimize" data-window-action="minimize" aria-label="最小化">−</button>
      <button class="cc-theme-shell-window-control cc-theme-shell-window-maximize" data-window-action="maximize" aria-label="最大化或还原">□</button>
      <button class="cc-theme-shell-window-control cc-theme-shell-window-close" data-window-action="close" aria-label="关闭">×</button>
    </div>
  </header>
  <div id="app-shell">
    <aside class="cc-theme-shell-sidebar">
      <button class="cc-theme-shell-product-button" data-cc-theme-mark="叶" data-cc-theme-label="清透定制">Codex</button>
      <div class="sidebar-actions">
        <button class="cc-theme-shell-new-task">新建任务</button>
        <button class="cc-theme-shell-search-button" aria-label="搜索">⌕</button>
      </div>
      <div data-app-action-sidebar-scroll>
        <div class="cc-theme-shell-group-heading">项目</div>
        <div class="cc-theme-shell-project-row"><button>清透主题项目</button></div>
        <div class="cc-theme-shell-thread-row cc-theme-shell-active-row"><button>整理主题细节</button></div>
        <div class="cc-theme-shell-thread-row"><button>检查设置界面</button></div>
        <div class="cc-theme-shell-thread-row"><button>验证图片预览</button></div>
        <div class="cc-theme-shell-group-heading">任务</div>
        <div class="cc-theme-shell-thread-row"><button>审查作用域</button></div>
        <div class="cc-theme-shell-thread-row"><button>测试响应式布局</button></div>
        <div class="sidebar-spacer" aria-hidden="true"></div>
      </div>
      <button class="cc-theme-shell-account-row">本地账户</button>
    </aside>
    <main id="workspace">
      <div class="cc-theme-showcase-host">
        <section class="cc-theme-showcase theme-mint-paper layout-paper cards-paper" aria-label="清透定制">
          <div class="cc-theme-showcase-brandline" aria-hidden="true">
            <span class="cc-theme-showcase-brandmark">叶</span>
            <span class="cc-theme-showcase-brandcopy">
              <span class="cc-theme-showcase-brandname">橄榄纸张</span>
              <span class="cc-theme-showcase-brandmeta">清透定制 · Codex Compass</span>
            </span>
            <span class="cc-theme-showcase-status">纸笺限定</span>
          </div>
          <div class="cc-theme-showcase-copy">
            <span class="cc-theme-showcase-eyebrow">暖白手工纸 · 鼠尾草叶影</span>
            <h1 class="cc-theme-showcase-title">我们该构建什么？</h1>
            <p class="cc-theme-showcase-subtitle">在安静的纸张与叶影中整理思路。</p>
            <span class="cc-theme-showcase-badge">PAPER EDITION</span>
          </div>
          <div class="cc-theme-showcase-motif" data-codex-theme-decoration="leaves" aria-hidden="true"></div>
          <div class="cc-theme-showcase-companion" aria-hidden="true">
            <span class="cc-theme-showcase-companion-mark">叶</span>
            <span class="cc-theme-showcase-companion-label">清透定制</span>
          </div>
          <div class="cc-theme-showcase-cards">
            ${card(1, '探索并理解代码', '请先阅读当前项目，解释关键结构，并指出最值得从哪里开始。')}
            ${card(2, '构建新功能、应用或工具', '请根据当前项目实现一个完整的新功能。')}
            ${card(3, '审查代码并提出修改建议', '请审查当前项目的代码并给出可执行建议。')}
            ${card(4, '修复问题和失败', '请诊断问题，定位根因并实施修复。')}
          </div>
        </section>
      </div>
      <div class="cc-theme-showcase-composer cc-theme-shell-composer" data-codex-theme-native-composer="true">
        <button class="cc-theme-shell-attach-button" aria-label="添加文件">+</button>
        <textarea aria-label="任务输入" placeholder="写下今天的任务"></textarea>
        <button class="cc-theme-shell-model-button" aria-label="选择模型">模型</button>
        <button class="cc-theme-shell-send-button" aria-label="发送">↑</button>
      </div>
    </main>
  </div>
  <div id="operation-fixtures">
    <section id="settings-dialog" role="dialog" aria-label="Codex 设置">
      <button type="button" aria-label="确认设置">确认设置</button>
    </section>
    <div id="model-menu" role="menu"><button role="menuitem">模型选项</button></div>
    <div id="settings-listbox" role="listbox"><button role="option">工作区</button></div>
    <div id="attach-popover" data-slot="popover-content"><button type="button">选择文件</button></div>
    <pre id="code-block"><code>const paper = true</code></pre>
    <div id="diff-view" data-testid="diff-view">+ scoped theme</div>
    <div id="terminal-panel" data-testid="terminal-panel">tests passed</div>
    <div id="monaco-editor" class="monaco-editor">const readable = true</div>
  </div>
  <div id="image-preview" role="dialog" aria-label="图片预览">
    <div class="preview-actions">
      <a id="image-download" download="preview.png" aria-label="下载图片">↓</a>
      <button id="image-close" type="button" aria-label="关闭图片预览">×</button>
    </div>
  </div>
  <script>
    window.fixtureState = {
      composerInputs: 0,
      windowClicks: [],
      operationClicks: [],
    };
    const composer = document.querySelector('.cc-theme-shell-composer textarea');
    document.querySelectorAll('.cc-theme-showcase-card').forEach((card) => {
      card.addEventListener('click', () => {
        composer.value = card.dataset.prompt;
        composer.dispatchEvent(new Event('input', { bubbles: true }));
      });
    });
    composer.addEventListener('input', () => {
      window.fixtureState.composerInputs += 1;
    });
    document.querySelectorAll('[data-window-action]').forEach((button) => {
      button.addEventListener('click', () => {
        window.fixtureState.windowClicks.push(button.dataset.windowAction);
      });
    });
    document.querySelector('button[aria-label="确认设置"]').addEventListener('click', () => {
      window.fixtureState.operationClicks.push('settings');
    });
    document.querySelector('[role="menuitem"]').addEventListener('click', () => {
      window.fixtureState.operationClicks.push('menu');
    });
    document.querySelector('[role="option"]').addEventListener('click', () => {
      window.fixtureState.operationClicks.push('listbox');
    });
    document.querySelector('#attach-popover button').addEventListener('click', () => {
      window.fixtureState.operationClicks.push('popover');
    });
    document.querySelector('#image-close').addEventListener('click', () => {
      window.fixtureState.operationClicks.push('image-close');
    });
    document.addEventListener('wheel', (event) => {
      if (event.defaultPrevented || event.ctrlKey || !(event.target instanceof Element)) return;
      const row = event.target.closest('.cc-theme-shell-project-row,.cc-theme-shell-thread-row');
      if (!(row instanceof HTMLElement)) return;
      const scroll = row.closest('[data-app-action-sidebar-scroll]');
      if (!(scroll instanceof HTMLElement) || scroll.scrollHeight <= scroll.clientHeight) return;
      const multiplier = event.deltaMode === WheelEvent.DOM_DELTA_LINE
        ? 16
        : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
          ? scroll.clientHeight
          : 1;
      const previousTop = scroll.scrollTop;
      scroll.scrollTop += event.deltaY * multiplier;
      if (scroll.scrollTop !== previousTop) event.preventDefault();
    }, { capture: true, passive: false });
  </script>
</body>
</html>`
}

function rgba(value) {
  const text = String(value)
  const rgb = text.match(/rgba?\(([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[/,]\s*([\d.]+))?\)/i)
  if (rgb) {
    return {
      r: Number(rgb[1]),
      g: Number(rgb[2]),
      b: Number(rgb[3]),
      a: rgb[4] === undefined ? 1 : Number(rgb[4]),
    }
  }
  const srgb = text.match(/color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+))?\)/i)
  assert.ok(srgb, `Unsupported color: ${value}`)
  return {
    r: Number(srgb[1]) * 255,
    g: Number(srgb[2]) * 255,
    b: Number(srgb[3]) * 255,
    a: srgb[4] === undefined ? 1 : Number(srgb[4]),
  }
}

function alphaOf(value) {
  return rgba(value).a
}

function contrastRatio(foreground, background) {
  const fg = rgba(foreground)
  const bg = rgba(background)
  const blend = fg.a >= 1
    ? fg
    : {
        r: fg.r * fg.a + bg.r * (1 - fg.a),
        g: fg.g * fg.a + bg.g * (1 - fg.a),
        b: fg.b * fg.a + bg.b * (1 - fg.a),
      }
  const luminance = (color) => {
    const channel = (value) => {
      const normalized = value / 255
      return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4
    }
    return 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b)
  }
  const first = luminance(blend)
  const second = luminance(bg)
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05)
}
