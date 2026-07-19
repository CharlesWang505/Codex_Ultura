import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { chromium } from 'playwright'

const port = 5187
const baseUrl = `http://127.0.0.1:${port}`
const outputDir = path.resolve('output/playwright/theme-studio')
const enfpWallpaper = `data:image/webp;base64,${(
  await readFile(path.resolve('src-tauri/codex-plus/assets/theme-studio/enfp-doodle-wallpaper.webp'))
).toString('base64')}`

const visual = {
  accent: '#c95f7b',
  accentSoft: '#f7dce3',
  background: '#fff8f9',
  surface: '#fffdfd',
  surfaceAlt: '#fbeef1',
  text: '#39252c',
  textMuted: '#806b72',
  border: '#eacbd3',
  sidebarOpacity: 88,
  contentOpacity: 82,
  wallpaperOpacity: 100,
  blurPx: 18,
  radiusPx: 14,
  fontScale: 100,
  fontFamily: 'system',
  wallpaperFit: 'cover',
}

const showcaseBase = {
  enabled: true,
  heroImageDataUrl: '',
  portraitImageDataUrl: '',
  showCards: true,
}

function showcase(eyebrow, title, subtitle, cardTitles, cardPrompts = []) {
  const icons = ['code', 'build', 'review', 'repair']
  return {
    ...structuredClone(showcaseBase),
    eyebrow,
    title,
    subtitle,
    cards: cardTitles.map((cardTitle, index) => ({
      title: cardTitle,
      prompt: cardPrompts[index] ?? `${cardTitle}。请分析当前项目并完成对应任务、测试与结果说明。`,
      icon: icons[index],
    })),
  }
}

function wallpaper(background, accent) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800"><rect width="1200" height="800" fill="${background}"/><g fill="none" stroke="${accent}" opacity=".24" stroke-width="3"><path d="M0 180 C120 40 250 190 350 0"/><path d="M1200 620 C1050 760 930 610 850 800"/><circle cx="90" cy="100" r="42"/><circle cx="1110" cy="710" r="54"/></g></svg>`
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`
}

const themes = [
  {
    id: 'rose-garden', name: '玫瑰灵感', description: '奶油白、樱花粉、玫瑰花笺与原创人物的柔和灵感主题。',
    background: '#fff8fa', accent: '#c85f7d',
    showcase: showcase(
      '玫瑰灵感 · Codex Compass',
      '我们该构建什么？',
      '在玫瑰与灵感里，把下一段代码认真做好。',
      ['探索代码脉络', '构建心动功能', '审查实现细节', '修复问题回归'],
    ),
    presentation: {
      layoutStyle: 'editorial', cardStyle: 'paper', motifStyle: 'roses', headerBadge: '玫瑰灵感限定',
      heroPosition: 'far-right', overlayStrength: 88, taskWallpaperOpacity: 8, taskMode: 'ambient',
    },
  },
  {
    id: 'warm-manuscript', name: '财神工作台', description: '宣纸、春节红金、金币与原创财神程序员工作台。',
    background: '#fbf3dd', accent: '#b72d22',
    showcase: showcase(
      '财神打工版 · Codex Compass',
      '今天先把项目搞赚钱',
      '优化成本、清理技术债、催进度，让代码为结果服务。',
      ['成本优化', '技术债清账', '报表自动生成', '冲突合并开运'],
    ),
    presentation: {
      layoutStyle: 'fortune', cardStyle: 'paper', motifStyle: 'coins', headerBadge: '今日财运在线',
      heroPosition: 'far-right', overlayStrength: 90, taskWallpaperOpacity: 7, taskMode: 'ambient',
    },
  },
  {
    id: 'red-future-city', name: '红色未来城市', description: '红白未来城市、巨型能量核心与面向每个人的科技广场。',
    background: '#fff8f7', accent: '#d92727',
    showcase: showcase(
      '人民 AI · Codex Compass',
      'OpenAI 是人民的 AI。',
      '用先进的工具，为每一个人创造更多可能。',
      ['构建应用', '分析洞察', '自动化流程', '调试优化'],
    ),
    presentation: {
      layoutStyle: 'future', cardStyle: 'solid', motifStyle: 'orbit', headerBadge: '面向每一个人',
      heroPosition: 'right', overlayStrength: 86, taskWallpaperOpacity: 8, taskMode: 'banner',
    },
  },
  {
    id: 'mint-paper', name: '橄榄纸笺', description: '暖白手工纸、橄榄绿叶影与原创人物的安静纸笺主题。',
    background: '#f7f5eb', accent: '#7d8e55',
    showcase: showcase(
      '橄榄纸笺 · Codex Compass',
      '我们该构建什么？',
      '让思路在纸张与叶影中沉淀，再把它写成可靠代码。',
      ['理清代码脉络', '构建清晰功能', '审查实现细节', '修复问题根因'],
    ),
    presentation: {
      layoutStyle: 'paper', cardStyle: 'paper', motifStyle: 'leaves', headerBadge: '纸笺限定',
      heroPosition: 'far-right', overlayStrength: 90, taskWallpaperOpacity: 7, taskMode: 'ambient',
    },
  },
  {
    id: 'enfp-doodle', name: 'ENFP 灵感宇宙', description: '彩色草图纸、原创动漫创作者与高能灵感宇宙。',
    background: '#fffdf3', accent: '#12a890',
    showcase: showcase(
      'ENFP · 灵感发动机已启动 ♥',
      '先有灵感，再把它变成真的',
      'ENFP 模式：脑暴、试错、灵感乱飞，但最后都能落地。',
      ['灵感脑暴', '快速原型', '边玩边改', '欢乐修 Bug'],
      [
        '把脑子里的一万种可能都倒出来！请围绕当前项目快速脑暴并筛选方向。',
        '想法不等人，先跑起来再说！请快速完成可运行原型。',
        '改到爽为止，体验即正义！请边验证边改进交互与实现。',
        'Bug 不可怕，把它变成段子吧！请定位根因并补充回归测试。',
      ],
    ),
    presentation: {
      layoutStyle: 'doodle', cardStyle: 'outline', motifStyle: 'doodles', headerBadge: '好点子 +99',
      heroPosition: 'far-right', overlayStrength: 88, taskWallpaperOpacity: 5, taskMode: 'ambient',
    },
  },
  {
    id: 'ink-night', name: '蝶光星河', description: '深蓝紫星河、蝶光与原创人物的沉浸式夜间主题。',
    background: '#0b1028', accent: '#a961f2', dark: true,
    showcase: showcase(
      '蝶光星河 · Codex Compass',
      '我们该构建什么？',
      '与蝶光一起，用灵感创造无限可能。',
      ['探索代码星图', '构建闪光功能', '审查实现轨迹', '修复隐藏问题'],
    ),
    presentation: {
      layoutStyle: 'cosmic', cardStyle: 'glass', motifStyle: 'butterflies', headerBadge: '蝶光限定',
      heroPosition: 'far-right', overlayStrength: 78, taskWallpaperOpacity: 9, taskMode: 'ambient',
    },
  },
  {
    id: 'cyan-virtual-stage', name: '未来歌姬舞台', description: '青蓝粉彩数字舞台、星光音符与原创虚拟歌姬。',
    background: '#f1fcfd', accent: '#10b9bf',
    showcase: showcase(
      '未来歌姬舞台 · Codex Compass',
      '我们今天来构建什么？',
      '让灵感写成代码，让每一次迭代都有节拍。',
      ['编写灵感代码', '构建互动功能', '审查舞台表现', '修复节拍问题'],
    ),
    presentation: {
      layoutStyle: 'idol', cardStyle: 'glass', motifStyle: 'stars', headerBadge: '未来舞台',
      heroPosition: 'far-right', overlayStrength: 86, taskWallpaperOpacity: 7, taskMode: 'ambient',
    },
  },
  {
    id: 'starlight-stage', name: '黑金茉莉舞台', description: '近黑舞台、香槟金灯光、茉莉花与原创人物。',
    background: '#090a09', accent: '#c8a66a', dark: true,
    showcase: showcase(
      '黑金茉莉舞台 · Codex Compass',
      '我们一起创造什么？',
      '让灵感与代码同频，在舞台灯光下完成下一项任务。',
      ['探索代码节奏', '构建舞台功能', '审查实现表现', '修复幕后问题'],
    ),
    presentation: {
      layoutStyle: 'stage', cardStyle: 'solid', motifStyle: 'jasmine', headerBadge: '茉莉舞台',
      heroPosition: 'far-right', overlayStrength: 76, taskWallpaperOpacity: 8, taskMode: 'ambient',
    },
  },
].map(({ id, name, description, background, accent, dark = false, showcase, presentation }) => ({
  id,
  name,
  description,
  author: 'Codex Compass',
  version: id === 'enfp-doodle' ? '2.2.0' : '2.1.0',
  license: 'AI-generated original asset',
  builtin: true,
  decorativeStyle: 'botanical',
  wallpaperDataUrl: id === 'enfp-doodle' ? enfpWallpaper : wallpaper(background, accent),
  showcase,
  presentation,
  visual: {
    ...visual,
    accent,
    background,
    surface: dark ? '#171b38' : '#fffdfd',
    surfaceAlt: dark ? '#22234a' : '#fbeef1',
    text: dark ? '#f8f4ff' : '#39252c',
    textMuted: dark ? '#beb4d5' : '#806b72',
    border: dark ? '#4e4780' : '#eacbd3',
    wallpaperOpacity: dark ? 64 : 70,
  },
}))

const themeResult = {
  status: 'ok',
  message: 'Codex 主题工坊已加载。',
  settings: {
    schemaVersion: 3,
    enabled: false,
    selectedThemeId: 'rose-garden',
    themes,
    updatedAt: '1784131200',
  },
  settingsPath: 'C:\\Users\\Tester\\AppData\\Local\\CodexCompass\\theme-studio\\themes-v3.json',
  packageFormat: 'Codex Compass Theme v3',
  runtimeConnected: true,
  runtimeStatus: 'loaded',
  debugPort: 9222,
}

const marketResult = {
  ...structuredClone(themeResult),
  status: 'ok',
  message: '主题市场已刷新。',
  market: {
    schemaVersion: 1,
    updatedAt: '2026-07-18',
    themes: [{
      id: 'market-demo',
      name: '市场演示主题',
      version: '1.0.0',
      author: 'CodexPlusPlus-Themes',
      description: '用于验证主题市场三列布局和安装状态。',
      license: 'MIT',
      sourceUrl: 'https://github.com/BigPizzaV3/CodexPlusPlus-Themes',
      tags: ['demo', 'market'],
      previewUrl: wallpaper('#eef7ff', '#2d7fd3'),
      installed: false,
      installedVersion: '',
      updateAvailable: false,
    }],
  },
  cached: false,
  warning: '',
  repositoryUrl: 'https://github.com/BigPizzaV3/CodexPlusPlus-Themes',
}

const server = spawn(
  process.execPath,
  ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(port), '--strictPort'],
  { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] },
)

let browser
try {
  await waitForServer()
  await mkdir(outputDir, { recursive: true })
  browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 })
  const page = await context.newPage()
  page.on('console', (message) => console.log(`[browser:${message.type()}] ${message.text()}`))
  page.on('pageerror', (error) => console.error(`[browser:error] ${error.stack ?? error.message}`))
  await page.addInitScript(({ initialThemeResult, initialMarketResult }) => {
    let callbackId = 0
    let currentTheme = structuredClone(initialThemeResult)
    const settingsResult = {
      status: 'ok',
      message: 'Codex 设置已加载。',
      settings: {
        relayProfiles: [],
        hotSwitchModelMappings: [],
      },
      settingsPath: 'C:\\mock\\settings.json',
      userScripts: { enabled: true, scripts: [] },
    }
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
      unregisterListener: () => undefined,
    }
    window.__TAURI_INTERNALS__ = {
      metadata: {
        currentWindow: { label: 'main' },
        currentWebview: { label: 'main', windowLabel: 'main' },
      },
      transformCallback: () => ++callbackId,
      unregisterCallback: () => undefined,
      convertFileSrc: (value) => value,
      invoke: async (command, args) => {
        if (command === 'app_version') return '1.3.52'
        if (command === 'load_sites') return []
        if (command === 'load_app_preferences') return { closeBehavior: 'ask' }
        if (command === 'load_settings') return settingsResult
        if (command === 'load_overview') return {
          status: 'ok',
          message: '概览已加载。',
          codexApp: { status: 'ok', path: 'C:\\Codex\\Codex.exe' },
          codexVersion: '26.707',
          silentShortcut: { status: 'ok', path: 'C:\\Codex.lnk' },
          managementShortcut: { status: 'ok', path: 'C:\\Codex Compass.lnk' },
          latestLaunch: null,
          currentVersion: '1.3.52',
          updateStatus: 'not_checked',
          settingsPath: 'C:\\mock\\settings.json',
          logsPath: 'C:\\mock\\logs',
        }
        if (command === 'relay_status') return {
          status: 'ok',
          message: '中继状态已加载。',
          authenticated: false,
          authSource: 'none',
          accountLabel: null,
          configPath: 'C:\\mock\\config.toml',
          configured: false,
          requiresOpenaiAuth: false,
          hasBearerToken: false,
          backupPath: null,
        }
        if (command === 'hot_switch_status') return {
          ...settingsResult,
          enabled: false,
          running: false,
          baseUrl: 'http://127.0.0.1:8787/v1',
          relayId: '',
          relayName: '',
          model: '',
          error: null,
        }
        if (command === 'load_watcher_state') return {
          status: 'ok',
          message: 'Watcher 状态已加载。',
          installed: false,
          enabled: false,
          running: false,
          registrationValid: false,
        }
        if (command === 'load_codex_theme_studio') return structuredClone(currentTheme)
        if (command === 'refresh_theme_market') return structuredClone(initialMarketResult)
        if (command === 'save_codex_theme_studio') {
          currentTheme = {
            ...currentTheme,
            status: 'ok',
            message: '主题已保存并应用到当前 Codex。',
            settings: structuredClone(args.request.settings),
            runtimeConnected: true,
            runtimeStatus: 'loaded',
          }
          return structuredClone(currentTheme)
        }
        if (command === 'reload_codex_theme_studio') {
          return { ...structuredClone(currentTheme), status: 'ok', message: '当前主题已重新加载。' }
        }
        if (command.startsWith('plugin:event|')) return 1
        return null
      },
    }
  }, { initialThemeResult: themeResult, initialMarketResult: marketResult })

  await page.goto(baseUrl, { waitUntil: 'networkidle' })
  const themeNavigation = page.getByRole('button', { name: '主题工坊' })
  try {
    await themeNavigation.waitFor({ timeout: 10_000 })
  } catch (error) {
    console.error(await page.locator('body').innerText())
    await page.screenshot({ path: path.join(outputDir, 'startup-failure.png'), fullPage: true })
    throw error
  }
  await themeNavigation.click()
  await page.getByRole('heading', { name: '玫瑰灵感' }).waitFor()
  const noticeViewport = page.locator('#codex-notice-viewport')
  await noticeViewport.waitFor()
  assert.equal(await noticeViewport.evaluate((element) => getComputedStyle(element).position), 'fixed')
  const studioHeaderBox = await page.locator('.theme-studio-header').boundingBox()
  assert.ok(studioHeaderBox && studioHeaderBox.y < 190, `theme header was pushed down to ${studioHeaderBox?.y}`)
  assert.equal(await page.locator('.theme-card').count(), 8)
  assert.equal(
    await page.locator('.theme-card-grid').evaluate((element) => getComputedStyle(element).gridTemplateColumns.split(' ').length),
    3,
  )
  await page.getByRole('tab', { name: '主题市场' }).click()
  await page.locator('.theme-market-card').waitFor()
  assert.equal(await page.locator('.theme-market-card').count(), 1)
  assert.equal(
    await page.locator('.theme-market-grid').evaluate((element) => getComputedStyle(element).gridTemplateColumns.split(' ').length),
    3,
  )
  await page.screenshot({ path: path.join(outputDir, 'market-zh.png'), fullPage: true })
  await page.getByRole('tab', { name: '我的主题' }).click()
  await page.getByText(/themes-v3\.json/).waitFor()
  await page.getByText('首页展示', { exact: true }).waitFor()
  assert.equal(await page.locator('.theme-preview-showcase-cards button').count(), 4)
  assert.equal(await page.locator('.theme-showcase-card-list article').count(), 4)
  const editorLayout = page.locator('.theme-editor-layout')
  const previewSection = page.locator('.theme-preview-section')
  const controlsSection = page.locator('.theme-controls-section')
  const codexPreview = page.locator('.theme-codex-preview')
  const previewSidebar = codexPreview.locator('aside')
  const previewMain = codexPreview.locator('main')
  const previewHeader = previewMain.locator('header')
  const previewComposer = previewMain.locator('footer')
  const showcasePreview = page.locator('.theme-preview-showcase')
  const layoutSelect = page.getByLabel('布局风格')
  const cardStyleSelect = page.getByLabel('卡片风格')
  const motifSelect = page.getByLabel('主题标志')
  const heroPositionSelect = page.getByLabel('主视觉位置')
  const taskModeSelect = page.getByLabel('任务页模式')
  const headerBadgeInput = page.getByLabel('标题徽标')
  const overlaySlider = page.locator('.theme-presentation-sliders label').filter({ hasText: '首页遮罩' }).locator('input')
  const taskWallpaperSlider = page.locator('.theme-presentation-sliders label').filter({ hasText: '任务页壁纸' }).locator('input')

  await codexPreview.waitFor()
  assert.equal(await codexPreview.locator('.theme-preview-wallpaper').count(), 1)
  assert.equal(await previewSidebar.locator('.theme-preview-brand').count(), 1)
  assert.equal(await previewSidebar.getByRole('button').count(), 4)
  assert.equal(await previewSidebar.getByText('Codex', { exact: true }).count(), 1)
  assert.equal(await previewSidebar.getByText('新建任务', { exact: true }).count(), 1)
  assert.equal(await previewSidebar.getByText('已有任务', { exact: true }).count(), 1)
  assert.equal(await previewSidebar.getByText('项目', { exact: true }).count(), 1)
  assert.equal(await previewHeader.getByText('Codex Compass Theme', { exact: true }).count(), 1)
  assert.equal(await previewHeader.getByText('OFF', { exact: true }).count(), 1)
  assert.equal(await previewComposer.getByText('输入消息或描述任务', { exact: true }).count(), 1)
  assert.equal(await previewComposer.getByRole('button').count(), 1)
  assert.equal(await page.locator('.theme-preview-task-hint').count(), 1)
  assert.equal(await layoutSelect.count(), 1)
  assert.equal(await cardStyleSelect.count(), 1)
  assert.equal(await motifSelect.count(), 1)
  assert.equal(await heroPositionSelect.count(), 1)
  assert.equal(await taskModeSelect.count(), 1)
  assert.equal(await headerBadgeInput.count(), 1)
  assert.equal(await overlaySlider.count(), 1)
  assert.equal(await taskWallpaperSlider.count(), 1)
  assert.equal(
    await editorLayout.evaluate((element) => getComputedStyle(element).gridTemplateColumns.split(' ').length),
    1,
  )
  assert.equal(
    await page.locator('.theme-showcase-card-list').evaluate((element) => getComputedStyle(element).gridTemplateColumns.split(' ').length),
    2,
  )
  const desktopPreviewBox = await previewSection.boundingBox()
  const desktopControlsBox = await controlsSection.boundingBox()
  assert.ok(desktopPreviewBox && desktopControlsBox, 'theme editor sections must be visible')
  assert.ok(
    desktopControlsBox.y >= desktopPreviewBox.y + desktopPreviewBox.height - 1,
    `theme controls should be below preview: preview=${JSON.stringify(desktopPreviewBox)} controls=${JSON.stringify(desktopControlsBox)}`,
  )
  assert.ok(
    Math.abs(desktopPreviewBox.width - desktopControlsBox.width) <= 2,
    `theme editor sections should have equal width: preview=${desktopPreviewBox.width} controls=${desktopControlsBox.width}`,
  )
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth), false)
  await controlsSection.screenshot({ path: path.join(outputDir, 'theme-controls-desktop-zh.png') })

  for (const theme of themes) {
    const themeButton = page.getByRole('button', { name: new RegExp(theme.name) })
    await themeButton.waitFor()
    await themeButton.click()
    await page.getByRole('heading', { name: theme.name }).waitFor()
    assert.match(await showcasePreview.getAttribute('class'), new RegExp(`theme-${theme.id}`))
    assert.equal(await showcasePreview.getAttribute('data-layout-style'), theme.presentation.layoutStyle)
    assert.equal(await showcasePreview.getAttribute('data-card-style'), theme.presentation.cardStyle)
    assert.equal(await showcasePreview.getAttribute('data-motif-style'), theme.presentation.motifStyle)
    assert.equal(await showcasePreview.getAttribute('data-hero-position'), theme.presentation.heroPosition)
    assert.equal(await showcasePreview.getAttribute('data-task-mode'), theme.presentation.taskMode)
    assert.equal(await layoutSelect.inputValue(), theme.presentation.layoutStyle)
    assert.equal(await cardStyleSelect.inputValue(), theme.presentation.cardStyle)
    assert.equal(await motifSelect.inputValue(), theme.presentation.motifStyle)
    assert.equal(await heroPositionSelect.inputValue(), theme.presentation.heroPosition)
    assert.equal(await taskModeSelect.inputValue(), theme.presentation.taskMode)
    assert.equal(await headerBadgeInput.inputValue(), theme.presentation.headerBadge)
    assert.equal(await overlaySlider.inputValue(), String(theme.presentation.overlayStrength))
    assert.equal(await taskWallpaperSlider.inputValue(), String(theme.presentation.taskWallpaperOpacity))
    assert.equal(
      await codexPreview.evaluate((element) => element.style.getPropertyValue('--theme-preview-accent')),
      theme.visual.accent,
    )
    assert.equal(
      await codexPreview.evaluate((element) => element.style.getPropertyValue('--theme-preview-overlay-strength')),
      String(theme.presentation.overlayStrength / 100),
    )
    assert.equal(
      await codexPreview.evaluate((element) => element.style.getPropertyValue('--theme-preview-task-wallpaper-opacity')),
      String(theme.presentation.taskWallpaperOpacity / 100),
    )
    assert.equal(await previewHeader.getByText(theme.name, { exact: true }).count(), 1)
    assert.equal(await showcasePreview.locator('h2').innerText(), theme.showcase.title)
    assert.equal(await showcasePreview.locator('p').innerText(), theme.showcase.subtitle)
    assert.deepEqual(
      await showcasePreview.locator('.theme-preview-showcase-cards button > span > strong').allInnerTexts(),
      theme.showcase.cards.map((card) => card.title),
    )
    assert.equal(await showcasePreview.locator('.theme-preview-header-badge').innerText(), theme.presentation.headerBadge)
    assert.equal(await showcasePreview.locator('.theme-preview-motif').count(), 1)
    assert.equal(await showcasePreview.locator('.theme-preview-showcase-cards button').count(), 4)
  }
  await page.getByRole('button', { name: /ENFP 灵感宇宙/ }).click()
  await page.getByRole('heading', { name: 'ENFP 灵感宇宙' }).waitFor()
  assert.equal(await page.locator('.theme-editor-layout').getAttribute('class'), 'theme-editor-layout theme-editor-layout-concept')
  assert.equal(await showcasePreview.locator('.theme-preview-enfp-brand strong').innerText(), 'ENFP')
  assert.equal(await showcasePreview.locator('.theme-preview-enfp-brand span').innerText(), '灵感发动机已启动 ♥')
  assert.equal(await showcasePreview.locator('.theme-preview-enfp-tags span').count(), 4)
  assert.equal(await showcasePreview.locator('.theme-preview-enfp-bubbles span').count(), 2)
  assert.equal(await showcasePreview.locator('.theme-preview-enfp-skin').count(), 1)
  assert.equal(await showcasePreview.locator('.theme-preview-enfp-mood').count(), 1)
  assert.equal(await showcasePreview.locator('.theme-preview-showcase-cards button small').count(), 4)
  assert.equal(
    await showcasePreview.locator('.theme-preview-showcase-cards').evaluate((element) => getComputedStyle(element).gridTemplateColumns.split(' ').length),
    4,
  )
  const enfpTitle = showcasePreview.locator('h2')
  const enfpTitleMetrics = await enfpTitle.evaluate((element) => {
    const style = getComputedStyle(element)
    return {
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
      fontFamily: style.fontFamily,
      fontWeight: style.fontWeight,
      whiteSpace: style.whiteSpace,
    }
  })
  assert.match(enfpTitleMetrics.fontFamily, /STXingkai/)
  assert.equal(enfpTitleMetrics.fontWeight, '400')
  assert.equal(enfpTitleMetrics.whiteSpace, 'nowrap')
  assert.ok(enfpTitleMetrics.scrollWidth <= enfpTitleMetrics.clientWidth + 1, `ENFP title overflowed by ${enfpTitleMetrics.scrollWidth - enfpTitleMetrics.clientWidth}px`)
  assert.equal(await previewSidebar.locator('.theme-preview-enfp-energy').count(), 1)
  assert.equal(await previewSidebar.getAttribute('class'), 'theme-preview-sidebar-enfp')
  assert.equal(await previewSidebar.locator('.theme-preview-enfp-search').count(), 1)
  assert.equal(await previewSidebar.locator('.theme-preview-enfp-nav button').count(), 6)
  assert.equal(await previewSidebar.locator('.theme-preview-enfp-heading').count(), 2)
  assert.equal(await previewSidebar.locator('.theme-preview-enfp-thread').count(), 5)
  assert.equal(await previewSidebar.locator('.theme-preview-enfp-task').count(), 5)
  assert.equal(await previewSidebar.locator('.theme-preview-enfp-account').count(), 1)
  assert.equal(
    await previewSidebar.locator('.theme-preview-enfp-scroll').evaluate(
      (element) => element.scrollHeight <= element.clientHeight + 1,
    ),
    true,
  )
  assert.equal(await previewComposer.getByText('对 ENFP 助手说点什么…', { exact: true }).count(), 1)
  await page.screenshot({ path: path.join(outputDir, 'enfp-concept-zh.png'), fullPage: true })
  await codexPreview.screenshot({ path: path.join(outputDir, 'enfp-concept-codex-zh.png') })
  await showcasePreview.screenshot({ path: path.join(outputDir, 'enfp-concept-preview-zh.png') })
  await page.setViewportSize({ width: 760, height: 900 })
  assert.equal(
    await showcasePreview.locator('.theme-preview-showcase-cards').evaluate((element) => getComputedStyle(element).gridTemplateColumns.split(' ').length),
    2,
  )
  assert.equal(await enfpTitle.evaluate((element) => getComputedStyle(element).whiteSpace), 'normal')
  assert.equal(await showcasePreview.locator('.theme-preview-enfp-bubbles').evaluate((element) => getComputedStyle(element).display), 'none')
  assert.equal(
    await editorLayout.evaluate((element) => getComputedStyle(element).gridTemplateColumns.split(' ').length),
    1,
  )
  assert.equal(
    await page.locator('.theme-showcase-card-list').evaluate((element) => getComputedStyle(element).gridTemplateColumns.split(' ').length),
    1,
  )
  const compactPreviewBox = await previewSection.boundingBox()
  const compactControlsBox = await controlsSection.boundingBox()
  assert.ok(compactPreviewBox && compactControlsBox, 'compact theme editor sections must be visible')
  assert.ok(
    compactControlsBox.y >= compactPreviewBox.y + compactPreviewBox.height - 1,
    `compact theme controls should be below preview: preview=${JSON.stringify(compactPreviewBox)} controls=${JSON.stringify(compactControlsBox)}`,
  )
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth), false)
  await controlsSection.screenshot({ path: path.join(outputDir, 'theme-controls-compact-zh.png') })
  await codexPreview.screenshot({ path: path.join(outputDir, 'enfp-concept-compact-zh.png') })
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.getByRole('button', { name: /玫瑰灵感/ }).click()

  await layoutSelect.selectOption('fortune')
  await cardStyleSelect.selectOption('outline')
  await motifSelect.selectOption('coins')
  await heroPositionSelect.selectOption('center')
  await taskModeSelect.selectOption('off')
  await headerBadgeInput.fill('SHELL PREVIEW')
  await setRangeValue(overlaySlider, 72)
  assert.equal(await showcasePreview.getAttribute('data-layout-style'), 'fortune')
  assert.equal(await showcasePreview.getAttribute('data-card-style'), 'outline')
  assert.equal(await showcasePreview.getAttribute('data-motif-style'), 'coins')
  assert.equal(await showcasePreview.getAttribute('data-hero-position'), 'center')
  assert.equal(await showcasePreview.getAttribute('data-task-mode'), 'off')
  assert.equal(await showcasePreview.locator('.theme-preview-header-badge').innerText(), 'SHELL PREVIEW')
  assert.equal(await taskWallpaperSlider.isDisabled(), true)
  assert.equal(await page.locator('.theme-preview-task-hint i').innerText(), '0%')
  assert.equal(
    await codexPreview.evaluate((element) => element.style.getPropertyValue('--theme-preview-overlay-strength')),
    '0.72',
  )

  await taskModeSelect.selectOption('banner')
  await setRangeValue(taskWallpaperSlider, 12)
  assert.equal(await showcasePreview.getAttribute('data-task-mode'), 'banner')
  assert.equal(await taskWallpaperSlider.isDisabled(), false)
  assert.equal(await page.locator('.theme-preview-task-hint i').innerText(), '12%')
  assert.equal(
    await codexPreview.evaluate((element) => element.style.getPropertyValue('--theme-preview-task-wallpaper-opacity')),
    '0.12',
  )
  await page.screenshot({ path: path.join(outputDir, 'desktop-zh.png'), fullPage: true })

  await page.getByRole('button', { name: /黑金茉莉舞台/ }).click()
  await page.getByRole('heading', { name: '黑金茉莉舞台' }).waitFor()
  assert.match(await page.locator('.theme-preview-showcase').getAttribute('class'), /theme-starlight-stage/)
  await page.screenshot({ path: path.join(outputDir, 'starlight-stage-zh.png'), fullPage: true })

  await page.getByRole('button', { name: /蝶光星河/ }).click()
  await page.locator('.theme-master-switch').click()
  await page.getByRole('button', { name: '保存并应用' }).click()
  await page.getByText('主题已保存并应用到当前 Codex。').waitFor()
  assert.equal(await page.locator('.theme-card.selected').getAttribute('class'), 'theme-card selected')

  await page.getByRole('button', { name: 'EN', exact: true }).click()
  await page.getByText('Theme Controls', { exact: true }).waitFor()
  await page.getByText('Home Showcase', { exact: true }).waitFor()
  await page.getByRole('heading', { name: 'Butterfly Starlight' }).waitFor()
  await page.getByText('What should we build?', { exact: true }).waitFor()
  await showcasePreview.locator('.theme-preview-showcase-cards button > span > strong').filter({ hasText: 'Explore the code map' }).waitFor()
  await scrollAllToTop(page)
  await page.screenshot({ path: path.join(outputDir, 'desktop-en.png') })

  await page.setViewportSize({ width: 1180, height: 820 })
  await page.getByText('Live Codex Preview', { exact: true }).waitFor()
  await scrollAllToTop(page)
  await page.screenshot({ path: path.join(outputDir, 'compact-en.png'), fullPage: true })

  const horizontalOverflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)
  assert.equal(horizontalOverflow, false)
  console.log(`Theme Studio web E2E passed. Screenshots: ${outputDir}`)
} finally {
  await browser?.close()
  server.kill()
}

async function waitForServer() {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    try {
      const response = await fetch(baseUrl)
      if (response.ok) return
    } catch {
      // wait for Vite
    }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  throw new Error('Vite did not start in time')
}

async function scrollAllToTop(page) {
  await page.evaluate(() => {
    window.scrollTo(0, 0)
    document.querySelectorAll('*').forEach((element) => {
      if (element instanceof HTMLElement && element.scrollTop > 0) element.scrollTop = 0
    })
  })
}

async function setRangeValue(locator, value) {
  await locator.evaluate((element, nextValue) => {
    const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    valueSetter?.call(element, String(nextValue))
    element.dispatchEvent(new Event('input', { bubbles: true }))
    element.dispatchEvent(new Event('change', { bubbles: true }))
  }, value)
}
