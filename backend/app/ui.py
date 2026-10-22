"""UI-Einstellungen der WebUI: Sigils (Profil-Symbole), Symbol-Packs und Hintergrund-Shader.

Die Datei `ui.json` gehört zur WebUI-Config, nie zu Hermes: Hermes-Profile bleiben unangetastet. Neben der Datei dürfen
`sigils/*.svg` (eigene Symbole) und `packs/<id>.json` (Symbol-Packs) liegen. Alle SVGs werden beim Laden bereinigt und
aus dem Speicher ausgeliefert; die URL wählt nie einen Dateipfad.
"""
from __future__ import annotations

import json
import re
import xml.etree.ElementTree as ET
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

SVG_NS = "http://www.w3.org/2000/svg"
MAX_SVG_BYTES = 20 * 1024
MAX_ELEMENTS = 200
MAX_DEPTH = 8

NAME_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")
KEY_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}(/[a-z0-9][a-z0-9-]{0,31}/[A-Za-z0-9][A-Za-z0-9_-]{0,63})?$")
SIGIL_TYPES = ("glyph", "initials", "svg")
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
    profiles = data.get("profiles")
    for key, entry in (profiles.items() if isinstance(profiles, dict) else []):
        if not isinstance(key, str) or not KEY_RE.match(key):
            state.warnings.append(f"Profilschlüssel ungültig: {key!r}")
            continue
        sigil = _sigil(key, entry.get("sigil") if isinstance(entry, dict) else None, base, packs, state)
        if sigil:
            state.sigils[key] = sigil
    return state


class UiConfig:
    """Liest `ui.json` und lädt sie bei Änderung neu. Fehler lassen den letzten guten Stand stehen."""

    def __init__(self, path: Path | None):
        self.path = path
        self._mtime: float | None = None
        self._state = UiState(shader=dict(DEFAULT_SHADER))
        self.error: str | None = None

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

    def public(self) -> dict[str, Any]:
        s = self.state()
        return {"ui": {"backgroundShader": s.shader}, "sigils": s.sigils, "warnings": s.warnings, "error": self.error}

    def svg(self, key: str) -> str | None:
        return self.state().svgs.get(key)
