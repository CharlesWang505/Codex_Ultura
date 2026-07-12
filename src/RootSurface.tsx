import { lazy, Suspense } from 'react'
import { AppErrorBoundary } from './components/AppErrorBoundary'

const App = lazy(() => import('./App.tsx'))
const FloatingSurface = lazy(() => import('./features/codex/FloatingSurface').then((module) => ({ default: module.FloatingSurface })))

export function RootSurface() {
  const surface = new URLSearchParams(window.location.search).get('surface')
  const content = surface === 'floating' || surface === 'floating-panel'
    ? <FloatingSurface surface={surface} />
    : <App />

  return (
    <AppErrorBoundary>
      <Suspense fallback={<main className="app-startup-shell"><span /><strong>Codex Compass · 法典指南针</strong></main>}>
        {content}
      </Suspense>
    </AppErrorBoundary>
  )
}
