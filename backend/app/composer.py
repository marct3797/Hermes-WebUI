"""Chat-Eingabe: Slash-Befehle (Schnappschuss der Hermes-Registry), @-Bezüge und Skill-Anweisungen.

Der Hermes-API-Server verarbeitet weder Slash-Befehle noch @-Bezüge im Text (belegt: kein Aufruf von
`preprocess_context_references` oder `resolve_command` in `gateway/platforms/api_server*.py`). Die WebUI setzt die
Semantik deshalb selbst um, nach `agent/context_references.py` und `agent/skill_commands.py`. Das BFF holt nie fremde URLs.
"""
from __future__ import annotations

import json
import re
from collections.abc import Awaitable, Callable
from functools import lru_cache
from pathlib import Path
from typing import Any

from fastapi import HTTPException

from .redaction import redact_fragments

# Wörtlich aus agent/context_references.py übernommen (Syntax muss mit Hermes übereinstimmen).
_QUOTED = r'(?:`[^`\n]+`|"[^"\n]+"|\'[^\'\n]+\')'
REFERENCE = re.compile(rf"(?<![\w/])@(?:(?P<simple>diff|staged)\b|(?P<kind>file|folder|git|url):(?P<value>{_QUOTED}(?::\d+(?:-\d+)?)?|\S+))")
_FILE_VALUE = re.compile(r'^(?:(?P<quote>`|"|\')(?P<qpath>.+?)(?P=quote)|(?P<path>.+?))(?::(?P<start>\d+)(?:-(?P<end>\d+))?)?$')
_OPENERS = {")": "(", "]": "[", "}": "{"}

MAX_REFS = 16  # wie Hermes (_MAX_EXPANDED_REFERENCES)
MAX_FILE_BYTES = 65536  # Vorschaugrenze des Host-Dienstes (hostd LIMIT)
MAX_TOKENS = 50_000  # Hermes begrenzt auf 50 % des Kontextfensters; die Länge kennt das BFF nicht, daher fester Deckel
FENCE = {".py": "python", ".js": "javascript", ".ts": "typescript", ".tsx": "tsx", ".jsx": "jsx", ".json": "json",
         ".md": "markdown", ".sh": "bash", ".yml": "yaml", ".yaml": "yaml", ".toml": "toml"}
GIT_LABEL = {"diff": "git diff", "staged": "git diff --staged"}

# Befehle, die die WebUI selbst ausführt. Alles andere braucht Terminal, Desktop oder Messaging von Hermes.
WEBUI_COMMANDS = {
    "new": "Beginnt einen neuen Chat mit diesem Agent.",
    "stop": "Stoppt den laufenden Lauf.",
    "reasoning": "Setzt den Denkaufwand dieses Agents (/reasoning hoch, /reasoning aus, /reasoning standard).",
    "model": "Öffnet die Modellwahl dieses Chats.",
}

Fetch = Callable[[str, dict[str, Any]], Awaitable[dict[str, Any]]]


@lru_cache(maxsize=1)
def slash_commands() -> list[dict[str, Any]]:
    data = json.loads((Path(__file__).parent / "data" / "slash_commands.json").read_text("utf-8"))
    out = []
    for c in data["commands"]:
        if c["name"] in WEBUI_COMMANDS:
            status, note = "webui", WEBUI_COMMANDS[c["name"]]
        elif c["gateway_only"]:
            status, note = "messaging", "Nur in Messaging-Plattformen (Telegram, Discord …) von Hermes verfügbar."
        elif c["cli_only"] or c["desktop"] == "terminal":
            status, note = "terminal", "Nur im Hermes-Terminal verfügbar. Die WebUI setzt diesen Befehl nicht um."
        else:
            status, note = "terminal", "Hermes verarbeitet diesen Befehl nur in Terminal, Desktop oder Messaging, nicht über die API. Die WebUI setzt ihn nicht um."
        out.append({**c, "status": status, "note": note})
    return out


def tokens_of(text: str) -> int:
    return (len(text) + 3) // 4


def _strip_punct(value: str) -> str:
    stripped = value.rstrip(",.;!?")
    while stripped.endswith((")", "]", "}")) and stripped.count(stripped[-1]) > stripped.count(_OPENERS[stripped[-1]]):
        stripped = stripped[:-1]
    return stripped


def _unwrap(value: str) -> str:
    return value[1:-1] if len(value) >= 2 and value[0] == value[-1] and value[0] in "`\"'" else value


def parse_refs(text: str) -> list[dict[str, Any]]:
    refs = []
    for m in REFERENCE.finditer(text):
        kind = m.group("simple") or m.group("kind")
        value = _strip_punct(m.group("value") or "")
        ref: dict[str, Any] = {"raw": m.group(0), "kind": kind, "target": "", "start": None, "end": None}
        if m.group("simple"):
            pass
        elif kind == "file":
            fm = _FILE_VALUE.match(value)
            if fm:
                ref["target"] = fm.group("qpath") or fm.group("path") or ""
                if fm.group("start"):
                    ref["start"] = int(fm.group("start"))
                    ref["end"] = int(fm.group("end") or fm.group("start"))
        else:
            ref["target"] = _unwrap(value)
        refs.append(ref)
    return refs


def _bad_path(path: str) -> str | None:
    if not path.strip():
        return "Pfad fehlt"
    if path.startswith(("/", "~")) or "\\" in path or "\x00" in path or ".." in path.split("/"):
        return "Pfad muss relativ zum Arbeitsordner sein"
    return None


def _http_reason(exc: HTTPException, what: str) -> str:
    # HostdClient macht aus 401/403 des Host-Dienstes ein 502 und nennt den echten Status im Text.
    found = re.search(r"HTTP (\d{3})", str(exc.detail))
    code = int(found.group(1)) if found and exc.status_code == 502 else exc.status_code
    return {404: f"{what} nicht gefunden", 403: "verweigert (versteckte oder geheime Dateien sind gesperrt)",
            415: "binäre Datei, nicht anhängbar", 413: "zu groß", 409: "kein lesbares Git-Repository",
            503: "kein Host-Dienst erreichbar", 504: "Host-Dienst antwortet nicht"}.get(code, f"Host-Dienst meldet HTTP {code}")


async def _expand_one(ref: dict[str, Any], workspace: str | None, fetch: Fetch) -> tuple[str | None, str | None]:
    """(Fehler, Block). Genau eine Seite ist gesetzt, außer bei `@url:` (beide leer: bleibt Text)."""
    kind, target, raw = ref["kind"], ref["target"], ref["raw"]
    if kind == "url":
        return None, None
    if not workspace:
        return "kein Arbeitsordner gewählt", None
    try:
        if kind in ("file", "folder"):
            path = target.removeprefix("./").rstrip("/") if kind == "folder" else target.removeprefix("./")
            if kind == "folder" and path in ("", "."):
                path = ""
            elif (reason := _bad_path(path)):
                return reason, None
            data = await fetch("/v1/files", {"workspace": workspace, "path": path})
            if kind == "folder":
                entries = data.get("entries")
                if not isinstance(entries, list):
                    return "ist kein Ordner", None
                lines = [f"{e.get('name', '?')}/" if e.get("kind") == "directory" else f"{e.get('name', '?')} ({e.get('size', 0)} Bytes)"
                         for e in entries[:200] if isinstance(e, dict)]
                if data.get("truncated") or len(entries) > 200:
                    lines.append("… (Liste gekürzt)")
                listing = "\n".join(lines) or "(leer)"
                return None, f"📁 {raw} ({tokens_of(listing)} tokens)\n{listing}"
            content = data.get("content")
            if not isinstance(content, str):
                return "ist keine Datei", None
            if data.get("truncated"):
                return f"zu groß (über {MAX_FILE_BYTES // 1024} KB)", None
            if ref["start"] is not None:
                content = "".join(content.splitlines(keepends=True)[max(ref["start"] - 1, 0):ref["end"]])
            content = redact_fragments(content)
            lang = FENCE.get(Path(path).suffix.lower(), "")
            return None, f"📄 {raw} ({tokens_of(content)} tokens)\n```{lang}\n{content}\n```"
        # diff, staged, git
        params: dict[str, Any] = {"workspace": workspace, "mode": "log" if kind == "git" else kind}
        if kind == "git":
            if target and not target.isdigit():
                return "erwartet eine Zahl, z. B. @git:3", None
            params["n"] = max(1, min(int(target or "1"), 10))
        data = await fetch("/v1/git", params)
        if data.get("repository") is False:
            return str(data.get("reason") or "kein Git-Repository"), None
        if data.get("mode") != params["mode"]:
            return "der Host-Dienst ist zu alt für diesen Bezug (bitte aktualisieren)", None
        body = data.get("log") if kind == "git" else data.get("diff")
        body = redact_fragments(str(body or "").strip() or "(keine Ausgabe)")
        label = f"git log -{params['n']}" if kind == "git" else GIT_LABEL[kind]
        note = "\n(gekürzt)" if data.get("truncated") else ""
        return None, f"🧾 {label} ({tokens_of(body)} tokens)\n```{'text' if kind == 'git' else 'diff'}\n{body}\n```{note}"
    except HTTPException as exc:
        return _http_reason(exc, "Ordner" if kind == "folder" else "Datei"), None


async def expand(text: str, workspace: str | None, fetch: Fetch) -> dict[str, Any]:
    refs = parse_refs(text)
    results, blocks, warnings = [], [], []
    for ref in refs[:MAX_REFS]:
        error, block = await _expand_one(ref, workspace, fetch)
        row = {"raw": ref["raw"], "kind": ref["kind"], "ok": error is None, "tokens": tokens_of(block) if block else 0,
               "passthrough": ref["kind"] == "url", "error": error}
        results.append(row)
        if error:
            warnings.append(f"{ref['raw']}: {error}")
        if block:
            blocks.append(block)
    for ref in refs[MAX_REFS:]:
        results.append({"raw": ref["raw"], "kind": ref["kind"], "ok": False, "tokens": 0, "passthrough": False,
                        "error": f"nicht angehängt (höchstens {MAX_REFS} Bezüge je Nachricht)"})
        warnings.append(f"{ref['raw']}: nicht angehängt (höchstens {MAX_REFS} Bezüge je Nachricht)")
    injected = sum(tokens_of(b) for b in blocks)
    out = text
    blocked = injected > MAX_TOKENS
    if blocked:
        warnings.append(f"Kontext abgelehnt: {injected} Tokens überschreiten die Grenze von {MAX_TOKENS}.")
    elif warnings or blocks:
        if warnings:
            out += "\n\n--- Context Warnings ---\n" + "\n".join(f"- {w}" for w in warnings)
        if blocks:
            out += "\n\n--- Attached Context ---\n\n" + "\n\n".join(blocks)
    return {"text": out.strip() if not blocked else text, "refs": results, "tokens": injected, "blocked": blocked,
            "workspace": workspace, "warnings": warnings}


def skill_message(name: str, content: str, instruction: str) -> str:
    """Wie `build_skill_invocation_message` (ohne Skill-Verzeichnis-Fußzeile: das BFF kennt den Pfad auf dem Host nicht)."""
    parts = [f'[IMPORTANT: The user has invoked the "{name}" skill, indicating they want you to follow its instructions. '
             "The full skill content is loaded below.]", "", content.strip()]
    if instruction.strip():
        parts += ["", f"The user has provided the following instruction alongside the skill invocation: {instruction.strip()}"]
    return "\n".join(parts)
