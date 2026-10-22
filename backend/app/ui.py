"""UI-Einstellungen der WebUI: Sigils (Profil-Symbole), Symbol-Packs und Hintergrund-Shader.

Die Datei `ui.json` gehört zur WebUI-Config, nie zu Hermes: Hermes-Profile bleiben unangetastet. Neben der Datei dürfen
`sigils/*.svg` (eigene Symbole) und `packs/<id>.json` (Symbol-Packs) liegen. Alle SVGs werden beim Laden bereinigt und
aus dem Speicher ausgeliefert; die URL wählt nie einen Dateipfad.

Die Profil-Seite der WebUI darf Sigil, Anzeigename und Shader-Vorgabe zurückschreiben (`save_profile`, `save_shader`).
Das passiert nur, wenn die Datei schreibbar ist; sonst bleibt die Datei Quelle und die WebUI zeigt den fertigen Ausschnitt
zum Kopieren. Geschrieben wird atomar, der vorige Stand bleibt als `ui.json.bak` liegen, unbekannte Schlüssel bleiben erhalten.
"""
from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import shutil
import threading
import xml.etree.ElementTree as ET
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

log = logging.getLogger("hermes_webui.ui")

SVG_NS = "http://www.w3.org/2000/svg"
MAX_SVG_BYTES = 20 * 1024
MAX_ELEMENTS = 200
MAX_DEPTH = 8

NAME_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")
KEY_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}(/[a-z0-9][a-z0-9-]{0,31}/[A-Za-z0-9][A-Za-z0-9_-]{0,63})?$")
SIGIL_TYPES = ("glyph", "initials", "svg")
LABEL_MAX = 40
MAX_PROFILES = 500
BUILTIN_PACK = "neutral"  # die Symbole des Standards stecken im Frontend

ALLOWED_TAGS = {"svg", "g", "path", "circle", "ellipse", "rect", "line", "polyline", "polygon"}
ALLOWED_ATTRS = {
    "d", "cx", "cy", "r", "rx", "ry", "x", "y", "x1", "y1", "x2", "y2", "width", "height", "points", "transform",
    "viewBox", "fill", "stroke", "stroke-width", "stroke-linecap", "stroke-linejoin", "stroke-miterlimit",
    "fill-rule", "clip-rule", "opacity", "fill-opacity", "stroke-opacity",
}
SAFE_VALUE = re.compile(r"^[0-9A-Za-z#.,;:%()+\-\s]*$")


class SvgError(ValueError):
    pass


def sanitize_svg(source: str | bytes) -> str:
    """Gibt ein einfarbiges, skriptfreies SVG zurück oder wirft SvgError. Unbekanntes wird nicht übernommen, sondern abgelehnt."""
    raw = source.encode() if isinstance(source, str) else source
    if len(raw) > MAX_SVG_BYTES:
        raise SvgError("SVG größer als 20 KB")
    text = raw.decode("utf-8", errors="strict")
    lowered = text.lower()
    if "<!doctype" in lowered or "<!entity" in lowered or "<![cdata[" in lowered:
        raise SvgError("DOCTYPE, ENTITY und CDATA sind nicht erlaubt")
    try:
        root = ET.fromstring(text)
    except ET.ParseError as e:
        raise SvgError(f"kein gültiges SVG: {e}") from e

    count = 0

    def clean(node: ET.Element, depth: int) -> ET.Element:
        nonlocal count
        count += 1
        if count > MAX_ELEMENTS or depth > MAX_DEPTH:
            raise SvgError("SVG zu verschachtelt oder zu groß")
        ns, _, tag = node.tag.rpartition("}")
        if (ns and ns != "{" + SVG_NS) or tag not in ALLOWED_TAGS:
            raise SvgError(f"Element nicht erlaubt: {tag}")
        out = ET.Element(tag)
        for name, value in node.attrib.items():
            if name.startswith("{") or name not in ALLOWED_ATTRS:
                raise SvgError(f"Attribut nicht erlaubt: {name.rpartition('}')[2]}")
            if not SAFE_VALUE.match(value) or "url(" in value.lower():
                raise SvgError(f"Wert nicht erlaubt in {name}")
            out.set(name, value)
        for child in node:
            out.append(clean(child, depth + 1))
        return out

    cleaned = clean(root, 0)
    if cleaned.tag != "svg":
        raise SvgError("Wurzelelement muss svg sein")
    if "viewBox" not in cleaned.attrib:
        raise SvgError("viewBox fehlt")
    cleaned.set("xmlns", SVG_NS)
    return ET.tostring(cleaned, encoding="unicode")


@dataclass
class UiState:
    shader: dict[str, Any]
    sigils: dict[str, dict[str, Any]] = field(default_factory=dict)
    labels: dict[str, str] = field(default_factory=dict)  # Anzeigenamen; ohne Eintrag gilt der Profilordner
    packs: dict[str, list[str]] = field(default_factory=dict)  # geladene Packs und ihre Symbolnamen (neutral steckt im Frontend)
    svgs: dict[str, str] = field(default_factory=dict)  # "sigil/<name>" und "glyph/<pack>/<name>" -> bereinigtes SVG
    warnings: list[str] = field(default_factory=list)


DEFAULT_SHADER = {"enabled": True, "strength": 1.6, "speed": 1.0}


def _number(value: Any, default: float, low: float, high: float) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return default
    return min(high, max(low, float(value)))


def _shader(raw: Any) -> dict[str, Any]:
    raw = raw if isinstance(raw, dict) else {}
    return {
        "enabled": raw.get("enabled") is not False,
        "strength": _number(raw.get("strength"), DEFAULT_SHADER["strength"], 0, 3),
        "speed": _number(raw.get("speed"), DEFAULT_SHADER["speed"], 0, 3),
    }


def _label(raw: Any) -> str | None:
    if isinstance(raw, str):
        text = raw.strip()
        if 1 <= len(text) <= LABEL_MAX and text.isprintable():
            return text
    return None


def _read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def _load_packs(base: Path, ids: Any, state: UiState) -> dict[str, set[str]]:
    packs: dict[str, set[str]] = {}
    for pack_id in ids if isinstance(ids, list) else []:
        if not isinstance(pack_id, str) or not NAME_RE.match(pack_id) or pack_id == BUILTIN_PACK:
            state.warnings.append(f"Pack-Name ungültig: {pack_id!r}")
            continue
        try:
            data = _read_json(base / "packs" / f"{pack_id}.json")
            glyphs = data["glyphs"]
        except (OSError, ValueError, KeyError, TypeError) as e:
            state.warnings.append(f"Pack {pack_id} nicht lesbar: {type(e).__name__}")
            continue
        names: set[str] = set()
        for name, svg in (glyphs.items() if isinstance(glyphs, dict) else []):
            if not isinstance(name, str) or not NAME_RE.match(name) or not isinstance(svg, str):
                state.warnings.append(f"Pack {pack_id}: Eintrag {name!r} übersprungen")
                continue
            try:
                state.svgs[f"glyph/{pack_id}/{name}"] = sanitize_svg(svg)
                names.add(name)
            except (SvgError, UnicodeError) as e:
                state.warnings.append(f"Pack {pack_id}/{name}: {e}")
        packs[pack_id] = names
    return packs


def _sigil(key: str, raw: Any, base: Path, packs: dict[str, set[str]], state: UiState) -> dict[str, Any] | None:
    if not isinstance(raw, dict) or raw.get("type") not in SIGIL_TYPES:
        state.warnings.append(f"{key}: Sigil ohne gültigen type")
        return None
    out: dict[str, Any] = {"type": raw["type"]}
    hue = raw.get("hue", "auto")
    if hue is None or hue == "auto":
        out["hue"] = hue
    elif isinstance(hue, (int, float)) and not isinstance(hue, bool):
        out["hue"] = min(360.0, max(0.0, float(hue)))
    else:
        out["hue"] = "auto"

    if raw["type"] == "initials":
        text = raw.get("text")
        if isinstance(text, str) and 1 <= len(text) <= 3 and text.isprintable():
            out["text"] = text
    elif raw["type"] == "glyph":
        ref = raw.get("glyph")
        pack, _, name = ref.partition("/") if isinstance(ref, str) else ("", "", "")
        if not (NAME_RE.match(pack) and NAME_RE.match(name)):
            state.warnings.append(f"{key}: glyph muss die Form pack/name haben")
            return None
        out["glyph"] = ref
        if pack != BUILTIN_PACK:
            if name not in packs.get(pack, set()):
                state.warnings.append(f"{key}: {ref} nicht in den geladenen Packs")
                return None
            out["src"] = f"/bff/ui/glyphs/{pack}/{name}.svg"
    else:  # svg
        src = raw.get("src")
        stem = Path(src).stem if isinstance(src, str) else ""
        # Nur Dateien direkt in sigils/; die Antwort kommt später aus dem Speicher, nicht vom Pfad der URL.
        if not (isinstance(src, str) and src == f"sigils/{stem}.svg" and NAME_RE.match(stem)):
            state.warnings.append(f"{key}: src muss sigils/<name>.svg sein")
            return None
        if f"sigil/{stem}" not in state.svgs:
            try:
                state.svgs[f"sigil/{stem}"] = sanitize_svg((base / "sigils" / f"{stem}.svg").read_bytes())
            except (OSError, SvgError, UnicodeError) as e:
                state.warnings.append(f"{key}: {src}: {e}")
                return None
        out["src"] = f"/bff/ui/sigils/{stem}.svg"
    return out


def parse_ui(data: Any, base: Path) -> UiState:
    data = data if isinstance(data, dict) else {}
    ui = data.get("ui") if isinstance(data.get("ui"), dict) else {}
    state = UiState(shader=_shader(ui.get("backgroundShader")))
    packs = _load_packs(base, data.get("packs"), state)
    state.packs = {pack_id: sorted(names) for pack_id, names in packs.items()}
    profiles = data.get("profiles")
    for key, entry in (profiles.items() if isinstance(profiles, dict) else []):
        if not isinstance(key, str) or not KEY_RE.match(key):
            state.warnings.append(f"Profilschlüssel ungültig: {key!r}")
            continue
        entry = entry if isinstance(entry, dict) else {}
        if "label" in entry:
            label = _label(entry["label"])
            if label:
                state.labels[key] = label
            else:
                state.warnings.append(f"{key}: label muss 1 bis {LABEL_MAX} druckbare Zeichen haben")
        # Ein Eintrag nur mit Anzeigenamen ist gültig; ohne beides gibt es den bisherigen Hinweis.
        if "sigil" in entry or "label" not in entry:
            sigil = _sigil(key, entry.get("sigil"), base, packs, state)
            if sigil:
                state.sigils[key] = sigil
    return state


class UiWriteError(Exception):
    """Speichern nicht möglich; `status` ist der passende HTTP-Status."""

    def __init__(self, message: str, status: int = 422):
        super().__init__(message)
        self.status = status


def _write_text(path: Path, text: str) -> None:
    """Atomar ersetzen. Liegt die Datei als einzelner Bind-Mount, geht Ersetzen nicht: dann direkt schreiben."""
    tmp = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    try:
        tmp.write_text(text, encoding="utf-8")
        os.replace(tmp, path)
        return
    except OSError:
        tmp.unlink(missing_ok=True)  # nur die eigene Zwischendatei
    try:
        path.write_text(text, encoding="utf-8")
    except OSError as e:
        raise UiWriteError(f"{path.name} lässt sich nicht schreiben ({type(e).__name__})", 503) from e


class UiConfig:
    """Liest `ui.json` und lädt sie bei Änderung neu. Fehler lassen den letzten guten Stand stehen."""

    def __init__(self, path: Path | None):
        self.path = path
        self._mtime: float | None = None
        self._state = UiState(shader=dict(DEFAULT_SHADER))
        self.error: str | None = None
        self._lock = threading.Lock()

    def state(self) -> UiState:
        if self.path is None:
            return self._state
        try:
            mtime = self.path.stat().st_mtime_ns
        except OSError:
            self._state = UiState(shader=dict(DEFAULT_SHADER))  # Datei fehlt: Standardwerte
            self._mtime, self.error = None, None
            return self._state
        if mtime != self._mtime:
            try:
                self._state = parse_ui(_read_json(self.path), self.path.parent)
                self.error = None
            except (OSError, ValueError) as e:
                self.error = f"ui.json nicht lesbar: {type(e).__name__}"
            self._mtime = mtime
        return self._state

    def write_error(self) -> str | None:
        """Grund, warum die WebUI die Datei nicht ändern darf; `None` heißt schreibbar."""
        if self.path is None:
            return "Es ist keine ui.json konfiguriert (HERMES_WEBUI_UI_FILE)."
        if self.path.exists():
            ok = os.access(self.path, os.W_OK)
        else:
            ok = self.path.parent.is_dir() and os.access(self.path.parent, os.W_OK)
        return None if ok else "Die ui.json ist für die WebUI schreibgeschützt."

    def public(self) -> dict[str, Any]:
        s = self.state()
        reason = self.write_error()
        return {
            "ui": {"backgroundShader": s.shader}, "sigils": s.sigils, "labels": s.labels, "packs": s.packs,
            "writable": reason is None, "write_error": reason, "warnings": s.warnings, "error": self.error,
        }

    def svg(self, key: str) -> str | None:
        return self.state().svgs.get(key)

    # --- Speichern -------------------------------------------------------------------------------
    def _update(self, change: Callable[[dict[str, Any]], None], check: Callable[[UiState], None] | None = None) -> None:
        with self._lock:
            reason = self.write_error()
            if reason or self.path is None:
                raise UiWriteError(reason or "ui.json nicht schreibbar", 409)
            raw: Any = {}
            if self.path.exists():
                try:
                    raw = _read_json(self.path)
                except (OSError, ValueError) as e:
                    raise UiWriteError("Die ui.json ist kein gültiges JSON und wird nicht überschrieben.", 409) from e
                if not isinstance(raw, dict):
                    raise UiWriteError("Die ui.json ist kein JSON-Objekt und wird nicht überschrieben.", 409)
            change(raw)
            if check:
                check(parse_ui(raw, self.path.parent))
            if self.path.exists():
                try:
                    shutil.copyfile(self.path, self.path.with_name(self.path.name + ".bak"))
                except OSError:
                    log.warning("Sicherung %s.bak nicht möglich", self.path.name)
            _write_text(self.path, json.dumps(raw, ensure_ascii=False, indent=2) + "\n")
            self._mtime = None  # beim nächsten Lesen neu parsen

    def save_shader(self, enabled: bool, strength: float, speed: float) -> None:
        def change(raw: dict[str, Any]) -> None:
            ui = raw.get("ui") if isinstance(raw.get("ui"), dict) else {}
            ui["backgroundShader"] = {"enabled": enabled, "strength": strength, "speed": speed}
            raw["ui"] = ui

        self._update(change)

    def save_profile(self, key: str, label: str | None, sigil: dict[str, Any] | None, svg: str | None = None) -> None:
        """Setzt Anzeigename und Sigil dieses Profils. Beides `None` entfernt den Eintrag (zurück zu Standard)."""
        if not KEY_RE.match(key):
            raise UiWriteError("Ungültiger Profilschlüssel")
        label = label.strip() if label else None
        if label and not _label(label):
            raise UiWriteError(f"Der Anzeigename darf höchstens {LABEL_MAX} druckbare Zeichen haben")
        if self.path is None:
            raise UiWriteError(self.write_error() or "", 409)
        base = self.path.parent

        def entry_of(raw: dict[str, Any]) -> dict[str, Any]:
            profiles = raw.get("profiles")
            old = profiles.get(key) if isinstance(profiles, dict) else None
            return old if isinstance(old, dict) else {}

        built: dict[str, Any] | None = None
        clean_svg: str | None = None
        stem = ""
        if sigil:
            built = {"type": sigil["type"], "hue": sigil.get("hue", "auto")}
            if sigil["type"] == "glyph":
                built["glyph"] = sigil.get("glyph") or ""
            elif sigil["type"] == "initials":
                if sigil.get("text"):
                    built["text"] = sigil["text"]
            elif svg:
                try:
                    clean_svg = sanitize_svg(svg)
                except (SvgError, UnicodeError) as e:
                    raise UiWriteError(f"SVG abgelehnt: {e}") from e
                stem = re.sub(r"[^a-z0-9_-]+", "-", key.lower()).strip("-")[:40] or "sigil"
                stem += "-" + hashlib.sha1(key.encode()).hexdigest()[:6]
                built["src"] = f"sigils/{stem}.svg"
        if built and built["type"] == "svg" and "src" not in built:
            # Ohne neue SVG-Datei muss der Eintrag schon eine haben (nur Farbton oder Name ändern).
            try:
                old = entry_of(_read_json(self.path))
            except (OSError, ValueError):
                old = {}
            old_sigil = old.get("sigil") if isinstance(old.get("sigil"), dict) else {}
            if old_sigil.get("type") != "svg" or not old_sigil.get("src"):
                raise UiWriteError("Für ein eigenes Symbol fehlt die SVG-Datei")
            built["src"] = old_sigil["src"]

        def change(raw: dict[str, Any]) -> None:
            profiles = raw.get("profiles")
            if not isinstance(profiles, dict):
                profiles = raw["profiles"] = {}
            if key not in profiles and len(profiles) >= MAX_PROFILES:
                raise UiWriteError("Zu viele Profile in der ui.json")
            entry = {k: v for k, v in entry_of(raw).items() if k not in ("label", "sigil")}  # Unbekanntes bleibt
            if label:
                entry["label"] = label
            if built:
                entry["sigil"] = built
            if entry:
                profiles[key] = entry
            else:
                profiles.pop(key, None)

        def check(state: UiState) -> None:
            if (built and key not in state.sigils) or (label and key not in state.labels):
                hints = "; ".join(w for w in state.warnings if w.startswith(f"{key}:")) or "Eintrag ungültig"
                raise UiWriteError(hints)

        if clean_svg is not None:
            # Die Datei zuerst, damit die Prüfung sie findet; bei einem Fehler bleibt höchstens eine harmlose SVG liegen.
            (base / "sigils").mkdir(exist_ok=True)
            _write_text(base / "sigils" / f"{stem}.svg", clean_svg)
        self._update(change, check)
