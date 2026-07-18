import { lazy, Suspense } from 'react'
import { AppErrorBoundary } from './components/AppErrorBoundary'
import { I18nProvider, useLanguage } from './lib/i18n'

const App = lazy(() => import('./App.tsx'))
const FloatingSurface = lazy(() => import('./features/codex/FloatingSurface').then((module) => ({ default: module.FloatingSurface })))

function StartupShell() {
  const { language } = useLanguage()
  return (
    <main className="app-startup-shell">
      <span />
      <strong>{language === 'zh-CN' ? '法典指南' : 'Codex Compass'}</strong>
    </main>
  )
}

export function RootSurface() {
  const surface = new URLSearchParams(window.location.search).get('surface')
  const content = surface === 'floating' || surface === 'floating-panel'
    ? <FloatingSurface surface={surface} />
    : <App />

  return (
    <I18nProvider>
      <AppErrorBoundary>
        <Suspense fallback={<StartupShell />}>
          {content}
        </Suspense>
      </AppErrorBoundary>
    </I18nProvider>
  )
}
