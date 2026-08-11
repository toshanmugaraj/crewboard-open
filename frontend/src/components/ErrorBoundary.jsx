import React from 'react'

export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props)
    this.state = { hasError: false, error: null }
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error }
  }

  componentDidCatch(error, info) {
    console.error('CrewBoard render error:', error, info)
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{
          display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
          height: '100%', padding: 40, gap: 12, color: 'var(--muted)', textAlign: 'center'
        }}>
          <i className="ti ti-alert-triangle" style={{ fontSize: 36, color: 'var(--danger)' }} />
          <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text)' }}>Something went wrong</div>
          <div style={{ fontSize: 12, maxWidth: 400 }}>
            {this.state.error?.message || 'An unexpected error occurred while rendering.'}
          </div>
          <button className="btn-primary" onClick={() => { this.setState({ hasError: false, error: null }); window.location.reload() }}>
            Reload app
          </button>
        </div>
      )
    }
    return this.props.children
  }
}
