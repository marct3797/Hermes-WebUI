import "@fontsource-variable/inter";
import "@fontsource-variable/jetbrains-mono";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { initLanguage } from "./i18n";
import "./tokens.css";
import "./styles/icons.css";
import "./styles/base.css";
import "./styles/components.css";
import "./styles/shell.css";
import "./styles/cockpit.css";
import "./styles/inbox.css";
import "./styles/chat.css";
import "./styles/profile.css";
import "./styles/rooms.css";
import "./styles/soul.css";
import "./styles/providers.css";
import "./styles/operations.css";
import "./styles/workspace.css";
import "./styles/kanban.css";
import "./styles/ext.css";
import "./styles/composer.css";
import "./styles/files.css";
import "./styles/ops2.css";
import "./styles/mobile.css";

// Sprache zuerst laden, damit nichts erst deutsch aufblitzt; ein Ladefehler lässt die Oberfläche deutsch.
void initLanguage().then(() => createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>));
