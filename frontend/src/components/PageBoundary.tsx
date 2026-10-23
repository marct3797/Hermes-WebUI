import { Component, type ReactNode } from "react";

export class PageBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    return this.state.failed
      ? <main className="page"><p className="banner" role="alert">Die Ansicht konnte nicht geladen werden. Nach einem Update hilft ein Neuladen.</p><button type="button" className="btn" onClick={() => location.reload()}>Seite neu laden</button></main>
      : this.props.children;
  }
}
