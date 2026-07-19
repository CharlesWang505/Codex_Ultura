import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const installScript = path.join(root, 'deploy', 'scripts', 'install-relay.sh')
const windowsScript = path.join(root, 'deploy', 'scripts', 'deploy-relay-from-windows.ps1')

test('VPS installer keeps Relay on loopback and renders HTTPS/WSS endpoints', async () => {
  const script = await readFile(installScript, 'utf8')
  assert.match(script, /RELAY_HOST=127\.0\.0\.1/)
  assert.match(script, /wss:\/\/\$DOMAIN\/ws/)
  assert.match(script, /https:\/\/\$DOMAIN/)
  assert.match(script, /sha256sum -c/)
  assert.match(script, /--non-interactive/)
  assert.doesNotMatch(script, /private\.example|192\.0\.2\.10/)
})

test('Windows deployment wizard validates a self-hosted domain in dry-run mode', () => {
  if (process.platform !== 'win32') return
  const result = spawnSync('powershell.exe', [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    windowsScript,
    '-VpsHost',
    '203.0.113.10',
    '-Domain',
    'relay.example.com',
    '-Email',
    'admin@example.com',
    '-NonInteractive',
    '-DryRun',
  ], {
    cwd: root,
    encoding: 'utf8',
  })
  assert.equal(result.status, 0, result.stderr || result.stdout)
  assert.match(result.stdout, /wss:\/\/relay\.example\.com\/ws/)
  assert.match(result.stdout, /https:\/\/relay\.example\.com/)
})

test('deployment templates contain only documentation examples', async () => {
  const files = [
    installScript,
    windowsScript,
    path.join(root, 'deploy', 'nginx', 'relay.example.com.conf'),
    path.join(root, 'deploy', 'caddy', 'Caddyfile'),
  ]
  const contents = await Promise.all(files.map((file) => readFile(file, 'utf8')))
  const joined = contents.join('\n')
  assert.doesNotMatch(joined, /private\.example|192\.0\.2\.10/)
  assert.match(joined, /relay\.example\.com/)
})
