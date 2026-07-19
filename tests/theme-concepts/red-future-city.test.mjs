import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { mkdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { chromium } from 'playwright'

const repoRoot = path.resolve(import.meta.dirname, '..', '..')
const conceptDir = path.join(
  repoRoot,
  'src-tauri',
  'codex-plus',
  'assets',
  'theme-studio',
  'concepts',
)
const cssPath = path.join(conceptDir, 'red-future-city.css')
const jsonPath = path.join(conceptDir, 'red-future-city.json')
const wallpaperPath = path.join(conceptDir, '..', 'red-future-city-wallpaper.webp')
const rootSelector = 'html[data-codex-compass-theme="red-future-city"]'
const screenshotDir = path.join(tmpdir(), 'codex-compass-red-future-city-qa')

const [css, contract, wallpaper] = await Promise.all([
  readFile(cssPath, 'utf8'),
  readFile(jsonPath, 'utf8').then(JSON.parse),
  readFile(wallpaperPath),
])

let browser

before(async () => {
  await mkdir(screenshotDir, { recursive: true })
  browser = await chromium.launch({ headless: true })
})

after(async () => {
  await browser?.close()
})

test('contract captures final copy, palette, layout, and acceptance requirements', () => {
  assert.equal(contract.schemaVersion, 1)
  assert.equal(contract.id, 'red-future-city')
  assert.equal(contract.appearance.mode, 'light')
  assert.equal(contract.appearance.codexAppearance, 'light')
  assert.equal(contract.appearance.windowsControls, 'native')
  assert.equal(contract.appearance.windowControlStrategy, 'appearance-sync-only')
  assert.equal(contract.assets.containsUi, false)
  assert.equal(contract.assets.wallpaper, '../red-future-city-wallpaper.webp')
  assert.equal(contract.copy.title.plainText, 'OpenAI 是人民的 AI。')
  assert.deepEqual(
    contract.copy.title.segments.map(({ text, accent }) => [text, accent]),
    [['OpenAI 是', false], ['人民', true], ['的 AI。', false]],
  )
  assert.deepEqual(
    contract.copy.cards.map(({ title, description }) => [title, description]),
    [
      ['构建', '编写代码与应用'],
      ['分析', '数据分析与洞察'],
      ['自动化', '智能体与工作流'],
      ['调试', '修复问题与优化'],
    ],
  )
  assert.equal(contract.layout.desktop.cardColumns, 4)
  assert.equal(contract.layout.compact.cardColumns, 2)
  assert.equal(contract.layout.small.showEnergyCore, false)
  assert.equal(contract.nativeUi.syntheticControls, false)
  assert.equal(contract.nativeUi.sidebar.localScrollbars, false)
  assert.equal(contract.scope.rootSelector, rootSelector)

  const requiredChecks = new Set(contract.acceptanceContract.requiredChecks)
  for (const check of [
    'strict-theme-scope',
    'desktop-four-card-row',
    'compact-two-by-two-cards',
    'sidebar-wheel-propagation',
    'no-local-scrollbars',
    'opaque-operational-surfaces',
    'settings-unmodified',
    'image-preview-unmodified',
    'no-window-coordinate-guessing',
  ]) {
    assert.ok(requiredChecks.has(check), `missing acceptance check: ${check}`)
  }
})

test('stylesheet remains strictly scoped and avoids fragile native surfaces', () => {
  assert.match(css, /url\("\.\.\/red-future-city-wallpaper\.webp"\)/)
  assert.match(css, /grid-template-columns:\s*repeat\(4,\s*minmax\(0,\s*1fr\)\)/)
  assert.match(css, /@media \(max-width:\s*920px\)/)
  assert.match(css, /grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/)
  assert.match(css, /\[data-app-action-sidebar-scroll\]/)
  assert.match(css, /overflow-y:\s*auto\s*!important/)
  assert.match(css, /scrollbar-width:\s*none/)

  for (const forbidden of contract.scope.forbiddenTargets) {
    assert.equal(css.includes(forbidden), false, `forbidden selector leaked into CSS: ${forbidden}`)
  }
  assert.doesNotMatch(css, /window\.innerWidth|clientX|screenX|nth-last-child/)
  assert.doesNotMatch(css, /position:\s*fixed\s*!important/)
  assert.doesNotMatch(css, /content:\s*["'][^"']+["']/)

  const selectors = collectSelectorPreludes(css)
  assert.ok(selectors.length > 45, 'expected a substantial concept stylesheet')
  for (const selector of selectors) {
    for (const member of splitSelectorList(selector)) {
      assert.ok(
        member.startsWith(rootSelector),
        `unscoped selector: ${member}`,
      )
    }
  }
})

test('desktop and compact layouts preserve real Codex interactions', async () => {
  const page = await browser.newPage({
    viewport: contract.acceptanceContract.desktopViewport,
    deviceScaleFactor: 1,
  })
  const consoleProblems = []
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') {
      consoleProblems.push(`${message.type()}: ${message.text()}`)
    }
  })
  page.on('pageerror', (error) => consoleProblems.push(`pageerror: ${error.message}`))

  await page.setContent(fixtureHtml(contract, wallpaper), { waitUntil: 'domcontentloaded' })
  await page.addStyleTag({ content: css })

  const unscoped = await page.evaluate(() => {
    const cardGrid = document.querySelector('.cc-theme-showcase-cards')
    const sidebar = document.querySelector('.cc-theme-shell-sidebar')
    return {
      columns: getComputedStyle(cardGrid).gridTemplateColumns.split(' ').filter(Boolean).length,
      sidebarBackground: getComputedStyle(sidebar).backgroundColor,
    }
  })
  assert.equal(unscoped.columns, 1)
  assert.equal(unscoped.sidebarBackground, 'rgb(29, 41, 57)')

  await page.evaluate(() => {
    document.documentElement.dataset.codexCompassTheme = 'red-future-city'
    document.documentElement.dataset.codexCompassThemePage = 'home'
  })
  await page.waitForTimeout(40)

  const desktop = await page.evaluate(() => {
    const title = document.querySelector('.cc-theme-showcase-title')
    const cards = Array.from(document.querySelectorAll('.cc-theme-showcase-card'))
    const cardGrid = document.querySelector('.cc-theme-showcase-cards')
    const composer = document.querySelector('.cc-theme-shell-composer')
    const project = document.querySelector('.cc-theme-shell-project-row')
    const thread = document.querySelector('.cc-theme-shell-thread-row')
    const settings = document.querySelector('#settings-probe')
    const preview = document.querySelector('#image-preview-probe')
    return {
      cardCount: cards.length,
      cardColumns: getComputedStyle(cardGrid).gridTemplateColumns.split(' ').filter(Boolean).length,
      oneCardRow: new Set(cards.map((card) => Math.round(card.getBoundingClientRect().top))).size === 1,
      titleWhiteSpace: getComputedStyle(title).whiteSpace,
      titleOverflow: title.scrollWidth > title.clientWidth,
      cardScrollbars: cards.filter((card) => (
        card.scrollHeight > card.clientHeight || card.scrollWidth > card.clientWidth
      )).length,
      projectOverflow: getComputedStyle(project).overflow,
      threadOverflow: getComputedStyle(thread).overflow,
      composerTag: composer.tagName,
      composerTextareaPreserved: Boolean(composer.querySelector('textarea')),
      settingsBackground: getComputedStyle(settings).backgroundColor,
      previewBackground: getComputedStyle(preview).backgroundColor,
    }
  })

  assert.deepEqual(desktop, {
    cardCount: 4,
    cardColumns: 4,
    oneCardRow: true,
    titleWhiteSpace: 'nowrap',
    titleOverflow: false,
    cardScrollbars: 0,
    projectOverflow: 'hidden',
    threadOverflow: 'hidden',
    composerTag: 'FORM',
    composerTextareaPreserved: true,
    settingsBackground: 'rgb(18, 52, 86)',
    previewBackground: 'rgb(101, 67, 33)',
  })

  await page.locator('.cc-theme-showcase-card').first().click()
  assert.match(await page.locator('.cc-theme-shell-composer textarea').inputValue(), /编写代码与应用/)
  assert.equal(await page.evaluate(() => window.fixtureState.inputEvents), 1)

  const surfaceState = await page.evaluate(() => {
    const selectors = ['#model-menu', '#attach-popover', '#project-menu']
    return selectors.map((selector) => {
      const style = getComputedStyle(document.querySelector(selector))
      return {
        selector,
        alpha: alphaOf(style.backgroundColor),
        opacity: style.opacity,
        backdropFilter: style.backdropFilter,
      }
    })

    function alphaOf(color) {
      const match = color.match(/^rgba?\(([^)]+)\)$/)
      if (!match) return 1
      const values = match[1].split(/[\s,/]+/).filter(Boolean).map(Number)
      return values.length > 3 ? values[3] : 1
    }
  })
  for (const surface of surfaceState) {
    assert.equal(surface.alpha, 1, `${surface.selector} was transparent`)
    assert.equal(surface.opacity, '1')
    assert.ok(
      surface.backdropFilter === 'none' || surface.backdropFilter === '',
      `${surface.selector} retained a backdrop filter`,
    )
  }
  await page.evaluate(() => {
    for (const selector of [
      '#model-menu',
      '#attach-popover',
      '#project-menu',
      '#settings-probe',
      '#image-preview-probe',
    ]) {
      document.querySelector(selector).hidden = true
    }
  })
  await page.screenshot({
    path: path.join(screenshotDir, 'red-future-city-desktop.png'),
    fullPage: false,
  })

  await page.locator('.cc-theme-shell-project-row').first().hover()
  await page.mouse.wheel(0, 440)
  await page.waitForTimeout(80)
  const wheelState = await page.evaluate(() => ({
    sidebarScrollTop: document.querySelector('[data-app-action-sidebar-scroll]').scrollTop,
    projectScrollTop: document.querySelector('.cc-theme-shell-project-row').scrollTop,
    threadScrollTop: document.querySelector('.cc-theme-shell-thread-row').scrollTop,
  }))
  assert.ok(wheelState.sidebarScrollTop > 0, JSON.stringify(wheelState))
  assert.equal(wheelState.projectScrollTop, 0)
  assert.equal(wheelState.threadScrollTop, 0)
  await page.evaluate(() => {
    document.querySelector('[data-app-action-sidebar-scroll]').scrollTop = 0
  })

  await page.setViewportSize(contract.acceptanceContract.compactViewport)
  await page.waitForTimeout(80)
  const compact = await page.evaluate(() => {
    const copy = document.querySelector('.cc-theme-showcase-copy').getBoundingClientRect()
    const cards = Array.from(document.querySelectorAll('.cc-theme-showcase-card'))
    const cardGrid = document.querySelector('.cc-theme-showcase-cards')
    const gridBox = cardGrid.getBoundingClientRect()
    const title = document.querySelector('.cc-theme-showcase-title')
    const rows = new Set(cards.map((card) => Math.round(card.getBoundingClientRect().top)))
    return {
      cardColumns: getComputedStyle(cardGrid).gridTemplateColumns.split(' ').filter(Boolean).length,
      cardRows: rows.size,
      titleWhiteSpace: getComputedStyle(title).whiteSpace,
      copyDoesNotOverlapCards: copy.bottom <= gridBox.top + 1,
      noDocumentHorizontalOverflow: document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      cardScrollbars: cards.filter((card) => (
        card.scrollHeight > card.clientHeight || card.scrollWidth > card.clientWidth
      )).length,
    }
  })
  assert.deepEqual(compact, {
    cardColumns: 2,
    cardRows: 2,
    titleWhiteSpace: 'normal',
    copyDoesNotOverlapCards: true,
    noDocumentHorizontalOverflow: true,
    cardScrollbars: 0,
  })
  await page.screenshot({
    path: path.join(screenshotDir, 'red-future-city-compact.png'),
    fullPage: false,
  })

  assert.deepEqual(consoleProblems, [])
  console.log(`Red Future City screenshots: ${screenshotDir}`)
  await page.close()
})

function collectSelectorPreludes(source) {
  const selectors = []
  const stack = []
  let buffer = ''
  let quote = ''
  let comment = false

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]
    const next = source[index + 1]

    if (comment) {
      if (char === '*' && next === '/') {
        comment = false
        index += 1
      }
      continue
    }
    if (!quote && char === '/' && next === '*') {
      comment = true
      index += 1
      continue
    }
    if (quote) {
      buffer += char
      if (char === quote && source[index - 1] !== '\\') quote = ''
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      buffer += char
      continue
    }
    if (char === '{') {
      const prelude = buffer.trim()
      const parent = stack.at(-1)
      const isAtRule = prelude.startsWith('@')
      if (!isAtRule && parent?.type !== 'declaration') selectors.push(prelude)
      stack.push({ type: isAtRule ? 'at-rule' : 'declaration' })
      buffer = ''
      continue
    }
    if (char === '}') {
      stack.pop()
      buffer = ''
      continue
    }
    if (char === ';' && stack.at(-1)?.type === 'declaration') {
      buffer = ''
      continue
    }
    buffer += char
  }

  return selectors.filter(Boolean)
}

function splitSelectorList(selector) {
  const members = []
  let current = ''
  let depth = 0
  for (const char of selector) {
    if (char === '(' || char === '[') depth += 1
    if (char === ')' || char === ']') depth -= 1
    if (char === ',' && depth === 0) {
      members.push(current.trim())
      current = ''
    } else {
      current += char
    }
  }
  if (current.trim()) members.push(current.trim())
  return members
}

function fixtureHtml(definition, wallpaperBytes) {
  const dataUrl = `data:image/webp;base64,${wallpaperBytes.toString('base64')}`
  const title = definition.copy.title.segments
    .map(({ text, accent }) => (
      accent
        ? `<span class="cc-theme-future-title-accent" data-codex-theme-title-accent="true">${text}</span>`
        : `<span>${text}</span>`
    ))
    .join('')
  const cards = definition.copy.cards.map((card, index) => `
    <button class="cc-theme-showcase-card" type="button" data-prompt="${card.prompt}">
      <span class="cc-theme-showcase-card-icon" aria-hidden="true">${iconMarkup(card.icon)}</span>
      <span class="cc-theme-showcase-card-copy">
        <span class="cc-theme-showcase-card-label">${card.title}</span>
        <span class="cc-theme-showcase-card-description">${card.description}</span>
      </span>
      <span class="cc-theme-showcase-card-arrow" aria-hidden="true">→</span>
      <span class="cc-theme-showcase-card-index">${String(index + 1).padStart(2, '0')}</span>
    </button>
  `).join('')
  const sidebarRows = Array.from({ length: 12 }, (_, index) => `
    <div class="cc-theme-shell-project-row" data-app-action-sidebar-project-row>
      <button type="button">${iconMarkup('project')}项目 ${index + 1}</button>
    </div>
    <div class="cc-theme-shell-thread-row" data-app-action-sidebar-thread-row>
      <button type="button">任务 ${index + 1}</button>
    </div>
  `).join('')

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <title>Red Future City Concept QA</title>
  <style>
    * { box-sizing: border-box; }
    html, body { width: 100%; height: 100%; margin: 0; overflow: hidden; font-family: "Segoe UI", "Microsoft YaHei", sans-serif; }
    body { color: #1d2939; background: #f2f4f7; }
    button, textarea { font: inherit; }
    button { border: 0; cursor: pointer; }
    svg { width: 17px; height: 17px; fill: none; stroke: currentColor; stroke-width: 1.8; }
    #app { width: 100%; height: 100%; }
    .cc-theme-shell-sidebar {
      position: fixed;
      z-index: 10;
      inset: 0 auto 0 0;
      width: 260px;
      padding: 10px 12px;
      color: #fff;
      background: rgb(29, 41, 57);
    }
    .sidebar-head { position: relative; }
    .cc-theme-shell-product-button { width: calc(100% - 40px); min-height: 50px; text-align: left; }
    .cc-theme-shell-search-button { position: absolute; top: 8px; right: 0; width: 36px; height: 36px; }
    .cc-theme-shell-new-task { width: 100%; min-height: 38px; margin: 8px 0; }
    .cc-theme-shell-nav-row,
    .cc-theme-shell-project-row,
    .cc-theme-shell-thread-row { width: 100%; min-height: 32px; }
    .cc-theme-shell-nav-row button,
    .cc-theme-shell-project-row button,
    .cc-theme-shell-thread-row button {
      width: 100%;
      height: 100%;
      display: flex;
      align-items: center;
      gap: 8px;
      color: inherit;
      background: transparent;
      text-align: left;
    }
    .cc-theme-shell-group-heading { position: relative; padding: 8px; }
    [data-app-action-sidebar-scroll] { height: 310px; overflow-y: auto; overflow-x: hidden; }
    .cc-theme-shell-account-row { position: absolute; left: 12px; right: 12px; bottom: 10px; min-height: 42px; }
    #workspace {
      position: fixed;
      inset: 0 0 0 260px;
      min-width: 0;
      padding: 22px 18px 14px;
      display: flex;
      flex-direction: column;
      gap: 14px;
      overflow: hidden;
      background: #f7f7f8;
    }
    .cc-theme-showcase-host {
      width: calc(100% - 40px);
      max-width: 1220px;
      min-height: 520px;
      margin: auto auto 0;
    }
    .cc-theme-showcase {
      position: relative;
      isolation: isolate;
      width: 100%;
      min-height: 520px;
      display: grid;
      grid-template-rows: minmax(0, 1fr) auto;
      padding: 30px;
      overflow: hidden;
      background: #e4e7ec;
    }
    .cc-theme-showcase::before,
    .cc-theme-showcase::after { content: ""; position: absolute; z-index: -1; inset: 0; pointer-events: none; }
    .cc-theme-showcase-brandline { position: absolute; z-index: 4; display: flex; align-items: center; }
    .cc-theme-showcase-brandmark { display: grid; place-items: center; }
    .cc-theme-showcase-brandcopy { display: grid; }
    .cc-theme-showcase-status { margin-left: auto; }
    .cc-theme-showcase-copy { position: relative; z-index: 2; }
    .cc-theme-showcase-title { margin: 0; }
    .cc-theme-showcase-subtitle { margin: 12px 0 0; }
    .cc-theme-showcase-badge { display: inline-flex; }
    .cc-theme-showcase-motif { position: absolute; border-radius: 50%; pointer-events: none; }
    .cc-theme-showcase-motif::before,
    .cc-theme-showcase-motif::after { content: ""; position: absolute; border-radius: inherit; }
    .cc-theme-showcase-cards { position: relative; z-index: 3; display: grid; grid-template-columns: 1fr; gap: 10px; }
    .cc-theme-showcase-card { min-width: 0; }
    .cc-theme-showcase-card-icon { display: grid; place-items: center; }
    .cc-theme-showcase-card-copy { min-width: 0; }
    .cc-theme-showcase-card-label,
    .cc-theme-showcase-card-description { display: block; }
    .cc-theme-shell-composer {
      position: relative;
      width: min(980px, calc(100% - 60px));
      min-height: 84px;
      margin: 0 auto;
      padding: 12px;
      display: grid;
      grid-template-columns: auto minmax(0, 1fr) auto auto;
      align-items: end;
      gap: 8px;
      background: #fff;
    }
    .cc-theme-shell-composer::before,
    .cc-theme-shell-composer::after { content: ""; position: absolute; pointer-events: none; }
    .cc-theme-shell-composer textarea { width: 100%; min-width: 0; height: 52px; resize: none; }
    .cc-theme-shell-composer button { min-height: 34px; }
    #model-menu,
    #attach-popover,
    #project-menu {
      position: fixed;
      z-index: 30;
      width: 190px;
      min-height: 70px;
      padding: 10px;
      color: #fff;
      background: rgba(7, 12, 20, 0.12);
      backdrop-filter: blur(18px);
      opacity: .74;
    }
    #model-menu { top: 20px; right: 20px; }
    #attach-popover { top: 110px; right: 20px; }
    #project-menu { top: 200px; right: 20px; }
    #settings-probe {
      position: fixed;
      z-index: 40;
      left: 280px;
      top: 20px;
      width: 90px;
      height: 30px;
      background: rgb(18, 52, 86);
    }
    #image-preview-probe {
      position: fixed;
      z-index: 40;
      left: 380px;
      top: 20px;
      width: 90px;
      height: 30px;
      background: rgb(101, 67, 33);
    }
    @media (max-width: 900px) {
      .cc-theme-shell-sidebar { width: 216px; }
      #workspace { left: 216px; padding-inline: 10px; }
      .cc-theme-showcase-host { width: calc(100% - 16px); }
      .cc-theme-shell-composer { width: calc(100% - 24px); }
    }
  </style>
</head>
<body>
  <div id="app">
    <aside class="cc-theme-shell-sidebar">
      <div class="sidebar-head">
        <button class="cc-theme-shell-product-button" type="button" data-cc-theme-mark="C">Codex</button>
        <button class="cc-theme-shell-search-button" type="button" aria-label="搜索">${iconMarkup('search')}</button>
      </div>
      <button class="cc-theme-shell-new-task" type="button">＋ 新建任务</button>
      <nav>
        <div class="cc-theme-shell-nav-row"><button type="button">${iconMarkup('task')}任务</button></div>
        <div class="cc-theme-shell-nav-row"><button type="button">${iconMarkup('chat')}会话</button></div>
        <div class="cc-theme-shell-nav-row"><button type="button">${iconMarkup('agent')}智能体</button></div>
        <div class="cc-theme-shell-nav-row"><button type="button">${iconMarkup('plugin')}插件</button></div>
        <div class="cc-theme-shell-nav-row"><button type="button">${iconMarkup('knowledge')}知识库</button></div>
        <div class="cc-theme-shell-nav-row"><button type="button">${iconMarkup('settings')}设置</button></div>
      </nav>
      <div class="cc-theme-shell-group-heading">项目</div>
      <div data-app-action-sidebar-scroll>${sidebarRows}</div>
      <button class="cc-theme-shell-account-row" type="button">小张</button>
    </aside>
    <main id="workspace">
      <section class="cc-theme-showcase-host">
        <section
          class="cc-theme-showcase theme-red-future-city layout-future cards-solid"
          style="--cc-showcase-hero: url('${dataUrl}')"
        >
          <div class="cc-theme-showcase-brandline">
            <span class="cc-theme-showcase-brandmark">C</span>
            <span class="cc-theme-showcase-brandcopy">
              <span class="cc-theme-showcase-brandname">${definition.copy.brand.name}</span>
              <span class="cc-theme-showcase-brandmeta">${definition.copy.brand.meta}</span>
            </span>
            <span class="cc-theme-showcase-status">${definition.copy.brand.status}</span>
          </div>
          <div class="cc-theme-showcase-copy">
            <span class="cc-theme-showcase-eyebrow">${definition.copy.eyebrow}</span>
            <h1 class="cc-theme-showcase-title">${title}</h1>
            <p class="cc-theme-showcase-subtitle">${definition.copy.subtitle}</p>
            <span class="cc-theme-showcase-badge">${definition.copy.brand.status}</span>
          </div>
          <div class="cc-theme-showcase-motif" data-codex-theme-decoration="energy-orbit"></div>
          <div class="cc-theme-showcase-companion"></div>
          <div class="cc-theme-showcase-cards">${cards}</div>
        </section>
      </section>
      <form class="cc-theme-shell-composer">
        <button class="cc-theme-shell-attach-button" type="button" aria-label="添加文件">${iconMarkup('attach')}</button>
        <textarea placeholder="${definition.copy.composerPlaceholder}"></textarea>
        <button class="cc-theme-shell-model-button" type="button">5.6 Sol</button>
        <button class="cc-theme-shell-send-button" type="submit" aria-label="发送">${iconMarkup('send')}</button>
      </form>
    </main>
    <div id="model-menu" role="menu"><div role="menuitem">gpt-5.6-sol</div></div>
    <div id="attach-popover" data-slot="popover-content">选择本地文件</div>
    <div id="project-menu" role="menu" data-codex-theme-project-context-menu="true">
      <div role="menuitem">重命名项目</div>
    </div>
    <section id="settings-probe" role="dialog" data-slot="dialog-content" aria-label="Codex 设置"></section>
    <section id="image-preview-probe" role="dialog" aria-label="图片预览"></section>
  </div>
  <script>
    window.fixtureState = { inputEvents: 0 };
    const composer = document.querySelector('.cc-theme-shell-composer');
    const textarea = composer.querySelector('textarea');
    textarea.addEventListener('input', () => { window.fixtureState.inputEvents += 1; });
    composer.addEventListener('submit', (event) => event.preventDefault());
    document.querySelectorAll('.cc-theme-showcase-card').forEach((card) => {
      card.addEventListener('click', () => {
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
        setter.call(textarea, card.dataset.prompt);
        textarea.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
      });
    });
  </script>
</body>
</html>`
}

function iconMarkup(name) {
  const paths = {
    code: '<path d="m8 9-3 3 3 3M16 9l3 3-3 3M14 5l-4 14"/>',
    review: '<circle cx="11" cy="11" r="6"/><path d="m16 16 4 4M8 11h6M11 8v6"/>',
    build: '<path d="m14 4 6 6-10 10H4v-6Z"/><path d="m13 5 6 6"/>',
    repair: '<path d="M14 6a4 4 0 0 0-5 5L4 16l4 4 5-5a4 4 0 0 0 5-5l-3 3-4-4Z"/>',
    project: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 9h18"/>',
    search: '<circle cx="11" cy="11" r="6"/><path d="m16 16 4 4"/>',
    task: '<path d="M5 5h14v14H5Z"/><path d="m8 12 2 2 5-5"/>',
    chat: '<path d="M4 5h16v12H8l-4 3Z"/>',
    agent: '<circle cx="12" cy="8" r="3"/><path d="M5 20a7 7 0 0 1 14 0"/>',
    plugin: '<path d="M8 3v4H4v4h4v4h4v4h4v-4h4v-4h-4V7h-4V3Z"/>',
    knowledge: '<path d="M5 4h11a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3Z"/><path d="M8 4v16"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/>',
    attach: '<path d="m8 12 5-5a3 3 0 0 1 4 4l-7 7a5 5 0 0 1-7-7l7-7"/>',
    send: '<path d="m12 19V5M6 11l6-6 6 6"/>',
  }
  return `<svg viewBox="0 0 24 24" aria-hidden="true">${paths[name] ?? paths.code}</svg>`
}
