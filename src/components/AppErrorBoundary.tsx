import { Component, type ErrorInfo, type ReactNode } from 'react'

type Props = { children: ReactNode }
type State = { failed: boolean }

export class AppErrorBoundary extends Component<Props, State> {
  state: State = { failed: false }

  static getDerivedStateFromError(): State {
    return { failed: true }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Codex Compass UI failed to render.', error, info.componentStack)
  }

  render() {
    if (!this.state.failed) return this.props.children

    return (
      <main className="app-error-boundary" role="alert">
        <div className="app-error-card">
          <span className="app-error-mark">!</span>
          <h1>界面加载失败</h1>
          <p>前端模块发生异常。重新加载不会修改供应商、Key 或账户监控数据。</p>
          <button type="button" onClick={() => window.location.reload()}>重新加载</button>
        </div>
      </main>
    )
  }
}
