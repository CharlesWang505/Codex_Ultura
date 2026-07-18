import { build } from 'esbuild'

const shared = {
  bundle: true,
  platform: 'browser',
  target: ['chrome109', 'safari16'],
  minify: true,
  legalComments: 'none',
}

await Promise.all([
  build({
    ...shared,
    entryPoints: ['server/web/app.js'],
    outfile: 'server/web/app.bundle.js',
    format: 'iife',
  }),
  build({
    ...shared,
    entryPoints: ['server/web/lan-pairing.js'],
    outfile: 'server/web/lan-pairing.bundle.js',
    format: 'iife',
  }),
])
