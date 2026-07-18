import assert from 'node:assert/strict'
import { readFile, readdir, rm, rmdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { chromium } from 'playwright'

const appData = process.env.APPDATA
if (!appData) throw new Error('APPDATA is unavailable')

const workspaceRoot = path.resolve('.')
const uploadRoot = path.join(workspaceRoot, '.codex-compass', 'uploads')
const remoteRoot = path.join(appData, 'chat.ai-api.relay-meter', 'remote-control')
const settings = JSON.parse(await readFile(path.join(remoteRoot, 'settings.json'), 'utf8'))
const sensitive = JSON.parse(
  await readFile(path.join(remoteRoot, 'sensitive', 'credentials.json'), 'utf8'),
)
assert.equal(settings.enabled, true, 'remote control must be enabled')
assert.equal(settings.paused, false, 'remote control must not be paused')

const attachmentToken = `CODEX_COMPASS_137_ATTACHMENT_OK_${Date.now()}`
const continueToken = `CODEX_COMPASS_137_CONTINUE_OK_${Date.now()}`
const beforeUploadDirectories = new Set(await listDirectoryNames(uploadRoot))
const consoleErrors = []
const screenshots = [
  path.join(tmpdir(), 'codex-compass-remote-live-137-interaction-complete.png'),
  path.join(tmpdir(), 'codex-compass-remote-live-137-interaction-continued.png'),
  path.join(tmpdir(), 'codex-compass-remote-live-137-interaction-interrupted.png'),
]
const failureScreenshot = path.join(
  tmpdir(),
  'codex-compass-remote-live-137-interaction-failed.png',
)
const preferredModel = 'gpt-5.6-luna'
let selectedModel = ''
let selectedSkill = ''
let result = null

const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 390, height: 844 } })
page.setDefaultTimeout(30_000)
page.on('console', (message) => {
  if (message.type() === 'error') consoleErrors.push(message.text())
})
page.on('pageerror', (error) => consoleErrors.push(error.message))

const url = new URL(settings.publicWebUrl)
url.searchParams.set('room', settings.roomId)
url.searchParams.set('desktop', settings.desktopDeviceId)
url.hash = new URLSearchParams({
  token: sensitive.accessToken,
  key: sensitive.encryptionKey,
}).toString()

try {
  await page.goto(url.toString())
  await page.locator('#deviceView').waitFor({ state: 'visible', timeout: 20_000 })
  await page.locator('#connectionBadge').filter({ hasText: '中继已连接' }).waitFor()
  await page.waitForFunction(() => {
    const text = document.querySelector('#sessionSummary')?.textContent || ''
    return text && !text.includes('正在同步')
  }, null, { timeout: 30_000 })

  await page.locator('[data-view="new"]').click()
  const workspaceId = await page.locator('#workspaceSelect option').evaluateAll((options) => (
    options.find((option) => option.textContent?.includes('Codex-Compass'))?.value || ''
  ))
  assert.ok(workspaceId, 'Codex-Compass workspace is unavailable')
  await page.locator('#workspaceSelect').selectOption(workspaceId)
  await page.waitForFunction(() => document.querySelectorAll('#modelSelect option').length > 1)
  const modelOptions = await page.locator('#modelSelect option').evaluateAll((options) => (
    options
      .map((option) => ({ value: option.value, label: option.textContent?.trim() || '' }))
      .filter((option) => option.value)
  ))
  const model = modelOptions.find((option) => option.value === preferredModel)
    || modelOptions.find((option) => option.value.startsWith(`${preferredModel}--cc-`))
    || modelOptions[0]
  assert.ok(model, 'no selectable Codex model is available')
  selectedModel = model.value
  await page.locator('#modelSelect').selectOption(selectedModel)
  await assertEnabled(page.locator('#newAttachmentButton'), 'workspace upload permission was not refreshed')

  await page.locator('#newSkillButton').click()
  await page.locator('#capabilityDialog').waitFor({ state: 'visible' })
  await page.waitForFunction(() => {
    const text = document.querySelector('#capabilityList')?.textContent || ''
    return text && !text.includes('正在读取')
  }, null, { timeout: 30_000 })
  await page.locator('#capabilitySearch').fill('playwright')
  const skillSection = page.locator('.capability-section').filter({
    has: page.locator('h3', { hasText: '可用技能' }),
  })
  const skillRow = skillSection.locator('[data-capability-name="playwright"]').first()
  await skillRow.waitFor({ state: 'visible' })
  selectedSkill = (await skillRow.locator('strong').textContent())?.trim() || 'playwright'
  await skillRow.locator('input[type="checkbox"]').check()
  await page.locator('#capabilitySelectionCount').filter({ hasText: '已选择 1 / 8' }).waitFor()
  await page.locator('#confirmCapabilityDialog').click()
  await page.locator('#newSelectionTray').filter({ hasText: selectedSkill }).waitFor()

  await page.locator('#newAttachmentInput').setInputFiles({
    name: 'remote-live-137.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from(`${attachmentToken}\n`, 'utf8'),
  })
  await page.locator('#newSelectionTray').filter({ hasText: 'remote-live-137.txt' }).waitFor()
  await page.locator('#newSessionPrompt').fill(
    '请读取我上传的文本文件，只回复文件中那一行完整内容。'
    + '允许进行一次只读文件读取；不要修改任何文件，不要执行其他命令，不要解释所选 Skill。',
  )
  await installStreamObserver(page)
  await page.locator('#createSessionButton').click()
  await page.locator('#conversationView').waitFor({ state: 'visible' })
  const createdSessionId = await page.locator('#conversationView').getAttribute('data-session-id')
  assert.ok(createdSessionId, 'new remote session id was not exposed to the web client')
  await waitForAssistantText(page, attachmentToken, 120_000)
  await page.locator('#conversationState').filter({ hasText: '任务已完成' }).waitFor({
    timeout: 120_000,
  })

  const firstResponse = await lastAssistantText(page)
  const firstStreamSnapshots = await page.evaluate(() => window.__remoteLive137Stream || [])
  assert.ok(firstResponse.includes(attachmentToken), 'Codex did not return the attachment token')
  assert.ok(
    firstStreamSnapshots.some((snapshot) => snapshot.text && snapshot.state !== '任务已完成'),
    'no response.delta DOM update was observed before completion',
  )
  await page.screenshot({ path: screenshots[0], fullPage: false })

  await page.locator('#backButton').click()
  await page.locator('#deviceView').waitFor({ state: 'visible' })
  const matchingSession = page.locator(`.session-row[data-session-id="${createdSessionId}"]`)
  try {
    await matchingSession.waitFor({ state: 'visible', timeout: 15_000 })
  } catch {
    await page.locator('#sessionSearch').fill(createdSessionId)
    await matchingSession.waitFor({ state: 'visible', timeout: 60_000 })
  }
  const reopenedSessionTitle = (await matchingSession.locator('strong').textContent())?.trim() || ''
  await matchingSession.click()
  await page.locator('#conversationState').filter({ hasText: '历史已同步' }).waitFor({
    timeout: 60_000,
  })
  await page.locator('#messageList').filter({ hasText: attachmentToken }).waitFor()

  await page.locator('#messageInput').fill(`仅回复 ${continueToken}`)
  await page.locator('#composer').evaluate((form) => form.requestSubmit())
  await waitForAssistantText(page, continueToken, 120_000)
  await page.locator('#conversationState').filter({ hasText: '任务已完成' }).waitFor({
    timeout: 120_000,
  })
  const continueResponse = await lastAssistantText(page)
  assert.ok(continueResponse.includes(continueToken), 'existing session continuation failed')
  await page.screenshot({ path: screenshots[1], fullPage: false })

  await page.locator('#messageInput').fill(
    '请持续输出从 1 开始的整数，每行一个，至少输出 10000 行，不要解释。',
  )
  await page.locator('#composer').evaluate((form) => form.requestSubmit())
  await page.locator('#stopButton').waitFor({ state: 'visible', timeout: 60_000 })
  await page.locator('#stopButton').click()
  await page.locator('#conversationState').filter({ hasText: '已停止生成' }).waitFor({
    timeout: 60_000,
  })
  await page.screenshot({ path: screenshots[2], fullPage: false })

  assert.deepEqual(consoleErrors, [])
  result = {
    ok: true,
    workspace: 'Codex-Compass',
    selectedModel,
    selectedSkill,
    attachmentToken,
    firstResponse,
    streamUpdatesBeforeCompletion: firstStreamSnapshots.length,
    reopenedSessionTitle,
    continueToken,
    continueResponse,
    interruptState: await page.locator('#conversationState').textContent(),
    consoleErrors,
    screenshots,
  }
} catch (error) {
  try {
    await page.screenshot({ path: failureScreenshot, fullPage: false })
  } catch {
    // The page may already be unavailable.
  }
  result = {
    ok: false,
    selectedModel,
    selectedSkill,
    error: error?.message || String(error),
    conversationState: await page.locator('#conversationState').textContent().catch(() => null),
    messages: await page.locator('#messageList .message').allTextContents().catch(() => []),
    toast: await page.locator('#toast').textContent().catch(() => null),
    consoleErrors,
    screenshots: [failureScreenshot],
  }
  process.exitCode = 1
} finally {
  try {
    if (await page.locator('#stopButton').isVisible()) {
      await page.locator('#stopButton').click({ timeout: 5_000 })
    }
  } catch {
    // Best-effort interruption if a failed assertion left a turn running.
  }
  await browser.close()
  const cleanedUploadDirectories = await cleanupNewUploadDirectories(
    uploadRoot,
    beforeUploadDirectories,
  )
  if (result) result.cleanedUploadDirectories = cleanedUploadDirectories
}

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)

async function listDirectoryNames(root) {
  try {
    return await readdir(root)
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
}

async function cleanupNewUploadDirectories(root, before) {
  const current = await listDirectoryNames(root)
  const cleaned = []
  const resolvedRoot = path.resolve(root)
  for (const name of current) {
    if (before.has(name)) continue
    const target = path.resolve(root, name)
    const relative = path.relative(resolvedRoot, target)
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error(`refusing to clean unexpected upload path: ${target}`)
    }
    await rm(target, { recursive: true, force: true })
    cleaned.push(name)
  }
  try {
    await rmdir(root)
    await rmdir(path.dirname(root))
  } catch {
    // Keep shared or non-empty directories.
  }
  return cleaned
}

async function assertEnabled(locator, message) {
  assert.equal(await locator.isEnabled(), true, message)
}

async function installStreamObserver(pageInstance) {
  await pageInstance.evaluate(() => {
    window.__remoteLive137Stream = []
    const list = document.querySelector('#messageList')
    const observer = new MutationObserver(() => {
      const assistant = [...document.querySelectorAll('#messageList .message.assistant')].at(-1)
      if (!assistant) return
      window.__remoteLive137Stream.push({
        text: assistant.textContent || '',
        state: document.querySelector('#conversationState')?.textContent || '',
      })
    })
    observer.observe(list, { childList: true, subtree: true, characterData: true })
  })
}

async function waitForAssistantText(pageInstance, expected, timeout) {
  await pageInstance.waitForFunction((value) => (
    [...document.querySelectorAll('#messageList .message.assistant')]
      .some((message) => message.textContent?.includes(value))
  ), expected, { timeout })
}

async function lastAssistantText(pageInstance) {
  return pageInstance.locator('#messageList .message.assistant').last().textContent()
}
