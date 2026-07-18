import assert from 'node:assert/strict'
import { createHash, randomBytes, randomUUID, webcrypto } from 'node:crypto'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { chromium } from 'playwright'
import WebSocket from 'ws'

const { subtle } = webcrypto
const host = '127.0.0.1'
const port = 4181
const baseUrl = `http://${host}:${port}`
const roomId = randomUUID()
const desktopDeviceId = randomUUID()
const token = randomBytes(32).toString('base64url')
const keyBytes = randomBytes(32)
const key = keyBytes.toString('base64url')
const encoder = new TextEncoder()
const decoder = new TextDecoder()
const cryptoKey = await subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['encrypt', 'decrypt'])
const authorizedSessionId = randomUUID()
const viewOnlySessionId = randomUUID()
const projectLoadedSessionId = randomUUID()
const projectLoadedSecondSessionId = randomUUID()
let outgoingSequence = Date.now() * 1000
let mobileDeviceId = ''
let receivedAttachment = null
const resumedSessionIds = []
const historySessionIds = []
const projectSessionRequests = []

function associatedData(frame) {
  return encoder.encode(
    `${frame.protocolVersion}\n${frame.kind}\n${frame.roomId}\n${frame.senderDeviceId}\n${frame.targetDeviceId || ''}\n${frame.messageId}\n${frame.sequence}`,
  )
}

async function encryptRemote(message, targetDeviceId) {
  const frame = {
    protocolVersion: 1,
    kind: 'relay',
    roomId,
    senderDeviceId: desktopDeviceId,
    targetDeviceId,
    messageId: randomUUID(),
    sequence: outgoingSequence++,
    nonce: '',
    payload: '',
  }
  const nonce = randomBytes(12)
  const ciphertext = await subtle.encrypt(
    { name: 'AES-GCM', iv: nonce, additionalData: associatedData(frame), tagLength: 128 },
    cryptoKey,
    encoder.encode(JSON.stringify(message)),
  )
  frame.nonce = nonce.toString('base64url')
  frame.payload = Buffer.from(ciphertext).toString('base64url')
  return frame
}

async function decryptRemote(frame) {
  const plaintext = await subtle.decrypt(
    {
      name: 'AES-GCM',
      iv: Buffer.from(frame.nonce, 'base64url'),
      additionalData: associatedData(frame),
      tagLength: 128,
    },
    cryptoKey,
    Buffer.from(frame.payload, 'base64url'),
  )
  return JSON.parse(decoder.decode(plaintext))
}

function remoteMessage(type, requestId, payload = {}, sessionId = null, turnId = null) {
  return {
    protocolVersion: 1,
    messageId: randomUUID(),
    timestamp: Date.now(),
    requestId,
    sessionId,
    turnId,
    type,
    payload,
  }
}

async function downloadAndDecryptAttachment(descriptor, senderDeviceId) {
  const response = await fetch(`${baseUrl}/api/uploads/${descriptor.uploadId}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      'X-Room-Id': roomId,
      'X-Device-Id': desktopDeviceId,
      'X-Upload-Token': descriptor.downloadToken,
    },
  })
  assert.equal(response.status, 200)
  const ciphertext = await response.arrayBuffer()
  const aad = encoder.encode(
    `codex-compass-upload-v1\n${roomId}\n${senderDeviceId}\n${desktopDeviceId}\n${descriptor.clientId}\n${descriptor.size}\n${descriptor.sha256}`,
  )
  const plaintext = await subtle.decrypt(
    {
      name: 'AES-GCM',
      iv: Buffer.from(descriptor.nonce, 'base64url'),
      additionalData: aad,
      tagLength: 128,
    },
    cryptoKey,
    ciphertext,
  )
  const bytes = Buffer.from(plaintext)
  assert.equal(bytes.length, descriptor.size)
  assert.equal(createHash('sha256').update(bytes).digest('base64url'), descriptor.sha256)
  const secondDownload = await fetch(`${baseUrl}/api/uploads/${descriptor.uploadId}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      'X-Room-Id': roomId,
      'X-Device-Id': desktopDeviceId,
      'X-Upload-Token': descriptor.downloadToken,
    },
  })
  assert.equal(secondDownload.status, 404)
  return { name: descriptor.name, text: bytes.toString('utf8') }
}

const server = spawn(process.execPath, ['server/index.mjs'], {
  cwd: path.resolve('.'),
  env: { ...process.env, RELAY_HOST: host, RELAY_PORT: String(port) },
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
})

await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('test relay startup timed out')), 10_000)
  server.once('error', reject)
  server.stdout.on('data', (chunk) => {
    if (!chunk.toString('utf8').includes('relay listening')) return
    clearTimeout(timer)
    resolve()
  })
})

const desktop = new WebSocket(`${baseUrl.replace('http', 'ws')}/ws`)
await new Promise((resolve, reject) => {
  desktop.once('open', () => {
    desktop.send(JSON.stringify({
      protocolVersion: 1,
      kind: 'auth',
      role: 'desktop',
      roomId,
      deviceId: desktopDeviceId,
      token,
    }))
  })
  desktop.on('message', (data) => {
    const value = JSON.parse(data.toString('utf8'))
    if (value.kind === 'authenticated') resolve()
  })
  desktop.once('error', reject)
})

desktop.on('message', async (data) => {
  const frame = JSON.parse(data.toString('utf8'))
  if (frame.kind !== 'relay') return
  mobileDeviceId = frame.senderDeviceId
  const command = await decryptRemote(frame)
  const send = async (message) => {
    desktop.send(JSON.stringify(await encryptRemote(message, mobileDeviceId)))
  }
  switch (command.type) {
    case 'device.status.request':
      await send(remoteMessage('device.status', command.messageId, {
        connection: 'connected',
        paused: false,
        deviceName: 'E2E 测试电脑',
        codexVersion: 'codex-cli 0.142.5',
        authType: 'apiKey',
        codexAuthenticated: true,
        workspaceCount: 1,
        activeSessions: 1,
      }))
      break
    case 'workspace.list':
      await send(remoteMessage('workspace.list.result', command.messageId, {
        workspaces: [{
          id: 'workspace-e2e',
          name: '远控测试项目',
          path: 'D:\\RemoteWebE2E',
          allowWrite: true,
          allowCommands: true,
          allowUploads: true,
        }],
      }))
      break
    case 'model.list':
      await send(remoteMessage('model.list.result', command.messageId, {
        models: [{ id: 'gpt-5.4', displayName: 'GPT-5.4', isDefault: true }],
      }))
      break
    case 'session.list.request':
      if (command.payload.workspaceId === 'project-older') {
        projectSessionRequests.push(command.payload)
        const secondPage = command.payload.cursor === '1'
        await send(remoteMessage('session.list.result', command.messageId, {
          sessions: [{
            id: secondPage ? projectLoadedSecondSessionId : projectLoadedSessionId,
            title: secondPage ? '按项目加载的更早任务' : '按项目加载的旧任务',
            preview: secondPage ? '按项目加载的更早任务' : '按项目加载的旧任务',
            cwd: 'D:\\OlderProject',
            projectId: 'project-older',
            projectName: '较早任务项目',
            projectPath: 'D:\\OlderProject',
            workspaceId: 'workspace-e2e',
            workspaceName: '较早任务项目',
            canViewHistory: true,
            canContinue: true,
            updatedAt: Date.now() - (secondPage ? 20_000 : 10_000),
          }],
          projects: [{
            id: 'project-older',
            name: '较早任务项目',
            path: 'D:\\OlderProject',
            total: 2,
            active: 2,
            archived: 0,
            continuable: 2,
            authorized: true,
          }],
          nextCursor: secondPage ? null : '1',
          total: 2,
          active: 2,
          archived: 0,
          loaded: secondPage ? 2 : 1,
        }))
        break
      }
      await send(remoteMessage('session.list.result', command.messageId, {
        sessions: [{
          id: authorizedSessionId,
          title: '可继续的远控任务',
          preview: '可继续的远控任务',
          cwd: 'D:\\RemoteWebE2E',
          projectId: 'project-authorized',
          projectName: '远控测试项目',
          projectPath: 'D:\\RemoteWebE2E',
          workspaceId: 'workspace-e2e',
          workspaceName: '远控测试项目',
          canViewHistory: true,
          canContinue: true,
          updatedAt: Date.now(),
        }, {
          id: viewOnlySessionId,
          title: '尚未同步的历史任务',
          preview: '尚未同步的历史任务',
          cwd: 'D:\\CodexHistoryOnly',
          projectId: 'project-view-only',
          projectName: '历史项目',
          projectPath: 'D:\\CodexHistoryOnly',
          workspaceId: null,
          workspaceName: '历史项目',
          canViewHistory: true,
          canContinue: false,
          updatedAt: Date.now() - 1_000,
        }],
        projects: [{
          id: 'project-authorized',
          name: '远控测试项目',
          path: 'D:\\RemoteWebE2E',
          total: 1,
          active: 1,
          archived: 0,
          continuable: 1,
          authorized: true,
        }, {
          id: 'project-view-only',
          name: '历史项目',
          path: 'D:\\CodexHistoryOnly',
          total: 1,
          active: 1,
          archived: 0,
          continuable: 0,
          authorized: false,
        }, {
          id: 'project-older',
          name: '较早任务项目',
          path: 'D:\\OlderProject',
          total: 2,
          active: 2,
          archived: 0,
          continuable: 2,
          authorized: true,
        }],
        nextCursor: '2',
        total: 4,
        active: 4,
        archived: 0,
        loaded: 2,
      }))
      break
    case 'session.resume':
      resumedSessionIds.push(command.sessionId)
      await send(remoteMessage('session.resumed', command.messageId, {
        id: command.sessionId,
        cwd: 'D:\\RemoteWebE2E',
      }, command.sessionId))
      break
    case 'session.history.request': {
      historySessionIds.push(command.sessionId)
      const viewOnly = command.sessionId === viewOnlySessionId
      const projectLoaded = command.sessionId === projectLoadedSessionId
      await send(remoteMessage('session.history.result', command.messageId, {
        session: {
          id: command.sessionId,
          cwd: viewOnly
            ? 'D:\\CodexHistoryOnly'
            : projectLoaded
              ? 'D:\\OlderProject'
              : 'D:\\RemoteWebE2E',
        },
        turns: [{
          items: [
            { role: 'user', text: viewOnly ? '历史问题' : projectLoaded ? '较早任务问题' : '已有问题' },
            {
              role: 'assistant',
              text: viewOnly ? '历史回复已读取' : projectLoaded ? '按项目读取的历史回复' : '已有回复已读取',
            },
            ...(!viewOnly && !projectLoaded ? [{
              role: 'assistant',
              text: '```text\n### 自动格式化验证\n\n→ 自动读取项目\n→ 继续已有任务\n\n- `model`: 使用本机模型\n- `session`: 保留会话上下文\n\n所以，这是**已经格式化的回复**。\n```',
            }] : []),
          ],
        }],
      }, command.sessionId))
      break
    }
    case 'capability.list':
      await send(remoteMessage('capability.list.result', command.messageId, {
        plugins: [{
          id: 'build-web-apps',
          name: 'build-web-apps',
          displayName: 'Build Web Apps',
          description: '网页开发与测试能力',
          skillNames: ['build-web-apps:frontend-testing-debugging'],
        }],
        skills: [{
          name: 'build-web-apps:frontend-testing-debugging',
          displayName: 'Frontend Testing',
          description: '浏览器交互与响应式验证',
          scope: 'user',
          pluginId: 'build-web-apps',
        }],
      }, command.sessionId))
      break
    case 'session.create': {
      const sessionId = randomUUID()
      await send(remoteMessage('session.created', command.messageId, {
        id: sessionId,
        title: '附件与 Skill 联调',
        cwd: 'D:\\RemoteWebE2E',
        status: 'idle',
      }, sessionId))
      break
    }
    case 'conversation.input': {
      assert.deepEqual(command.payload.skills, ['build-web-apps:frontend-testing-debugging'])
      assert.equal(command.payload.attachments.length, 1)
      receivedAttachment = await downloadAndDecryptAttachment(
        command.payload.attachments[0],
        frame.senderDeviceId,
      )
      const turnId = randomUUID()
      await send(remoteMessage('conversation.accepted', command.messageId, {}, command.sessionId, turnId))
      await send(remoteMessage('turn.started', null, { status: 'running' }, command.sessionId, turnId))
      await send(remoteMessage(
        'response.delta',
        null,
        { delta: '### 远程附件和 Skill 已验证\n\n' },
        command.sessionId,
        turnId,
      ))
      await send(remoteMessage(
        'response.delta',
        null,
        { delta: '- 附件已解密\n- Skill 已加载\n\n' },
        command.sessionId,
        turnId,
      ))
      await send(remoteMessage(
        'response.delta',
        null,
        { delta: '```text\n测试输出\n```' },
        command.sessionId,
        turnId,
      ))
      await send(remoteMessage('response.completed', null, { status: 'completed' }, command.sessionId, turnId))
      break
    }
  }
})

const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 390, height: 844 } })
const consoleErrors = []
page.on('console', (message) => {
  if (message.type() === 'error') consoleErrors.push(message.text())
})
page.on('pageerror', (error) => consoleErrors.push(error.message))

const screenshotRoot = path.join(tmpdir(), 'codex-compass-remote-web-e2e')
const viewOnlyScreenshot = `${screenshotRoot}-view-only.png`
const projectLoadedScreenshot = `${screenshotRoot}-project-loaded.png`
const mobileScreenshot = `${screenshotRoot}-mobile.png`
const desktopScreenshot = `${screenshotRoot}-desktop.png`
const formattedHistoryScreenshot = `${screenshotRoot}-formatted-history.png`

try {
  await page.goto(`${baseUrl}/?room=${roomId}&desktop=${desktopDeviceId}#token=${token}&key=${key}`)
  await page.locator('#deviceView').waitFor({ state: 'visible' })
  const olderProject = page.locator('.project-group[data-project-id="project-older"]')
  await olderProject.getByRole('button', { name: '加载此项目的任务' }).click()
  await olderProject.getByText('按项目加载的旧任务', { exact: true }).waitFor()
  await olderProject.getByRole('button', { name: '继续加载（剩余 1）' }).click()
  await olderProject.getByText('按项目加载的更早任务', { exact: true }).waitFor()
  assert.equal(projectSessionRequests.length, 2)
  assert.equal(projectSessionRequests[0].workspaceId, 'project-older')
  assert.equal(projectSessionRequests[0].cursor, null)
  assert.equal(projectSessionRequests[1].workspaceId, 'project-older')
  assert.equal(projectSessionRequests[1].cursor, '1')
  assert.equal(await page.locator('#loadMoreSessionsButton').isHidden(), true)
  await page.screenshot({ path: projectLoadedScreenshot, fullPage: false })
  await olderProject.getByText('按项目加载的旧任务', { exact: true }).click()
  await page.getByText('按项目读取的历史回复', { exact: true }).waitFor()
  await page.getByText('历史已同步 · 可继续', { exact: true }).waitFor()
  assert.deepEqual(resumedSessionIds, [projectLoadedSessionId])
  assert.deepEqual(historySessionIds, [projectLoadedSessionId])

  await page.locator('#backButton').click()
  await page.getByText('历史项目', { exact: true }).waitFor()
  await page.getByText('尚未同步的历史任务', { exact: true }).click()
  await page.getByText('历史回复已读取', { exact: true }).waitFor()
  await page.getByText('历史已同步 · 仅查看', { exact: true }).waitFor()
  assert.equal(await page.locator('#messageInput').isDisabled(), true)
  assert.equal(await page.locator('#messageSkillButton').isDisabled(), true)
  assert.equal(await page.locator('#messageAttachmentButton').isDisabled(), true)
  assert.deepEqual(resumedSessionIds, [projectLoadedSessionId])
  assert.deepEqual(historySessionIds, [projectLoadedSessionId, viewOnlySessionId])
  await page.screenshot({ path: viewOnlyScreenshot, fullPage: false })

  await page.locator('#backButton').click()
  await page.getByText('可继续的远控任务', { exact: true }).waitFor()
  await page.getByText('可继续的远控任务', { exact: true }).click()
  await page.getByText('已有回复已读取', { exact: true }).waitFor()
  await page.getByText('历史已同步 · 可继续', { exact: true }).waitFor()
  await page.getByRole('heading', { name: '自动格式化验证', exact: true }).waitFor()
  assert.equal(await page.locator('.message.assistant .arrow-list li').count(), 2)
  assert.equal(await page.locator('.message.assistant strong', { hasText: '已经格式化的回复' }).count(), 1)
  assert.equal((await page.locator('#messageList').innerText()).includes('```text'), false)
  assert.equal(await page.locator('#messageList script').count(), 0)
  await page.screenshot({ path: formattedHistoryScreenshot, fullPage: false })
  assert.equal(await page.locator('#messageInput').isEnabled(), true)
  assert.deepEqual(resumedSessionIds, [projectLoadedSessionId, authorizedSessionId])
  assert.deepEqual(historySessionIds, [projectLoadedSessionId, viewOnlySessionId, authorizedSessionId])

  await page.locator('#backButton').click()
  await page.locator('[data-view="new"]').click()
  await page.locator('#workspaceSelect').waitFor()
  await page.locator('#newSkillButton').click()
  await page.locator('#capabilityDialog').waitFor({ state: 'visible' })
  await page.getByText('网页应用开发', { exact: true }).waitFor()
  await page.getByText('开发前端网页应用、生成素材并进行浏览器测试', { exact: true }).waitFor()
  await page.locator('#capabilitySearch').fill('Build Web Apps')
  await page.locator('[data-capability-name="build-web-apps"]').waitFor()
  await page.locator('#capabilitySearch').fill('')
  await page.locator('[data-capability-name="build-web-apps"] input[type="checkbox"]').check()
  await page.locator('#confirmCapabilityDialog').click()
  await page.locator('#newAttachmentInput').setInputFiles({
    name: 'remote-notes.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('encrypted attachment from mobile web', 'utf8'),
  })
  await page.locator('#newSessionPrompt').fill('验证附件上传和所选 Skill')
  await page.locator('#createSessionButton').click()
  await page.getByRole('heading', { name: '远程附件和 Skill 已验证', exact: true }).waitFor({ timeout: 20_000 })
  assert.equal(await page.locator('.message.assistant li').count(), 2)
  assert.equal(await page.locator('.message.assistant .markdown-code-block code').textContent(), '测试输出')
  assert.equal(await page.locator('.message.assistant .markdown-copy').isVisible(), true)
  await page.screenshot({ path: mobileScreenshot, fullPage: false })
  await page.setViewportSize({ width: 980, height: 800 })
  await page.screenshot({ path: desktopScreenshot, fullPage: false })
  assert.deepEqual(receivedAttachment, {
    name: 'remote-notes.txt',
    text: 'encrypted attachment from mobile web',
  })
  assert.deepEqual(consoleErrors, [])
  process.stdout.write(`${JSON.stringify({
    ok: true,
    attachment: receivedAttachment,
    projectSessionRequests,
    consoleErrors,
    screenshots: [
      projectLoadedScreenshot,
      viewOnlyScreenshot,
      formattedHistoryScreenshot,
      mobileScreenshot,
      desktopScreenshot,
    ],
  }, null, 2)}\n`)
} finally {
  await browser.close()
  desktop.close()
  server.kill()
}
