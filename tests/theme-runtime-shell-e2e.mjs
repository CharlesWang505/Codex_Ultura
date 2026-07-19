import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { chromium } from 'playwright'

const outputDir = process.env.CODEX_COMPASS_QA_OUTPUT
  ? path.resolve(process.env.CODEX_COMPASS_QA_OUTPUT)
  : path.join(tmpdir(), 'codex-compass-theme-qa')

const consoleProblems = []
const bundle = await buildRuntimeBundle()
const codexApiLogoutCss = await loadCodexApiLogoutCss()
await mkdir(outputDir, { recursive: true })

const browser = await chromium.launch({ headless: true })
try {
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 })
  const page = await context.newPage()
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') {
      consoleProblems.push(`${message.type()}: ${message.text()}`)
    }
  })
  page.on('pageerror', (error) => consoleProblems.push(`pageerror: ${error.stack ?? error.message}`))

  await page.setContent(fixtureHtml(), { waitUntil: 'domcontentloaded' })
  await page.evaluate(() => {
    window.appearanceActions = []
    window.__codexCompassThemeAppActions = {
      async runInPrimaryWindow(payload) {
        window.appearanceActions.push(payload)
        const mode = payload?.action?.mode
        document.documentElement.classList.remove('theme-light', 'theme-dark')
        if (mode) document.documentElement.classList.add(`theme-${mode}`)
      },
    }
  })
  await page.addScriptTag({ content: bundle })
  await page.waitForFunction(() => window.__codexCompassThemeRuntime?.status === 'loaded')
  await page.waitForFunction(() => window.appearanceActions?.length === 1)
  await page.waitForFunction(() => document.documentElement.dataset.codexCompassThemePage === 'home')
  await page.waitForFunction(() => document.querySelectorAll('.cc-theme-shell-window-control').length === 3)
  assert.deepEqual(await page.evaluate(() => window.appearanceActions), [
    { action: { type: 'app.appearance.set_mode', mode: 'light' } },
  ])
  const projectMenuState = await page.evaluate(() => {
    const menu = document.querySelector('#project-context-menu')
    const archive = menu?.querySelector('[data-codex-theme-project-menu-action="archive"]')
    const rename = menu?.querySelector('[data-codex-theme-project-menu-action="rename"]')
    return {
      menuMarked: menu?.dataset.codexThemeProjectContextMenu === 'true',
      archiveLabel: archive?.textContent.trim(),
      renameMarked: Boolean(rename),
    }
  })
  assert.deepEqual(projectMenuState, {
    menuMarked: true,
    archiveLabel: '归档任务',
    renameMarked: true,
  })
  await page.evaluate(() => {
    document.querySelector('#project-context-menu').hidden = false
  })
  await page.waitForTimeout(40)
  const projectMenuMetrics = await page.evaluate(() => {
    const menu = document.querySelector('#project-context-menu')
    const rename = menu.querySelector('[data-codex-theme-project-menu-action="rename"]')
    const archive = menu.querySelector('[data-codex-theme-project-menu-action="archive"]')
    const menuBox = menu.getBoundingClientRect()
    return {
      visible: menuBox.width >= 220 && menuBox.height >= 76,
      renameHeight: Math.round(rename.getBoundingClientRect().height),
      archiveHeight: Math.round(archive.getBoundingClientRect().height),
      iconsVisible: Array.from(menu.querySelectorAll('[data-codex-theme-project-menu-action] svg'))
        .every((icon) => icon.getBoundingClientRect().width === 18),
    }
  })
  assert.deepEqual(projectMenuMetrics, {
    visible: true,
    renameHeight: 38,
    archiveHeight: 38,
    iconsVisible: true,
  })
  await page.screenshot({ path: path.join(outputDir, 'enfp-project-context-menu.png') })
  await page.getByRole('menuitem', { name: '归档任务' }).click()
  await page.waitForFunction(() => window.fixtureState.archiveClicks === 1)
  await page.waitForTimeout(420)
  const archiveCleanupState = await page.evaluate(() => ({
    archiveClicks: window.fixtureState.archiveClicks,
    menuHidden: document.querySelector('#project-context-menu').hidden,
    staleOverlayHidden: document.querySelector('#project-info-overlay').hidden,
    stalePopoverHidden: document.querySelector('#project-info-popover').hidden,
  }))
  assert.deepEqual(archiveCleanupState, {
    archiveClicks: 1,
    menuHidden: true,
    staleOverlayHidden: true,
    stalePopoverHidden: true,
  })
  await page.getByRole('button', { name: '归档后页面操作' }).click()
  assert.equal(await page.evaluate(() => window.fixtureState.archiveFollowupClicks), 1)

  await page.evaluate(() => {
    const menu = document.querySelector('#project-context-menu')
    menu.hidden = false
    window.fixtureState.showArchiveConfirmation = true
  })
  await page.getByRole('menuitem', { name: '归档任务' }).click()
  await page.waitForFunction(() => window.fixtureState.archiveClicks === 2)
  await page.waitForTimeout(420)
  const archiveConfirmationState = await page.evaluate(() => ({
    confirmationVisible: !document.querySelector('#archive-confirm-layer').hidden,
    staleOverlayVisible: !document.querySelector('#project-info-overlay').hidden,
    stalePopoverVisible: !document.querySelector('#project-info-popover').hidden,
  }))
  assert.deepEqual(archiveConfirmationState, {
    confirmationVisible: true,
    staleOverlayVisible: true,
    stalePopoverVisible: true,
  })
  await page.evaluate(() => {
    document.querySelector('#archive-confirm-layer').hidden = true
    document.querySelector('#project-info-overlay').hidden = true
    document.querySelector('#project-info-popover').hidden = true
    document.querySelector('#project-context-menu').hidden = true
    window.fixtureState.showArchiveConfirmation = false
  })
  await page.evaluate(() => {
    document.querySelector('#project-context-menu').hidden = true
    document.querySelector('#project-rename-overlay').hidden = false
    document.querySelector('#project-rename-dialog').hidden = false
  })
  await page.waitForTimeout(80)
  const projectRenameMetrics = await page.evaluate(() => {
    const dialog = document.querySelector('#project-rename-dialog')
    const overlay = document.querySelector('#project-rename-overlay')
    const dialogBox = dialog.getBoundingClientRect()
    const input = dialog.querySelector('input')
    const cancel = dialog.querySelector('[data-codex-theme-project-rename-action="cancel"]')
    const save = dialog.querySelector('[data-codex-theme-project-rename-action="save"]')
    const close = dialog.querySelector('[data-codex-theme-project-rename-action="close"]')
    const inputStyle = getComputedStyle(input)
    return {
      dialogMarked: dialog.dataset.codexThemeProjectRenameDialog === 'true',
      position: getComputedStyle(dialog).position,
      centered: Math.abs(dialogBox.left + dialogBox.width / 2 - innerWidth / 2) <= 1
        && Math.abs(dialogBox.top + dialogBox.height / 2 - innerHeight / 2) <= 1,
      withinViewport: dialogBox.left >= 12 && dialogBox.right <= innerWidth - 12
        && dialogBox.top >= 12 && dialogBox.bottom <= innerHeight - 12,
      inputMarked: input.dataset.codexThemeProjectRenameField === 'true',
      inputHeight: Math.round(input.getBoundingClientRect().height),
      actionsMarked: dialog.querySelector('[data-codex-theme-project-rename-actions="true"]') !== null,
      actionsInOneRow: Math.abs(cancel.getBoundingClientRect().top - save.getBoundingClientRect().top) <= 1,
      closeMarked: close.dataset.codexThemeProjectRenameAction === 'close',
      closeWidth: Math.round(close.getBoundingClientRect().width),
      closeHeight: Math.round(close.getBoundingClientRect().height),
      inputOpaque: inputStyle.backgroundColor !== 'transparent'
        && inputStyle.backgroundColor !== 'rgba(0, 0, 0, 0)',
      overlayVisible: getComputedStyle(overlay).display !== 'none',
    }
  })
  assert.deepEqual(projectRenameMetrics, {
    dialogMarked: true,
    position: 'fixed',
    centered: true,
    withinViewport: true,
    inputMarked: true,
    inputHeight: 44,
    actionsMarked: true,
    actionsInOneRow: true,
    closeMarked: true,
    closeWidth: 32,
    closeHeight: 32,
    inputOpaque: true,
    overlayVisible: true,
  })
  await page.screenshot({ path: path.join(outputDir, 'enfp-project-rename-dialog.png') })
  await page.evaluate(() => {
    document.querySelector('#project-rename-overlay').hidden = true
    document.querySelector('#project-rename-dialog').hidden = true
  })

  assert.equal(await page.title(), 'Codex ENFP Runtime QA')
  assert.equal(await page.locator('#codex-compass-theme-showcase').count(), 1)
  assert.equal(await page.locator('.cc-theme-showcase-card').count(), 4)
  assert.equal(await page.locator('.cc-theme-shell-sidebar').count(), 1)
  assert.equal(await page.locator('.cc-theme-shell-search-button').count(), 1)
  assert.equal(await page.locator('.cc-theme-shell-account-row').count(), 1)
  assert.equal(await page.locator('.account').evaluate((element) => element.classList.contains('cc-theme-shell-account-row')), true)
  for (const [label, className] of [
    ['已安排', 'cc-theme-shell-nav-coral'],
    ['技能', 'cc-theme-shell-nav-mint'],
    ['站点', 'cc-theme-shell-nav-sky'],
    ['拉取请求', 'cc-theme-shell-nav-violet'],
  ]) {
    assert.equal(
      await page.locator('#sidebar').getByRole('button', { name: label }).evaluate(
        (element, expectedClass) => element.classList.contains(expectedClass),
        className,
      ),
      true,
      `${label} did not receive ${className}`,
    )
  }

  await page.evaluate(() => {
    const decoy = document.createElement('div')
    decoy.id = 'footer-adjacent-project-decoy'
    decoy.setAttribute('role', 'button')
    decoy.setAttribute('aria-label', 'markdown2pdf')
    decoy.setAttribute('data-app-action-sidebar-project-row', '')
    Object.assign(decoy.style, {
      position: 'absolute',
      left: '8px',
      right: '8px',
      bottom: '48px',
      height: '31px',
    })
    decoy.textContent = 'markdown2pdf'
    document.querySelector('#sidebar').appendChild(decoy)
  })
  await page.waitForTimeout(120)
  const accountSelection = await page.evaluate(() => {
    const account = document.querySelector('.account')
    const decoy = document.querySelector('#footer-adjacent-project-decoy')
    return {
      accountDecorated: account.classList.contains('cc-theme-shell-account-row'),
      accountMarginTop: getComputedStyle(account).marginTop,
      decoyDecoratedAsProject: decoy.classList.contains('cc-theme-shell-project-row'),
      decoyDecoratedAsAccount: decoy.classList.contains('cc-theme-shell-account-row'),
      decoyHeight: decoy.getBoundingClientRect().height,
    }
  })
  assert.deepEqual(accountSelection, {
    accountDecorated: true,
    accountMarginTop: '0px',
    decoyDecoratedAsProject: true,
    decoyDecoratedAsAccount: false,
    decoyHeight: 31,
  })
  await page.locator('#footer-adjacent-project-decoy').evaluate((element) => element.remove())
  await page.waitForTimeout(120)

  const shellMetrics = await page.evaluate(() => {
    const sidebar = document.querySelector('.cc-theme-shell-sidebar')
    const product = document.querySelector('.cc-theme-shell-product-button')
    const newTask = document.querySelector('.cc-theme-shell-new-task')
    const account = document.querySelector('.cc-theme-shell-account-row')
    const appHeader = document.querySelector('.app-header-tint')
    const showcase = document.querySelector('#codex-compass-theme-showcase')
    const composer = document.querySelector('.composer-surface-chrome')
    const sidebarBox = sidebar?.getBoundingClientRect()
    const accountBox = account?.getBoundingClientRect()
    const headerBox = appHeader?.getBoundingClientRect()
    const showcaseBox = showcase?.getBoundingClientRect()
    const composerBox = composer?.getBoundingClientRect()
    const firstProjectRow = document.querySelector('[data-app-action-sidebar-project-row]')
    const projectRowStyle = firstProjectRow ? getComputedStyle(firstProjectRow) : null
    if (firstProjectRow) firstProjectRow.scrollTop = 10
    const energyStyle = account ? getComputedStyle(account, '::before') : null
    const energyTop = accountBox && energyStyle ? accountBox.top + Number.parseFloat(energyStyle.top) : null
    const energyBottom = energyTop === null || !energyStyle
      ? null
      : energyTop + Number.parseFloat(energyStyle.height)
    return {
      page: document.documentElement.dataset.codexCompassThemePage,
      sidebarBackground: sidebar ? getComputedStyle(sidebar).backgroundColor : '',
      productFontSize: product ? getComputedStyle(product).fontSize : '',
      newTaskBackground: newTask ? getComputedStyle(newTask).backgroundColor : '',
      sidebarFooterHeight: sidebar ? getComputedStyle(sidebar).getPropertyValue('--sidebar-footer-height').trim() : '',
      sidebarScrollbarGutter: getComputedStyle(
        document.querySelector('[data-app-action-sidebar-scroll]'),
      ).scrollbarGutter,
      projectRowOverflowX: projectRowStyle?.overflowX ?? '',
      projectRowOverflowY: projectRowStyle?.overflowY ?? '',
      projectRowScrollTop: firstProjectRow?.scrollTop ?? -1,
      projectRowScrollbarThickness: firstProjectRow
        ? firstProjectRow.offsetWidth - firstProjectRow.clientWidth
        : -1,
      accountIsCollectionRow: account?.matches(
        '[data-app-action-sidebar-project-row],[data-app-action-sidebar-thread-row]',
      ) ?? false,
      noHorizontalOverflow: document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      sidebarSeparated: Boolean(sidebarBox && showcaseBox && sidebarBox.right <= showcaseBox.left),
      sidebarFillsViewport: Boolean(
        sidebarBox
        && headerBox
        && Math.abs(sidebarBox.top - headerBox.bottom) <= 1
        && Math.abs(sidebarBox.bottom - window.innerHeight) <= 1
      ),
      accountInsideSidebar: Boolean(
        sidebarBox
        && accountBox
        && accountBox.top >= sidebarBox.top
        && accountBox.bottom <= sidebarBox.bottom
      ),
      energyInsideSidebar: Boolean(
        sidebarBox
        && energyTop !== null
        && energyBottom !== null
        && energyTop >= sidebarBox.top
        && energyBottom <= sidebarBox.bottom
      ),
      sidebarBox: sidebarBox ? { top: sidebarBox.top, bottom: sidebarBox.bottom, height: sidebarBox.height } : null,
      accountBox: accountBox ? { top: accountBox.top, bottom: accountBox.bottom, height: accountBox.height } : null,
      energyBox: energyTop === null || energyBottom === null ? null : { top: energyTop, bottom: energyBottom },
      showcaseAboveComposer: Boolean(showcaseBox && composerBox && showcaseBox.bottom <= composerBox.top + 1),
      showcaseBox: showcaseBox ? { top: showcaseBox.top, bottom: showcaseBox.bottom, height: showcaseBox.height } : null,
      composerBox: composerBox ? { top: composerBox.top, bottom: composerBox.bottom, height: composerBox.height } : null,
    }
  })
  assert.equal(shellMetrics.page, 'home')
  assert.equal(alphaOf(shellMetrics.sidebarBackground), 1)
  assert.equal(shellMetrics.productFontSize, '26px')
  assert.equal(alphaOf(shellMetrics.newTaskBackground), 0)
  assert.equal(shellMetrics.sidebarFooterHeight, '84px')
  assert.equal(shellMetrics.sidebarScrollbarGutter, 'stable')
  assert.equal(shellMetrics.projectRowOverflowX, 'clip')
  assert.equal(shellMetrics.projectRowOverflowY, 'clip')
  assert.equal(shellMetrics.projectRowScrollTop, 0)
  assert.ok(shellMetrics.projectRowScrollbarThickness <= 2, JSON.stringify(shellMetrics))
  assert.equal(shellMetrics.accountIsCollectionRow, false)
  assert.equal(shellMetrics.noHorizontalOverflow, true)
  assert.equal(shellMetrics.sidebarSeparated, true)
  assert.equal(shellMetrics.sidebarFillsViewport, true, JSON.stringify(shellMetrics))
  assert.equal(shellMetrics.accountInsideSidebar, true, JSON.stringify(shellMetrics))
  assert.equal(shellMetrics.energyInsideSidebar, true, JSON.stringify(shellMetrics))
  assert.equal(shellMetrics.showcaseAboveComposer, true, JSON.stringify(shellMetrics))

  const controls = page.locator('.cc-theme-shell-window-control')
  assert.equal(await controls.count(), 3)
  for (const label of ['切换置顶摘要', '切换底部面板', '显示或隐藏侧边栏']) {
    assert.equal(
      await page.getByRole('button', { name: label }).evaluate(
        (element) => element.classList.contains('cc-theme-shell-window-control'),
      ),
      false,
      `${label} was misidentified as a window control`,
    )
  }
  const controlContrast = await page.evaluate(() => {
    const header = document.querySelector('.cc-theme-shell-topbar')
    const background = getComputedStyle(header).backgroundColor
    return Array.from(document.querySelectorAll('.cc-theme-shell-window-control')).map((control) => ({
      label: control.getAttribute('aria-label'),
      color: getComputedStyle(control).color,
      background,
      opacity: getComputedStyle(control).opacity,
      pointerEvents: getComputedStyle(control).pointerEvents,
      box: control.getBoundingClientRect().toJSON(),
    }))
  })
  for (const control of controlContrast) {
    assert.ok(contrastRatio(control.color, control.background) >= 7, `${control.label} contrast was too low`)
    assert.equal(control.opacity, '1')
    assert.equal(control.pointerEvents, 'auto')
    assert.ok(control.box.left >= 0, `${control.label} crossed the left viewport edge`)
    assert.ok(control.box.right <= 1600, `${control.label} crossed the right viewport edge`)
    assert.equal(control.box.width, 28)
  }

  const stableSidebarRows = await page.evaluate(() => {
    const sidebar = document.querySelector('#sidebar')
    const rows = Array.from(sidebar.querySelectorAll(
      '[data-app-action-sidebar-project-row],[data-app-action-sidebar-thread-row]',
    ))
    const before = rows.map((row) => {
      const box = row.getBoundingClientRect()
      return {
        className: row.className,
        x: box.x,
        y: box.y,
        width: box.width,
        height: box.height,
      }
    })
    let attributeWrites = 0
    const observer = new MutationObserver((mutations) => {
      attributeWrites += mutations.length
    })
    observer.observe(sidebar, {
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'data-cc-theme-label', 'data-cc-theme-mark'],
    })
    const feed = document.createElement('div')
    feed.id = 'runtime-mutation-feed'
    document.body.appendChild(feed)
    for (let index = 0; index < 30; index += 1) {
      const line = document.createElement('div')
      line.textContent = `streamed output ${index}`
      feed.appendChild(line)
    }
    return new Promise((resolve) => {
      window.setTimeout(() => {
        observer.disconnect()
        const after = rows.map((row) => {
          const box = row.getBoundingClientRect()
          return {
            className: row.className,
            x: box.x,
            y: box.y,
            width: box.width,
            height: box.height,
          }
        })
        feed.remove()
        resolve({ attributeWrites, before, after })
      }, 420)
    })
  })
  assert.equal(stableSidebarRows.attributeWrites, 0, JSON.stringify(stableSidebarRows))
  assert.deepEqual(stableSidebarRows.after, stableSidebarRows.before)

  const sidebarWheelSetup = await page.evaluate(() => {
    const scroll = document.querySelector('[data-app-action-sidebar-scroll]')
    const spacer = document.createElement('div')
    spacer.id = 'sidebar-wheel-spacer'
    spacer.style.height = '500px'
    spacer.style.flex = '0 0 500px'
    scroll.appendChild(spacer)
    const previous = {
      height: scroll.style.height,
      overflowY: scroll.style.overflowY,
      scrollTop: scroll.scrollTop,
    }
    scroll.style.height = '150px'
    scroll.style.overflowY = 'auto'
    scroll.scrollTop = 0
    return previous
  })
  const sidebarWheelMetrics = await page.evaluate(() => {
    const scroll = document.querySelector('[data-app-action-sidebar-scroll]')
    const project = document.querySelector('[data-app-action-sidebar-project-row]')
    const event = new WheelEvent('wheel', {
      bubbles: true,
      cancelable: true,
      deltaY: 180,
      deltaMode: WheelEvent.DOM_DELTA_PIXEL,
    })
    const defaultAllowed = project.dispatchEvent(event)
    return {
      defaultAllowed,
      defaultPrevented: event.defaultPrevented,
      sidebarScrollTop: scroll.scrollTop,
      projectScrollTop: project.scrollTop,
    }
  })
  assert.equal(sidebarWheelMetrics.defaultAllowed, false)
  assert.equal(sidebarWheelMetrics.defaultPrevented, true)
  assert.ok(sidebarWheelMetrics.sidebarScrollTop > 0, JSON.stringify(sidebarWheelMetrics))
  assert.equal(sidebarWheelMetrics.projectScrollTop, 0)
  await page.evaluate((previous) => {
    const scroll = document.querySelector('[data-app-action-sidebar-scroll]')
    document.querySelector('#sidebar-wheel-spacer')?.remove()
    scroll.style.height = previous.height
    scroll.style.overflowY = previous.overflowY
    scroll.scrollTop = previous.scrollTop
  }, sidebarWheelSetup)
  await page.waitForTimeout(120)

  await page.getByRole('button', { name: '最小化' }).click()
  await page.getByRole('button', { name: '最大化或还原' }).click()
  await page.getByRole('button', { name: '关闭' }).click()
  assert.deepEqual(await page.evaluate(() => window.fixtureState.windowClicks), ['minimize', 'maximize', 'close'])

  await page.getByRole('button', { name: '关闭' }).hover()
  const closeHover = await page.getByRole('button', { name: '关闭' }).evaluate((element) => {
    const style = getComputedStyle(element)
    return { color: style.color, background: style.backgroundColor }
  })
  assert.ok(contrastRatio(closeHover.color, closeHover.background) >= 4.5)
  assert.equal(alphaOf(closeHover.background), 1)
  await page.screenshot({ path: path.join(outputDir, 'enfp-new-task-desktop.png') })

  const firstCard = page.locator('.cc-theme-showcase-card').first()
  await firstCard.click()
  const composerInput = page.locator('.composer-surface-chrome textarea')
  assert.match(await composerInput.inputValue(), /脑暴|可能/)
  assert.equal(await page.evaluate(() => window.fixtureState.composerInputs), 1)

  await page.getByRole('button', { name: '选择模型' }).click()
  const modelMenu = page.getByRole('menu')
  await modelMenu.waitFor()
  await assertOpaqueSurface(modelMenu, 'model menu')
  await page.getByRole('menuitem', { name: 'gpt-5.6-luna' }).click()
  assert.equal(await page.evaluate(() => window.fixtureState.model), 'gpt-5.6-luna')

  await page.getByRole('button', { name: '添加文件等内容' }).click()
  const attachPopover = page.locator('[data-slot="popover-content"]')
  await attachPopover.waitFor()
  await assertOpaqueSurface(attachPopover, 'attachment popover')
  await page.getByRole('button', { name: '选择本地文件' }).click()
  assert.equal(await page.evaluate(() => window.fixtureState.attachments), 1)

  await page.getByRole('button', { name: '发送' }).click()
  await page.waitForFunction(() => document.documentElement.dataset.codexCompassThemePage === 'thread')
  await page.waitForFunction(() => document.querySelector('.cc-theme-shell-stop-button'))
  assert.equal(await page.locator('#codex-compass-theme-showcase').count(), 0)
  assert.equal(await page.locator('.cc-theme-shell-stop-button').count(), 1)
  assert.equal(await page.locator('[data-testid="diff-view"]').count(), 1)
  assert.equal(await page.locator('[data-testid="terminal-panel"]').count(), 1)

  for (const selector of ['pre', '[data-testid="diff-view"]', '[data-testid="terminal-panel"]', '.monaco-editor']) {
    const surface = page.locator(selector).first()
    await assertOpaqueSurface(surface, selector)
  }

  await page.getByRole('button', { name: '打开图片预览' }).click()
  const imagePreview = page.getByRole('dialog', { name: '图片预览' })
  await imagePreview.waitFor()
  const imagePreviewMetrics = await imagePreview.evaluate((element) => {
    const dialogBox = element.getBoundingClientRect()
    const imageBox = element.querySelector('img').getBoundingClientRect()
    const downloadButton = element.querySelector('[aria-label="下载图片"]')
    const closeButton = element.querySelector('[aria-label="关闭图片预览"]')
    const downloadBox = downloadButton.getBoundingClientRect()
    const closeBox = closeButton.getBoundingClientRect()
    const downloadIcon = downloadButton.querySelector('svg, img')
    const downloadIconBox = downloadIcon ? downloadIcon.getBoundingClientRect() : null
    const closeIcon = closeButton.querySelector('svg, img')
    const closeIconBox = closeIcon ? closeIcon.getBoundingClientRect() : null
    const closeStyle = getComputedStyle(closeButton)
    const overlayBox = document.querySelector('#image-preview-overlay').getBoundingClientRect()
    const style = getComputedStyle(element)
    const transparentBackground = style.backgroundColor === 'transparent'
      || style.backgroundColor === 'rgba(0, 0, 0, 0)'
      || style.backgroundColor.endsWith('/ 0)')
    const insideViewport = (box) => (
      box.left >= 0
      && box.top >= 0
      && box.right <= window.innerWidth
      && box.bottom <= window.innerHeight
    )
    return {
      position: style.position,
      transparentBackground,
      dialogCoversViewport: dialogBox.left === 0
        && dialogBox.top === 0
        && dialogBox.right === window.innerWidth
        && dialogBox.bottom === window.innerHeight,
      overlayCoversViewport: overlayBox.left === 0
        && overlayBox.top === 0
        && overlayBox.right === window.innerWidth
        && overlayBox.bottom === window.innerHeight,
      imageVisible: insideViewport(imageBox) && imageBox.width >= 480 && imageBox.height >= 300,
      downloadVisible: insideViewport(downloadBox) && downloadBox.width >= 36 && downloadBox.height >= 36,
      closeVisible: insideViewport(closeBox) && closeBox.width >= 36 && closeBox.height >= 36,
      downloadBelowTitlebar: downloadBox.top >= 80,
      closeBelowTitlebar: closeBox.top >= 80,
      closeHasRightSafetyInset: closeBox.right <= window.innerWidth - 16,
      actionsAligned: Math.abs(downloadBox.top - closeBox.top) <= 1,
      actionsSeparated: downloadBox.right <= closeBox.left - 8,
      downloadTagName: downloadButton.tagName,
      downloadIconWidth: downloadIconBox ? Math.round(downloadIconBox.width) : null,
      downloadIconHeight: downloadIconBox ? Math.round(downloadIconBox.height) : null,
      closeIconWidth: closeIconBox ? Math.round(closeIconBox.width) : null,
      closeIconHeight: closeIconBox ? Math.round(closeIconBox.height) : null,
      closeIconCentered: Boolean(
        closeIconBox
        && Math.abs((closeBox.left + closeBox.width / 2) - (closeIconBox.left + closeIconBox.width / 2)) <= 0.5
        && Math.abs((closeBox.top + closeBox.height / 2) - (closeIconBox.top + closeIconBox.height / 2)) <= 0.5
      ),
      closeForeground: closeStyle.color,
      closeBackground: closeStyle.backgroundColor,
    }
  })
  assert.equal(imagePreviewMetrics.position, 'fixed')
  assert.equal(imagePreviewMetrics.transparentBackground, true)
  assert.equal(imagePreviewMetrics.dialogCoversViewport, true)
  assert.equal(imagePreviewMetrics.overlayCoversViewport, true)
  assert.equal(imagePreviewMetrics.imageVisible, true)
  assert.equal(imagePreviewMetrics.downloadVisible, true)
  assert.equal(imagePreviewMetrics.closeVisible, true)
  assert.equal(imagePreviewMetrics.downloadBelowTitlebar, true, JSON.stringify(imagePreviewMetrics))
  assert.equal(imagePreviewMetrics.closeBelowTitlebar, true, JSON.stringify(imagePreviewMetrics))
  assert.equal(imagePreviewMetrics.closeHasRightSafetyInset, true, JSON.stringify(imagePreviewMetrics))
  assert.equal(imagePreviewMetrics.actionsAligned, true, JSON.stringify(imagePreviewMetrics))
  assert.equal(imagePreviewMetrics.actionsSeparated, true, JSON.stringify(imagePreviewMetrics))
  assert.equal(imagePreviewMetrics.downloadTagName, 'A')
  assert.equal(
    imagePreviewMetrics.downloadIconWidth,
    24,
    JSON.stringify(imagePreviewMetrics)
  )
  assert.equal(
    imagePreviewMetrics.downloadIconHeight,
    24,
    JSON.stringify(imagePreviewMetrics)
  )
  assert.equal(imagePreviewMetrics.closeIconWidth, 24, JSON.stringify(imagePreviewMetrics))
  assert.equal(imagePreviewMetrics.closeIconHeight, 24, JSON.stringify(imagePreviewMetrics))
  assert.equal(imagePreviewMetrics.closeIconCentered, true, JSON.stringify(imagePreviewMetrics))
  assert.ok(contrastRatio(imagePreviewMetrics.closeForeground, imagePreviewMetrics.closeBackground) >= 7)
  await page.screenshot({ path: path.join(outputDir, 'enfp-image-preview-desktop.png') })
  const imagePreviewClose = imagePreview.getByRole('button', { name: '关闭图片预览' })
  await imagePreviewClose.hover()
  const imagePreviewCloseHover = await imagePreviewClose.evaluate((element) => {
    const style = getComputedStyle(element)
    return { color: style.color, background: style.backgroundColor }
  })
  assert.ok(contrastRatio(imagePreviewCloseHover.color, imagePreviewCloseHover.background) >= 4.5)
  assert.equal(alphaOf(imagePreviewCloseHover.background), 1)
  await imagePreviewClose.click()
  assert.equal(await imagePreview.isHidden(), true)

  await page.getByRole('button', { name: '打开设置' }).click()
  const dialog = page.getByRole('dialog', { name: 'Codex 设置' })
  await dialog.waitFor()
  await assertOpaqueSurface(dialog, 'settings dialog')
  await assertOpaqueSurface(dialog.locator('.settings-sidebar'), 'settings sidebar')
  await assertOpaqueSurface(dialog.locator('.settings-content'), 'settings content')
  await assertOpaqueSurface(dialog.getByRole('textbox', { name: '主题名称' }), 'settings text input')
  await assertOpaqueSurface(dialog.getByRole('combobox', { name: '默认打开方式' }), 'settings combobox')
  await assertOpaqueSurface(dialog.getByRole('switch', { name: '启用桌面通知' }), 'settings switch')
  const overlayBackground = await page.locator('#dialog-layer').evaluate(
    (element) => getComputedStyle(element).backgroundColor,
  )
  assert.ok(alphaOf(overlayBackground) >= 0.3)
  const settingsMetrics = await dialog.evaluate((element) => {
    const dialogBox = element.getBoundingClientRect()
    const sidebarBox = element.querySelector('.settings-sidebar').getBoundingClientRect()
    const contentBox = element.querySelector('.settings-content').getBoundingClientRect()
    const footerBox = element.querySelector('.settings-footer').getBoundingClientRect()
    const scroll = element.querySelector('.settings-scroll')
    const inside = (box) => (
      box.left >= dialogBox.left
      && box.right <= dialogBox.right
      && box.top >= dialogBox.top
      && box.bottom <= dialogBox.bottom
    )
    return {
      dialogInsideViewport: dialogBox.left >= 0
        && dialogBox.top >= 0
        && dialogBox.right <= window.innerWidth
        && dialogBox.bottom <= window.innerHeight,
      noHorizontalOverflow: element.scrollWidth <= element.clientWidth,
      sidebarInside: inside(sidebarBox),
      contentInside: inside(contentBox),
      footerInside: inside(footerBox),
      scrollable: scroll.scrollHeight > scroll.clientHeight,
    }
  })
  assert.deepEqual(settingsMetrics, {
    dialogInsideViewport: true,
    noHorizontalOverflow: true,
    sidebarInside: true,
    contentInside: true,
    footerInside: true,
    scrollable: true,
  })
  await dialog.getByRole('textbox', { name: '主题名称' }).fill('ENFP 灵感宇宙')
  await dialog.getByRole('switch', { name: '启用桌面通知' }).click()
  assert.equal(await dialog.getByRole('switch', { name: '启用桌面通知' }).getAttribute('aria-checked'), 'false')
  await dialog.getByRole('combobox', { name: '默认打开方式' }).click()
  const settingsListbox = page.getByRole('listbox', { name: '默认打开方式选项' })
  await settingsListbox.waitFor()
  await assertOpaqueSurface(settingsListbox, 'settings listbox')
  await settingsListbox.getByRole('option', { name: '编辑器' }).click()
  assert.equal(await page.evaluate(() => window.fixtureState.settingsMode), '编辑器')
  await dialog.getByRole('button', { name: '高级' }).click()
  assert.equal(await page.evaluate(() => window.fixtureState.settingsTab), '高级')
  await dialog.locator('.settings-scroll').evaluate((element) => { element.scrollTop = element.scrollHeight })
  await page.screenshot({ path: path.join(outputDir, 'enfp-settings-desktop.png') })
  await dialog.getByRole('button', { name: '重置主题' }).click()
  const confirmDialog = page.getByRole('alertdialog', { name: '重置主题确认' })
  await confirmDialog.waitFor()
  await assertOpaqueSurface(confirmDialog, 'settings confirmation dialog')
  const confirmOverlayBackground = await page.locator('[data-slot="alert-dialog-overlay"]').evaluate(
    (element) => getComputedStyle(element).backgroundColor,
  )
  assert.ok(alphaOf(confirmOverlayBackground) >= 0.3)
  await page.screenshot({ path: path.join(outputDir, 'enfp-settings-confirmation.png') })
  await confirmDialog.getByRole('button', { name: '确认重置' }).click()
  assert.equal(await page.evaluate(() => window.fixtureState.resetConfirmed), true)
  await page.getByRole('button', { name: '确认设置' }).click()
  assert.equal(await page.evaluate(() => window.fixtureState.dialogConfirmed), true)

  await page.getByRole('button', { name: '停止' }).click()
  assert.equal(await page.evaluate(() => window.fixtureState.stopped), true)

  await page.setViewportSize({ width: 900, height: 820 })
  await page.evaluate(() => window.fixtureActions.resetHome())
  await page.waitForFunction(() => document.documentElement.dataset.codexCompassThemePage === 'home')
  await page.waitForFunction(() => document.querySelector('#codex-compass-theme-showcase'))
  const compactMetrics = await page.evaluate(() => ({
    noHorizontalOverflow: document.documentElement.scrollWidth <= document.documentElement.clientWidth,
    titleWrap: getComputedStyle(document.querySelector('.cc-theme-showcase-title')).whiteSpace,
    cards: getComputedStyle(document.querySelector('.cc-theme-showcase-cards')).gridTemplateColumns.split(' ').length,
    noComposerOverlap: document.querySelector('#codex-compass-theme-showcase').getBoundingClientRect().bottom
      <= document.querySelector('.composer-surface-chrome').getBoundingClientRect().top + 1,
    sidebarFillsViewport: Math.abs(document.querySelector('#sidebar').getBoundingClientRect().bottom - window.innerHeight) <= 1,
    accountInsideSidebar: document.querySelector('.cc-theme-shell-account-row').getBoundingClientRect().bottom
      <= document.querySelector('#sidebar').getBoundingClientRect().bottom,
  }))
  assert.equal(compactMetrics.noHorizontalOverflow, true)
  assert.equal(compactMetrics.titleWrap, 'normal')
  assert.equal(compactMetrics.cards, 2)
  assert.equal(compactMetrics.noComposerOverlap, true)
  assert.equal(compactMetrics.sidebarFillsViewport, true)
  assert.equal(compactMetrics.accountInsideSidebar, true)
  await page.screenshot({ path: path.join(outputDir, 'enfp-new-task-compact.png') })
  await page.getByRole('button', { name: '打开设置' }).click()
  const compactDialog = page.getByRole('dialog', { name: 'Codex 设置' })
  await compactDialog.waitFor()
  const compactSettingsMetrics = await compactDialog.evaluate((element) => {
    const rect = element.getBoundingClientRect()
    return {
      insideViewport: rect.left >= 0
        && rect.top >= 0
        && rect.right <= window.innerWidth
        && rect.bottom <= window.innerHeight,
      noHorizontalOverflow: element.scrollWidth <= element.clientWidth,
      sidebarVisible: element.querySelector('.settings-sidebar').getBoundingClientRect().width > 1,
      footerVisible: element.querySelector('.settings-footer').getBoundingClientRect().bottom <= rect.bottom,
    }
  })
  assert.deepEqual(compactSettingsMetrics, {
    insideViewport: true,
    noHorizontalOverflow: true,
    sidebarVisible: true,
    footerVisible: true,
  })
  await page.screenshot({ path: path.join(outputDir, 'enfp-settings-compact.png') })
  await compactDialog.getByRole('button', { name: '确认设置' }).click()

  await page.evaluate(() => {
    const style = document.createElement('style')
    style.textContent = `
      #codex-api-logout-fixture {
        display: block;
        flex-direction: column;
        width: 190px;
        padding: 4px 8px;
        font: 16px/20px "Microsoft YaHei", sans-serif;
        text-align: left;
      }
      #codex-api-logout-fixture svg,
      #codex-api-logout-fixture span {
        display: block;
      }
    `
    document.head.appendChild(style)
    const item = document.createElement('button')
    item.id = 'codex-api-logout-fixture'
    item.dataset.codexApiLogout = 'true'
    item.innerHTML = `
      <svg aria-hidden="true" viewBox="0 0 24 24" width="16" height="16">
        <path d="M10 17l5-5-5-5"></path>
      </svg>
      <span>退出 API 登录</span>
    `
    document.body.appendChild(item)
  })
  await page.addStyleTag({ content: codexApiLogoutCss })
  const logoutMenuMetrics = await page.locator('#codex-api-logout-fixture').evaluate((element) => {
    const icon = element.querySelector('svg')
    const label = element.querySelector('span')
    const elementStyle = getComputedStyle(element)
    const labelStyle = getComputedStyle(label)
    const elementRect = element.getBoundingClientRect()
    const iconRect = icon.getBoundingClientRect()
    const labelRect = label.getBoundingClientRect()
    return {
      display: elementStyle.display,
      flexDirection: elementStyle.flexDirection,
      flexWrap: elementStyle.flexWrap,
      whiteSpace: elementStyle.whiteSpace,
      labelWhiteSpace: labelStyle.whiteSpace,
      height: elementRect.height,
      iconBeforeLabel: iconRect.right <= labelRect.left,
      verticallyAligned: Math.abs(
        (iconRect.top + iconRect.bottom) / 2 - (labelRect.top + labelRect.bottom) / 2,
      ) <= 1,
      labelSingleLine: label.scrollHeight <= label.clientHeight,
    }
  })
  assert.deepEqual(logoutMenuMetrics, {
    display: 'flex',
    flexDirection: 'row',
    flexWrap: 'nowrap',
    whiteSpace: 'nowrap',
    labelWhiteSpace: 'nowrap',
    height: 29,
    iconBeforeLabel: true,
    verticallyAligned: true,
    labelSingleLine: true,
  })

  const settingsPage = await context.newPage()
  settingsPage.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') {
      consoleProblems.push(`settings ${message.type()}: ${message.text()}`)
    }
  })
  settingsPage.on('pageerror', (error) => {
    consoleProblems.push(`settings pageerror: ${error.stack ?? error.message}`)
  })
  await settingsPage.setContent(settingsNavigationFixtureHtml(), { waitUntil: 'domcontentloaded' })
  await settingsPage.addScriptTag({ content: bundle })
  await settingsPage.waitForFunction(() => window.__codexCompassThemeRuntime?.status === 'loaded')
  await settingsPage.waitForTimeout(180)
  assert.equal(await settingsPage.locator('.cc-theme-shell-sidebar').count(), 0)
  assert.equal(await settingsPage.locator('.cc-theme-shell-account-row').count(), 0)
  assert.equal(
    await settingsPage.locator('[data-codex-theme-shell-injected="brand"]').count(),
    0,
  )
  const settingsNavigationMetrics = await settingsPage.evaluate(() => {
    const sidebar = document.querySelector('#settings-navigation')
    const backLink = document.querySelector('#settings-back-link')
    const accountItem = document.querySelector('#settings-account-item')
    const sidebarBox = sidebar.getBoundingClientRect()
    const backBox = backLink.getBoundingClientRect()
    const centerTarget = document.elementFromPoint(
      backBox.left + backBox.width / 2,
      backBox.top + backBox.height / 2,
    )
    return {
      backInsideSidebar: backBox.left >= sidebarBox.left
        && backBox.right <= sidebarBox.right
        && backBox.top >= sidebarBox.top
        && backBox.bottom <= sidebarBox.bottom,
      backHitTarget: centerTarget === backLink || backLink.contains(centerTarget),
      accountUndecorated: !accountItem.classList.contains('cc-theme-shell-account-row'),
      noInjectedBrand: !document.querySelector('[data-codex-theme-shell-injected="brand"]'),
      noHorizontalOverflow: document.documentElement.scrollWidth <= document.documentElement.clientWidth,
    }
  })
  assert.deepEqual(settingsNavigationMetrics, {
    backInsideSidebar: true,
    backHitTarget: true,
    accountUndecorated: true,
    noInjectedBrand: true,
    noHorizontalOverflow: true,
  })
  await settingsPage.getByRole('link', { name: '返回应用' }).click()
  assert.equal(await settingsPage.evaluate(() => window.settingsFixtureState.backClicks), 1)
  await settingsPage.screenshot({ path: path.join(outputDir, 'enfp-settings-navigation-desktop.png') })
  await settingsPage.close()

  assert.deepEqual(consoleProblems, [])
  console.log(`Theme runtime shell E2E passed. Screenshots: ${outputDir}`)
} finally {
  await browser.close()
}

async function buildRuntimeBundle() {
  const command = process.platform === 'win32' ? 'cargo.exe' : 'cargo'
  const child = spawn(
    command,
    ['run', '--quiet', '-p', 'codex-plus-core', '--example', 'theme_runtime_bundle', '--', 'enfp-doodle'],
    { cwd: path.resolve('src-tauri'), stdio: ['ignore', 'pipe', 'pipe'] },
  )
  const stdout = []
  const stderr = []
  child.stdout.on('data', (chunk) => stdout.push(chunk))
  child.stderr.on('data', (chunk) => stderr.push(chunk))
  const exitCode = await new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', resolve)
  })
  assert.equal(exitCode, 0, Buffer.concat(stderr).toString('utf8'))
  return Buffer.concat(stdout).toString('utf8')
}

async function loadCodexApiLogoutCss() {
  const source = await readFile(
    path.resolve('src-tauri/codex-plus/assets/inject/renderer-inject.js'),
    'utf8',
  )
  const match = source.match(
    /\[data-codex-api-logout="true"\]\s*\{[\s\S]*?\}\s*\[data-codex-api-logout="true"\]\s+svg\s*\{[\s\S]*?\}\s*\[data-codex-api-logout="true"\]\s+span\s*\{[\s\S]*?\}/,
  )
  assert.ok(match, 'Codex API logout menu CSS was not found in renderer injection')
  return match[0]
}

async function assertOpaqueSurface(locator, label) {
  const styles = await locator.evaluate((element) => {
    const style = getComputedStyle(element)
    return {
      color: style.color,
      background: style.backgroundColor,
      opacity: style.opacity,
      backdropFilter: style.backdropFilter,
    }
  })
  assert.equal(alphaOf(styles.background), 1, `${label} background was ${styles.background}`)
  assert.equal(styles.opacity, '1', `${label} opacity was ${styles.opacity}`)
  assert.equal(styles.backdropFilter, 'none', `${label} backdrop filter was ${styles.backdropFilter}`)
  const ratio = contrastRatio(styles.color, styles.background)
  assert.ok(ratio >= 4.5, `${label} contrast was ${ratio.toFixed(2)} (${styles.color} on ${styles.background})`)
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
  const light = (color) => {
    const channel = (value) => {
      const normalized = value / 255
      return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4
    }
    return 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b)
  }
  const first = light(blend)
  const second = light(bg)
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05)
}

function settingsNavigationFixtureHtml() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <title>Codex Settings Navigation QA</title>
  <style>
    * { box-sizing: border-box; }
    html, body { width: 100%; height: 100%; margin: 0; overflow: hidden; font-family: "Segoe UI", "Microsoft YaHei", sans-serif; }
    body { color: #242b28; background: #f7f7f4; }
    button, input { font: inherit; }
    #settings-layout { width: 100%; height: 100%; display: flex; }
    .app-shell-left-panel {
      position: relative;
      flex: 0 0 276px;
      width: 276px;
      height: 100%;
      padding: 18px 12px;
      display: flex;
      flex-direction: column;
      gap: 10px;
      border-right: 1px solid #d8dcd8;
      background: #f2f3f0;
    }
    #settings-back-link {
      width: 100%;
      height: 38px;
      padding: 0 12px;
      display: flex;
      align-items: center;
      color: #25312d;
      text-decoration: none;
      border-radius: 6px;
    }
    #settings-search {
      width: 100%;
      height: 36px;
      padding: 0 10px;
      border: 1px solid #cfd5d1;
      border-radius: 6px;
      color: #25312d;
      background: #fff;
    }
    .settings-navigation-list { display: grid; gap: 2px; }
    .settings-navigation-list button {
      width: 100%;
      height: 36px;
      padding: 0 12px;
      border: 0;
      border-radius: 6px;
      color: #33413c;
      background: transparent;
      text-align: left;
    }
    [role="separator"] {
      position: absolute;
      z-index: 2;
      top: 0;
      right: -3px;
      width: 6px;
      height: 100%;
      cursor: col-resize;
    }
    #settings-content {
      min-width: 0;
      flex: 1 1 auto;
      padding: 48px 56px;
      overflow: auto;
      background: #fff;
    }
    #settings-content section { max-width: 760px; }
  </style>
</head>
<body>
  <div id="settings-layout">
    <aside id="settings-navigation" class="app-shell-left-panel">
      <a id="settings-back-link" role="link" href="#app">返回应用</a>
      <input id="settings-search" role="searchbox" aria-label="搜索设置" placeholder="搜索设置">
      <nav class="settings-navigation-list" aria-label="设置导航">
        <button type="button">个人</button>
        <button type="button">常规</button>
        <button type="button">外观</button>
        <button type="button">通知</button>
        <button type="button">MCP 与插件</button>
        <button type="button">宠物</button>
        <button id="settings-account-item" type="button" aria-label="账户">账户</button>
      </nav>
      <div role="separator" aria-label="调整设置导航宽度"></div>
    </aside>
    <main id="settings-content">
      <section>
        <h1>设置</h1>
        <h2>常规</h2>
        <p>完整页面设置导航不应套用 Codex 会话侧栏的主题装饰。</p>
      </section>
    </main>
  </div>
  <script>
    window.settingsFixtureState = { backClicks: 0 };
    document.querySelector('#settings-back-link').addEventListener('click', (event) => {
      event.preventDefault();
      window.settingsFixtureState.backClicks += 1;
    });
  </script>
</body>
</html>`
}

function fixtureHtml() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <title>Codex ENFP Runtime QA</title>
  <style>
    * { box-sizing: border-box; }
    html, body { width: 100%; height: 100%; margin: 0; overflow: hidden; font-family: "Segoe UI", "Microsoft YaHei", sans-serif; }
    body { color: #202a27; background: #fffdf3; }
    button, textarea { font: inherit; }
    button { border: 0; cursor: pointer; }
    svg { width: 17px; height: 17px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
    .app-header-tint { position: fixed; z-index: 50; inset: 0 0 auto; height: 52px; display: flex; align-items: center; border-bottom: 1px solid #dedbd2; background: #fffdf6; }
    .menu-strip { display: flex; align-items: center; gap: 26px; padding-left: 24px; font-size: 14px; }
    .app-title { position: absolute; left: 50%; transform: translateX(-50%); color: #55635e; font-size: 13px; }
    .window-controls { margin-left: auto; height: 100%; display: flex; }
    .window-controls button { width: 48px; height: 100%; display: grid; place-items: center; color: #27332f; background: transparent; }
    .workspace-tools { position: absolute; right: 0; top: 54px; display: flex; pointer-events: none; }
    .workspace-tools button { width: 36px; height: 30px; padding: 0; }
    #sidebar-shell { position: fixed; z-index: 20; left: 0; top: 52px; bottom: 0; width: 286px; border-right: 1px solid #dfe5df; background: white; }
    #sidebar { position: absolute; inset: 0; padding: 8px 12px 12px; }
    #sidebar button { width: 100%; min-height: 34px; padding: 0 10px; display: flex; align-items: center; gap: 9px; color: #2b3834; background: transparent; text-align: left; }
    .sidebar-head { position: relative; }
    .product { width: calc(100% - 42px) !important; font-size: 20px; font-weight: 750; }
    .search { position: absolute; top: 10px; right: 3px; width: 36px !important; padding: 0 !important; justify-content: center; }
    .sidebar-nav { display: grid; gap: 2px; }
    .section-heading { margin-top: 6px; padding: 8px 8px 4px; color: #67746f; font-size: 11px; }
    [data-app-action-sidebar-scroll] { height: calc(100% - 328px); overflow: hidden; }
    [data-app-action-sidebar-project-row], [data-app-action-sidebar-thread-row] { width: 100%; display: flex; align-items: center; overflow-x: hidden; }
    [data-app-action-sidebar-thread-row] button { padding-left: 24px; font-size: 12px; }
    .account { position: absolute; left: 12px; right: 12px; bottom: 10px; width: calc(100% - 24px) !important; }
    #workspace { position: fixed; inset: 52px 0 0 286px; padding-top: 40px; display: flex; flex-direction: column; overflow: hidden; background: #fffdf3; }
    .draggable { position: absolute; z-index: 8; inset: 0 0 auto; height: 40px; display: flex; align-items: center; justify-content: space-between; padding: 0 18px; border-bottom: 1px solid #e5e0d4; background: rgba(255,253,246,.92); }
    .draggable button { min-height: 28px; padding: 0 10px; color: #33423d; background: transparent; }
    #home-structure { position: relative; min-height: 0; flex: 1 1 auto; }
    #home-level-1, #home-level-2, #home-host { width: 100%; height: 100%; }
    #home-host { display: flex; align-items: center; justify-content: center; }
    [data-testid="home-icon"] { position: absolute; width: 1px; height: 1px; opacity: 0; }
    .composer-surface-chrome { position: relative; z-index: 15; width: 86%; min-height: 78px; margin: 0 auto 18px; padding: 12px; display: grid; grid-template-columns: auto minmax(0, 1fr) auto auto; align-items: end; gap: 8px; border: 1px solid #d9d6cd; border-radius: 12px; background: #fff; }
    .composer-surface-chrome textarea { width: 100%; height: 50px; resize: none; border: 0; outline: 0; background: transparent; }
    .composer-surface-chrome button { min-height: 34px; padding: 0 10px; display: flex; align-items: center; gap: 6px; color: #33423d; background: #f6f6f1; }
    .composer-surface-chrome button[aria-label="发送"], .composer-surface-chrome button[aria-label="停止"] { width: 38px; padding: 0; justify-content: center; border-radius: 50%; color: white; background: #12a890; }
    #thread-content { position: relative; min-height: 0; flex: 1 1 auto; padding: 38px 7%; overflow: auto; }
    .thread-column { max-width: 940px; margin: auto; display: grid; gap: 16px; }
    .message { padding: 16px 18px; border: 1px solid #d9e2dd; border-radius: 8px; background: white; }
    pre, [data-testid="diff-view"], [data-testid="terminal-panel"], .monaco-editor { margin: 0; padding: 16px; border: 1px solid #d2dad6; border-radius: 7px; color: #20302b; background: #eef5f1; white-space: pre-wrap; }
    .monaco-editor .margin { display: inline-block; min-width: 34px; margin-right: 10px; padding: 0; }
    [data-testid="diff-view"] .removed { color: #9d2d2d; }
    [data-testid="diff-view"] .added { color: #126b52; }
    #model-menu, #attach-popover, #settings-select { position: fixed; z-index: 1000; right: 120px; bottom: 112px; min-width: 230px; padding: 8px; border: 1px solid #d8ddd9; border-radius: 8px; background: white; }
    #model-menu button, #attach-popover button, #settings-select button { width: 100%; min-height: 36px; padding: 0 10px; color: #27332f; background: transparent; text-align: left; }
    #attach-popover { right: auto; left: 390px; }
    #settings-select { z-index: 1400; right: 190px; bottom: 230px; }
     [data-slot="dialog-overlay"], [data-slot="alert-dialog-overlay"] { position: fixed; z-index: 1200; inset: 0; display: grid; place-items: center; background: rgba(20,28,25,.38); }
     [data-slot="alert-dialog-overlay"] { z-index: 1500; }
     [role="dialog"], [role="alertdialog"] { color: #27332f; border: 1px solid #d8ddd9; border-radius: 9px; background: white; }
     [role="dialog"] button, [role="alertdialog"] button { min-height: 34px; padding: 0 12px; color: #27332f; background: #e8f8ef; }
      #project-context-menu { position: fixed; z-index: 1600; top: 150px; left: 310px; width: 240px; padding: 6px; border: 1px solid #d8ddd9; border-radius: 8px; background: white; }
      #project-context-menu [role="menuitem"] { min-height: 34px; padding: 6px 9px; display: flex; align-items: center; gap: 9px; }
      #project-context-menu svg { width: 16px; height: 16px; fill: none; stroke: currentColor; }
      #project-info-overlay { position: fixed; z-index: 1599; inset: 0; background: transparent; }
      #project-info-popover { position: fixed; z-index: 1601; top: 230px; left: 380px; width: 480px; padding: 16px; border: 1px solid #d8ddd9; border-radius: 12px; background: white; box-shadow: 0 16px 42px rgba(32,42,39,.18); }
      #top-page-action { position: relative; z-index: 1; }
      #archive-confirm-layer { position: fixed; z-index: 1800; inset: 0; display: grid; place-items: center; background: rgba(20,28,25,.38); }
     #project-rename-dialog { position: fixed; z-index: 1601; left: 50%; bottom: 0; width: 520px; padding: 20px; transform: translateX(-50%); }
     #project-rename-dialog h2, #project-rename-dialog p { margin: 0; }
     #project-rename-dialog input { box-sizing: border-box; }
     #image-preview-overlay { position: fixed; z-index: 1700; inset: 0; background: rgba(0,0,0,.9); }
    #image-preview-dialog { position: fixed; z-index: 1701; inset: 0; width: 100vw; height: 100dvh; padding: 48px 80px 32px; display: flex; flex-direction: column; align-items: center; border: 0; border-radius: 0; background: transparent; }
     #image-preview-dialog > .preview-actions { position: absolute; z-index: 10; top: 88px; right: 24px; display: flex; gap: 8px; }
     #image-preview-dialog > .preview-actions :is(a, button) { width: 40px; height: 40px; padding: 0; display: grid; place-items: center; color: #17211e; border: 1px solid #c7d4cf; border-radius: 50%; background: #fff; text-decoration: none; }
     #image-preview-dialog > .preview-actions :is(a, button) svg { width: 24px; height: 24px; display: block; }
     #image-preview-dialog > .preview-actions :is(a, button):hover { color: #fff; background: #d92d20; }
    #image-preview-scroll { width: 100%; min-height: 0; flex: 1; display: flex; align-items: center; justify-content: center; overflow: auto; }
    #image-preview-image { width: min(960px, calc(100vw - 160px)); height: min(640px, calc(100dvh - 160px)); display: block; object-fit: contain; background: #ecfff6; }
    #image-preview-caption { margin-top: 16px; padding: 8px 14px; border-radius: 16px; color: #27332f; background: rgba(255,255,255,.95); }
    #settings-dialog { width: min(900px, calc(100% - 48px)); height: min(680px, calc(100% - 64px)); padding: 0; display: grid; grid-template-columns: 190px minmax(0, 1fr); overflow: hidden; }
    .settings-sidebar { min-width: 0; padding: 18px 12px; display: flex; flex-direction: column; gap: 6px; border-right: 1px solid #d8ddd9; background: #f4f7f4; }
    .settings-sidebar h2 { margin: 0 8px 12px; font-size: 18px; }
    .settings-sidebar button { width: 100%; justify-content: flex-start; background: transparent; text-align: left; }
    .settings-sidebar button[aria-current="page"] { background: #dff5ee; }
    .settings-content { min-width: 0; min-height: 0; display: grid; grid-template-rows: auto minmax(0, 1fr) auto; background: white; }
    .settings-title { padding: 18px 22px 14px; border-bottom: 1px solid #d8ddd9; }
    .settings-title h3, .settings-title p { margin: 0; }
    .settings-title p { margin-top: 5px; color: #63706b; }
    .settings-scroll { min-width: 0; min-height: 0; padding: 18px 22px; display: grid; align-content: start; gap: 14px; overflow: auto; }
    .settings-section { padding-bottom: 14px; display: grid; gap: 10px; border-bottom: 1px solid #e1e7e3; }
    .settings-section h4, .settings-section p { margin: 0; }
    .settings-section p { color: #63706b; }
    .settings-row { min-width: 0; display: grid; grid-template-columns: minmax(0, 1fr) minmax(180px, 280px); align-items: center; gap: 18px; }
    .settings-row label, .settings-copy { min-width: 0; display: grid; gap: 4px; }
    .settings-row input, .settings-row textarea, .settings-row [role="combobox"] { width: 100%; min-height: 38px; padding: 8px 10px; color: #27332f; border: 1px solid #cdd8d2; background: #f5f8f6; }
    .settings-row textarea { min-height: 70px; resize: vertical; }
    .settings-row [role="switch"] { width: 46px; min-width: 46px; height: 26px; min-height: 26px; padding: 3px; justify-self: end; border: 1px solid #b9cbc3; border-radius: 999px; background: #12a890; }
    .settings-row [role="switch"] span { width: 18px; height: 18px; display: block; border-radius: 50%; background: white; transform: translateX(18px); }
    .settings-row [role="switch"][aria-checked="false"] { background: #e4ebe7; }
    .settings-row [role="switch"][aria-checked="false"] span { transform: translateX(0); }
    .settings-footer { padding: 14px 22px; display: flex; justify-content: flex-end; gap: 8px; border-top: 1px solid #d8ddd9; background: white; }
    #reset-dialog { width: min(440px, calc(100% - 40px)); padding: 22px; }
    #reset-dialog h3, #reset-dialog p { margin-top: 0; }
    #reset-dialog footer { margin-top: 18px; display: flex; justify-content: flex-end; gap: 8px; }
    [hidden] { display: none !important; }
    @media (max-width: 1240px) {
      #sidebar-shell { width: 244px; }
      #workspace { left: 244px; }
      .composer-surface-chrome { width: 92%; }
      #settings-dialog { grid-template-columns: 160px minmax(0, 1fr); }
      .settings-row { grid-template-columns: minmax(0, 1fr) minmax(150px, 230px); }
    }
  </style>
</head>
<body>
  <header class="app-header-tint" role="banner">
    <div class="menu-strip"><span>文件</span><span>编辑</span><span>视图</span><span>帮助</span></div>
    <div class="app-title">Codex Compass 1.3.52</div>
    <div class="window-controls">
      <button type="button" aria-label="最小化" data-window-action="minimize"><svg viewBox="0 0 20 20"><path d="M4 10h12"/></svg></button>
      <button type="button" aria-label="最大化或还原" data-window-action="maximize"><svg viewBox="0 0 20 20"><rect x="5" y="5" width="10" height="10"/></svg></button>
      <button type="button" aria-label="关闭" data-window-action="close"><svg viewBox="0 0 20 20"><path d="m5 5 10 10M15 5 5 15"/></svg></button>
    </div>
    <div class="workspace-tools">
      <button type="button" aria-label="切换置顶摘要">置顶</button>
      <button type="button" aria-label="切换底部面板">面板</button>
      <button type="button" aria-label="显示或隐藏侧边栏">侧栏</button>
    </div>
  </header>
  <aside id="sidebar-shell">
  <nav id="sidebar" data-slot="sidebar">
    <div class="sidebar-head">
      <button type="button" class="product" aria-haspopup="menu">Codex</button>
      <button type="button" class="search" aria-label="搜索"><svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="m16 16 4 4"/></svg></button>
    </div>
    <div class="sidebar-nav">
      <button type="button"><svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>新建任务</button>
      <button type="button" aria-label="已安排"><svg viewBox="0 0 24 24"><rect x="4" y="5" width="16" height="15" rx="2"/><path d="M8 3v4M16 3v4M4 10h16"/></svg>已安排</button>
      <button type="button" aria-label="技能"><svg viewBox="0 0 24 24"><path d="m12 3 8 4.5v9L12 21l-8-4.5v-9Z"/><path d="m4 7.5 8 4.5 8-4.5M12 12v9"/></svg>技能</button>
      <button type="button" aria-label="站点"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18"/></svg>站点</button>
      <button type="button" aria-label="拉取请求"><svg viewBox="0 0 24 24"><circle cx="6" cy="5" r="2"/><circle cx="18" cy="19" r="2"/><path d="M6 7v10a2 2 0 0 0 2 2h8M18 17V8a3 3 0 0 0-3-3h-3M12 2v6l3-3Z"/></svg>拉取请求</button>
    </div>
    <div class="section-heading" data-app-action-sidebar-section-heading>项目</div>
    <div data-app-action-sidebar-scroll>
      <div data-app-action-sidebar-project-row><button type="button"><svg viewBox="0 0 24 24"><path d="M3 7h7l2 2h9v10H3Z"/></svg>ENFP 小宇宙项目</button></div>
      <div data-app-action-sidebar-thread-row data-app-action-sidebar-thread-active="true"><button type="button">灵感收集站</button></div>
      <div data-app-action-sidebar-thread-row><button type="button">脑暴草稿箱</button></div>
      <div data-app-action-sidebar-thread-row><button type="button">创意实验室</button></div>
      <div data-app-action-sidebar-thread-row><button type="button">组件游乐场</button></div>
      <div data-app-action-sidebar-thread-row><button type="button">最终落地版</button></div>
      <div class="section-heading" data-app-action-sidebar-section-heading>任务</div>
      <div data-app-action-sidebar-thread-row><button type="button">做一个会说话的按钮</button></div>
      <div data-app-action-sidebar-thread-row><button type="button">把想法倒成小 Demo</button></div>
      <div data-app-action-sidebar-thread-row><button type="button">重构一下更丝滑</button></div>
      <div data-app-action-sidebar-thread-row><button type="button">修复那个烦人的 Bug</button></div>
    </div>
  </nav>
    <button type="button" class="account" aria-label="打开个人资料菜单" aria-haspopup="menu"><svg viewBox="0 0 24 24"><circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/></svg>小宇宙发射中</button>
  </aside>
  <main id="workspace" role="main">
    <div id="home-structure">
      <div id="home-level-1"><div id="home-level-2"><div id="home-host"><span data-testid="home-icon" /></div></div></div>
    </div>
    <div class="draggable">
      <strong>新任务</strong>
      <button id="top-page-action" type="button" aria-label="归档后页面操作">页面操作</button>
      <button type="button" aria-label="打开设置">打开设置</button>
    </div>
    <div class="composer-surface-chrome">
      <button type="button" aria-label="添加文件等内容"><svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg></button>
      <textarea aria-label="任务输入" placeholder="对 ENFP 助手说点什么…"></textarea>
      <button type="button" data-codex-intelligence-trigger="true" aria-label="选择模型">gpt-5.6-sol</button>
      <button type="button" aria-label="发送"><svg viewBox="0 0 24 24"><path d="m5 12 7-7 7 7M12 5v14"/></svg></button>
    </div>
  </main>
  <div id="model-menu" role="menu" hidden>
    <button type="button" role="menuitem">gpt-5.6-sol</button>
    <button type="button" role="menuitem">gpt-5.6-luna</button>
    <button type="button" role="menuitem">gpt-5.6-terra</button>
  </div>
  <div id="attach-popover" data-slot="popover-content" hidden>
    <strong>添加上下文</strong>
    <button type="button">选择本地文件</button>
  </div>
  <div id="dialog-layer" data-slot="dialog-overlay" hidden>
    <section id="settings-dialog" role="dialog" data-slot="dialog-content" aria-label="Codex 设置">
      <aside class="settings-sidebar" aria-label="设置导航">
        <h2>Codex 设置</h2>
        <button type="button" data-settings-tab="常规" aria-current="page">常规</button>
        <button type="button" data-settings-tab="外观">外观</button>
        <button type="button" data-settings-tab="编辑器">编辑器</button>
        <button type="button" data-settings-tab="MCP 与插件">MCP 与插件</button>
        <button type="button" data-settings-tab="高级">高级</button>
      </aside>
      <div class="settings-content" data-slot="content">
        <header class="settings-title">
          <h3>常规</h3>
          <p>检查主题应用后的设置导航、控件和滚动内容。</p>
        </header>
        <div class="settings-scroll" data-slot="scroll-area-viewport">
          <section class="settings-section">
            <h4>界面</h4>
            <div class="settings-row">
              <label for="settings-theme-name">
                <strong>主题名称</strong>
                <span>用于识别当前 Codex 外观。</span>
              </label>
              <input id="settings-theme-name" aria-label="主题名称" value="ENFP 灵感宇宙">
            </div>
            <div class="settings-row">
              <div class="settings-copy">
                <strong>默认打开方式</strong>
                <span>选择任务默认打开的位置。</span>
              </div>
              <button type="button" role="combobox" aria-label="默认打开方式" aria-expanded="false">工作区</button>
            </div>
            <div class="settings-row">
              <div class="settings-copy">
                <strong>启用桌面通知</strong>
                <span>任务完成时显示系统通知。</span>
              </div>
              <button type="button" role="switch" aria-label="启用桌面通知" aria-checked="true"><span></span></button>
            </div>
          </section>
          <section class="settings-section">
            <h4>编辑器</h4>
            <div class="settings-row">
              <label for="settings-font-size">
                <strong>字体大小</strong>
                <span>设置代码与终端的显示字号。</span>
              </label>
              <input id="settings-font-size" aria-label="字体大小" type="number" value="14">
            </div>
            <div class="settings-row">
              <label for="settings-note">
                <strong>自定义说明</strong>
                <span>添加显示在任务页中的说明。</span>
              </label>
              <textarea id="settings-note" aria-label="自定义说明">保持所有操作区域清晰可读。</textarea>
            </div>
          </section>
          <section class="settings-section">
            <h4>MCP 与插件</h4>
            <p>插件列表、状态按钮和错误信息必须保持不透明且具备足够对比度。</p>
            <div class="settings-row">
              <div class="settings-copy">
                <strong>本地工具连接</strong>
                <span>已连接，等待下一次调用。</span>
              </div>
              <button type="button">管理插件</button>
            </div>
          </section>
          <section class="settings-section">
            <h4>高级</h4>
            <p>滚动到底部后，固定操作栏仍应完整可见。</p>
          </section>
        </div>
        <footer class="settings-footer">
          <button type="button" aria-label="重置主题">重置主题</button>
          <button type="button" aria-label="确认设置">确认</button>
        </footer>
      </div>
    </section>
  </div>
  <div id="settings-select" role="listbox" aria-label="默认打开方式选项" hidden>
    <button type="button" role="option">工作区</button>
    <button type="button" role="option">编辑器</button>
    <button type="button" role="option">新窗口</button>
  </div>
  <div id="confirm-layer" data-slot="alert-dialog-overlay" hidden>
    <section id="reset-dialog" role="alertdialog" data-slot="alert-dialog-content" aria-label="重置主题确认">
      <h3>重置当前主题？</h3>
      <p>这会恢复 ENFP 主题的默认排版与颜色。</p>
      <footer>
        <button type="button" aria-label="取消重置">取消</button>
        <button type="button" aria-label="确认重置">确认重置</button>
      </footer>
    </section>
  </div>
  <div id="project-context-menu" role="menu" hidden>
    <div role="menuitem"><svg viewBox="0 0 24 24"><path d="m12 3 3 6 6 .8-4.4 4.3 1 6-5.6-2.8-5.6 2.8 1-6L3 9.8 9 9Z"/></svg>置顶项目</div>
    <div role="menuitem"><svg viewBox="0 0 24 24"><path d="M4 5h16v14H4Z"/><path d="M8 9h8M8 13h5"/></svg>在资源管理器中打开</div>
    <div role="menuitem"><svg viewBox="0 0 24 24"><path d="m4 16 9-9 5 5-9 9H4Z"/><path d="m14 6 2-2 4 4-2 2"/></svg>重命名项目</div>
    <div role="menuitem"><svg viewBox="0 0 24 24"><path d="M5 4h14v16H5Z"/><path d="M8 8h8M8 12h8M8 16h5"/></svg>归档任务</div>
  </div>
  <div id="project-info-overlay" hidden></div>
  <section id="project-info-popover" hidden>
    <strong>ENFP 小宇宙项目</strong>
    <p>3 个对话串</p>
    <p>C:\\Users\\ExampleUser\\Desktop\\markdown2pdf</p>
  </section>
  <div id="archive-confirm-layer" hidden>
    <section id="archive-confirmation" role="alertdialog" aria-label="归档任务确认">
      <h3>确认归档任务？</h3>
      <button type="button">确认归档</button>
    </section>
  </div>
  <div id="project-rename-overlay" data-slot="dialog-overlay" hidden></div>
  <section id="project-rename-dialog" role="dialog" data-slot="dialog-content" aria-label="重命名项目" hidden>
    <button type="button" aria-label="关闭">×</button>
    <h2>重命名项目</h2>
    <p>保持简短且易于识别</p>
    <input type="text" value="ENFP 小宇宙项目" aria-label="项目名称">
    <div class="project-rename-actions">
      <button type="button">取消</button>
      <button type="button">保存</button>
    </div>
  </section>
  <div id="image-preview-overlay" class="codex-dialog-overlay" data-state="open" hidden></div>
  <div id="image-preview-dialog" class="codex-dialog fixed pointer-events-none inset-0" role="dialog" aria-label="图片预览" data-state="open" hidden>
    <div class="preview-actions">
      <a href="data:image/png;base64,AA==" download="runtime-preview.png" aria-label="下载图片"><svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3v12m0 0l-4-4m4 4l4-4M5 21h14"/></svg></a>
       <button type="button" aria-label="关闭图片预览"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg></button>
    </div>
    <div id="image-preview-scroll">
      <img id="image-preview-image" alt="" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='960' height='600' viewBox='0 0 960 600'%3E%3Crect width='960' height='600' fill='%23dff8ee'/%3E%3Ccircle cx='480' cy='260' r='130' fill='%2312a890'/%3E%3Cpath d='M180 480h600' stroke='%2327332f' stroke-width='24'/%3E%3C/svg%3E">
    </div>
    <div id="image-preview-caption">图片预览 · 100%</div>
  </div>
  <script>
    window.fixtureState = {
      windowClicks: [],
      composerInputs: 0,
      model: '',
      attachments: 0,
      dialogConfirmed: false,
      settingsEnabled: true,
      settingsMode: '工作区',
      settingsTab: '常规',
      resetConfirmed: false,
      stopped: false,
      archiveClicks: 0,
      archiveFollowupClicks: 0,
      showArchiveConfirmation: false,
    };
    const workspace = document.querySelector('#workspace');
    const composer = document.querySelector('.composer-surface-chrome');
    const sendButton = composer.querySelector('button[aria-label="发送"]');
    const textarea = composer.querySelector('textarea');
    const homeMarkup = document.querySelector('#home-structure').outerHTML;
    const icon = (path) => '<svg viewBox="0 0 24 24"><path d="' + path + '"/></svg>';
    document.querySelectorAll('[data-window-action]').forEach((button) => {
      button.addEventListener('click', () => window.fixtureState.windowClicks.push(button.dataset.windowAction));
    });
    textarea.addEventListener('input', () => { window.fixtureState.composerInputs += 1; });
    composer.querySelector('[data-codex-intelligence-trigger="true"]').addEventListener('click', () => {
      document.querySelector('#model-menu').hidden = false;
    });
    document.querySelectorAll('#model-menu [role="menuitem"]').forEach((item) => {
      item.addEventListener('click', () => {
        window.fixtureState.model = item.textContent.trim();
        document.querySelector('#model-menu').hidden = true;
      });
    });
    composer.querySelector('button[aria-label="添加文件等内容"]').addEventListener('click', () => {
      document.querySelector('#attach-popover').hidden = false;
    });
    document.querySelector('#attach-popover button').addEventListener('click', () => {
      window.fixtureState.attachments += 1;
      document.querySelector('#attach-popover').hidden = true;
    });
    document.querySelector('button[aria-label="打开设置"]').addEventListener('click', () => {
      document.querySelector('#dialog-layer').hidden = false;
      document.querySelector('.settings-scroll').scrollTop = 0;
    });
    document.querySelector('#project-context-menu [role="menuitem"]:last-child').addEventListener('click', () => {
      window.fixtureState.archiveClicks += 1;
      document.querySelector('#project-context-menu').hidden = true;
      document.querySelector('#project-info-overlay').hidden = false;
      document.querySelector('#project-info-popover').hidden = false;
      if (window.fixtureState.showArchiveConfirmation) {
        document.querySelector('#archive-confirm-layer').hidden = false;
      }
    });
    document.querySelector('#top-page-action').addEventListener('click', () => {
      window.fixtureState.archiveFollowupClicks += 1;
    });
    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      document.querySelector('#project-context-menu').hidden = true;
      document.querySelector('#project-info-overlay').hidden = true;
      document.querySelector('#project-info-popover').hidden = true;
    });
    document.querySelector('button[aria-label="确认设置"]').addEventListener('click', () => {
      window.fixtureState.dialogConfirmed = true;
      document.querySelector('#dialog-layer').hidden = true;
    });
    document.querySelectorAll('[data-settings-tab]').forEach((button) => {
      button.addEventListener('click', () => {
        document.querySelectorAll('[data-settings-tab]').forEach((item) => item.removeAttribute('aria-current'));
        button.setAttribute('aria-current', 'page');
        window.fixtureState.settingsTab = button.dataset.settingsTab;
        document.querySelector('.settings-title h3').textContent = button.dataset.settingsTab;
      });
    });
    const settingsSwitch = document.querySelector('[role="switch"][aria-label="启用桌面通知"]');
    settingsSwitch.addEventListener('click', () => {
      const enabled = settingsSwitch.getAttribute('aria-checked') !== 'true';
      settingsSwitch.setAttribute('aria-checked', String(enabled));
      window.fixtureState.settingsEnabled = enabled;
    });
    const settingsCombobox = document.querySelector('[role="combobox"][aria-label="默认打开方式"]');
    settingsCombobox.addEventListener('click', () => {
      settingsCombobox.setAttribute('aria-expanded', 'true');
      document.querySelector('#settings-select').hidden = false;
    });
    document.querySelectorAll('#settings-select [role="option"]').forEach((option) => {
      option.addEventListener('click', () => {
        window.fixtureState.settingsMode = option.textContent.trim();
        settingsCombobox.textContent = window.fixtureState.settingsMode;
        settingsCombobox.setAttribute('aria-expanded', 'false');
        document.querySelector('#settings-select').hidden = true;
      });
    });
    document.querySelector('button[aria-label="重置主题"]').addEventListener('click', () => {
      document.querySelector('#confirm-layer').hidden = false;
    });
    document.querySelector('button[aria-label="取消重置"]').addEventListener('click', () => {
      document.querySelector('#confirm-layer').hidden = true;
    });
    document.querySelector('button[aria-label="确认重置"]').addEventListener('click', () => {
      window.fixtureState.resetConfirmed = true;
      document.querySelector('#confirm-layer').hidden = true;
    });
    document.querySelector('button[aria-label="关闭图片预览"]').addEventListener('click', () => {
      document.querySelector('#image-preview-overlay').hidden = true;
      document.querySelector('#image-preview-dialog').hidden = true;
    });
    function showThread() {
      document.querySelector('#home-structure')?.remove();
      const thread = document.createElement('section');
      thread.id = 'thread-content';
      thread.innerHTML = '<div class="thread-column">' +
        '<article class="message"><strong>用户</strong><p>检查主题下的代码、差异和终端是否清晰。</p></article>' +
        '<article class="message"><strong>Codex</strong><p>已完成独立运行时可读性检查。</p></article>' +
        '<pre><code>function themeReady() {\\n  return true;\\n}</code></pre>' +
        '<div data-testid="diff-view"><div class="removed">- background: transparent;</div><div class="added">+ background: var(--surface);</div></div>' +
        '<div class="monaco-editor"><span class="margin">12</span><span>const readable = true;</span></div>' +
        '<div data-testid="terminal-panel">PS D:\\\\PublicProject&gt; npm run verify\\nAll checks passed.</div>' +
        '<button type="button" aria-label="打开图片预览" data-markdown-image-preview-trigger="true">打开图片预览</button>' +
        '</div>';
      workspace.insertBefore(thread, composer);
      thread.querySelector('[data-markdown-image-preview-trigger="true"]').addEventListener('click', () => {
        document.querySelector('#image-preview-overlay').hidden = false;
        document.querySelector('#image-preview-dialog').hidden = false;
      });
      sendButton.setAttribute('aria-label', '停止');
      sendButton.innerHTML = icon('M7 7h10v10H7z');
      window.__codexCompassThemeRuntime?.syncShowcase?.();
    }
    function resetHome() {
      document.querySelector('#thread-content')?.remove();
      workspace.insertAdjacentHTML('beforeend', homeMarkup);
      workspace.insertBefore(document.querySelector('#home-structure'), workspace.firstElementChild);
      sendButton.setAttribute('aria-label', '发送');
      sendButton.innerHTML = icon('m5 12 7-7 7 7M12 5v14');
      window.__codexCompassThemeRuntime?.syncShowcase?.();
    }
    sendButton.addEventListener('click', () => {
      if (sendButton.getAttribute('aria-label') === '停止') {
        window.fixtureState.stopped = true;
        return;
      }
      showThread();
    });
    window.fixtureActions = { showThread, resetHome };
  </script>
</body>
</html>`
}
