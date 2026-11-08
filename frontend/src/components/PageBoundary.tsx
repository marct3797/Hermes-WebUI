import { Component, type ReactNode } from "react";
import { t } from "../i18n";

export class PageBoundary extends Component<{ children: ReactNode }, { failed: boolean; detail: string }> {
  state = { failed: false, detail: "" };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(err: unknown) { this.setState({ detail: String((err as Error)?.message ?? err) }); }
  render() {
    return this.state.failed
      ? <main className="page"><p className="banner" role="alert">{t("Die Ansicht konnte nicht geladen werden. Nach einem Update hilft ein Neuladen.")}</p>{this.state.detail ? <pre className="code">{this.state.detail}</pre> : null}<button type="button" className="btn" onClick={() => location.reload()}>{t("Seite neu laden")}</button></main>
      : this.props.children;
  }
}
