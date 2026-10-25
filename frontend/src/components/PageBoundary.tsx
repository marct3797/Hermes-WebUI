import { Component, type ReactNode } from "react";
import { t } from "../i18n";

export class PageBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    return this.state.failed
      ? <main className="page"><p className="banner" role="alert">{t("Die Ansicht konnte nicht geladen werden. Nach einem Update hilft ein Neuladen.")}</p><button type="button" className="btn" onClick={() => location.reload()}>{t("Seite neu laden")}</button></main>
      : this.props.children;
  }
}
