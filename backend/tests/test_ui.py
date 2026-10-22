import json
import os

import pytest
from fastapi.testclient import TestClient

from app.main import create_app
from app.ui import MAX_SVG_BYTES, SvgError, UiConfig, parse_ui, sanitize_svg

HDR = {"X-Requested-With": "hermes-webui"}
GLYPH = (
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#000" stroke-width="1.7">'
    '<path d="M13 3 5.500 13.500H11L10 21l8-11h-5.500z"/><circle cx="12" cy="12" r="1.5"/></svg>'
)


def svg(body: str, attrs: str = 'xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"') -> str:
    return f"<svg {attrs}>{body}</svg>"


class TestSanitize:
    def test_keeps_shapes_and_adds_namespace(self):
        out = sanitize_svg(GLYPH)
        assert out.startswith("<svg") and 'xmlns="http://www.w3.org/2000/svg"' in out
        assert "<path" in out and "<circle" in out and 'stroke-width="1.7"' in out

    def test_accepts_svg_without_explicit_namespace_attribute_only_if_valid_xml(self):
        assert "<path" in sanitize_svg('<svg viewBox="0 0 24 24"><path d="M0 0h24"/></svg>')

    @pytest.mark.parametrize("body", [
        "<script>alert(1)</script>",
        '<foreignObject><div xmlns="http://www.w3.org/1999/xhtml">x</div></foreignObject>',
        '<image href="https://evil.example/x.png"/>',
        '<use href="#a"/>',
        "<style>*{fill:red}</style>",
        '<a href="javascript:alert(1)"><path d="M0 0"/></a>',
        "<animate attributeName='x'/>",
        '<path d="M0 0" onload="alert(1)"/>',
        '<path d="M0 0" style="fill:url(#x)"/>',
        '<path d="M0 0" fill="url(https://evil.example/p)"/>',
        '<path d="M0 0" href="x"/>',
        '<path d="M0 0" xlink:href="x" xmlns:xlink="http://www.w3.org/1999/xlink"/>',
        '<path d="M0 0&#x3c;script"/>',
    ])
    def test_rejects_active_or_external_content(self, body):
        with pytest.raises(SvgError):
            sanitize_svg(svg(body))

    def test_rejects_other_namespaces_and_entities(self):
        with pytest.raises(SvgError):
            sanitize_svg('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><x:path xmlns:x="urn:evil" d="M0 0"/></svg>')
        with pytest.raises(SvgError):
            sanitize_svg('<!DOCTYPE svg [<!ENTITY a "aaaa">]><svg viewBox="0 0 1 1"><path d="&a;"/></svg>')
        with pytest.raises(SvgError):
            sanitize_svg('<svg viewBox="0 0 1 1"><path d="M0 0"/><![CDATA[x]]></svg>')

    def test_rejects_wrong_root_missing_viewbox_and_garbage(self):
        with pytest.raises(SvgError):
            sanitize_svg("<g><path d='M0 0'/></g>")
        with pytest.raises(SvgError):
            sanitize_svg('<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0"/></svg>')
        with pytest.raises(SvgError):
            sanitize_svg("<svg><path")

    def test_rejects_oversize_and_deep_nesting(self):
        with pytest.raises(SvgError):
            sanitize_svg(svg('<path d="M0 0"/>' + " " * MAX_SVG_BYTES))
        with pytest.raises(SvgError):
            sanitize_svg(svg("<g>" * 12 + "</g>" * 12))
        with pytest.raises(SvgError):
            sanitize_svg(svg('<path d="M0 0"/>' * 250))


@pytest.fixture
def ui_dir(tmp_path):
    d = tmp_path / "ui"
    (d / "sigils").mkdir(parents=True)
    (d / "packs").mkdir()
    (d / "sigils" / "mein-symbol.svg").write_text(GLYPH)
    (d / "sigils" / "boese.svg").write_text(svg("<script>alert(1)</script>"))
    (d / "packs" / "japan.json").write_text(json.dumps({"id": "japan", "glyphs": {"raiden": GLYPH, "kaputt": svg("<script/>")}}))
    (d / "ui.json").write_text(json.dumps({
        "ui": {"backgroundShader": {"enabled": False, "strength": 9, "speed": "schnell"}},
        "packs": ["japan", "../geheim", "neutral", "fehlt"],
        "profiles": {
            "raiden": {"sigil": {"type": "glyph", "glyph": "japan/raiden", "hue": 98}},
            "hikari/hermes/default": {"sigil": {"type": "glyph", "glyph": "neutral/bolt", "hue": None}},
            "sora": {"sigil": {"type": "initials", "text": "SO", "hue": "auto"}},
            "kaze": {"sigil": {"type": "svg", "src": "sigils/mein-symbol.svg"}},
            "yume": {"sigil": {"type": "svg", "src": "sigils/boese.svg"}},
            "inari": {"sigil": {"type": "svg", "src": "../hosts.json"}},
            "ryujin": {"sigil": {"type": "svg", "src": "sigils/../ui.json"}},
            "benzai": {"sigil": {"type": "glyph", "glyph": "japan/kaputt"}},
            "omoikane": {"sigil": {"type": "glyph", "glyph": "ghost/pack"}},
            "../evil": {"sigil": {"type": "initials", "text": "XX"}},
            "x": {"sigil": {"type": "nichts"}},
            "long": {"sigil": {"type": "initials", "text": "TOOLONG"}},
            "hue": {"sigil": {"type": "initials", "text": "HU", "hue": 9999}},
        },
    }))
    return d


class TestParse:
    def test_valid_entries_and_clamped_shader(self, ui_dir):
        state = UiConfig(ui_dir / "ui.json").state()
        assert state.shader == {"enabled": False, "strength": 3.0, "speed": 1.0}
        assert state.sigils["raiden"] == {"type": "glyph", "hue": 98.0, "glyph": "japan/raiden", "src": "/bff/ui/glyphs/japan/raiden.svg"}
        assert state.sigils["hikari/hermes/default"] == {"type": "glyph", "hue": None, "glyph": "neutral/bolt"}
        assert state.sigils["sora"] == {"type": "initials", "hue": "auto", "text": "SO"}
        assert state.sigils["kaze"]["src"] == "/bff/ui/sigils/mein-symbol.svg"
        assert state.sigils["hue"]["hue"] == 360.0
        assert "text" not in state.sigils["long"]  # zu lang: Initialen kommen dann aus dem Namen

    def test_rejects_unsafe_entries_and_reports_them(self, ui_dir):
        state = UiConfig(ui_dir / "ui.json").state()
        for key in ("yume", "inari", "ryujin", "benzai", "omoikane", "../evil", "x"):
            assert key not in state.sigils
        text = " ".join(state.warnings)
        assert "kaputt" in text and "../geheim" in text and "Pack fehlt" in text
        assert "sigil/boese" not in state.svgs and "glyph/japan/kaputt" not in state.svgs
        assert set(state.svgs) == {"glyph/japan/raiden", "sigil/mein-symbol"}

    def test_defaults_without_a_file(self, tmp_path):
        cfg = UiConfig(tmp_path / "gibt-es-nicht.json")
        shader = {"enabled": True, "strength": 1.6, "speed": 1.0}
        assert cfg.public() == {"ui": {"backgroundShader": shader}, "sigils": {}, "warnings": [], "error": None}
        assert UiConfig(None).public()["sigils"] == {}

    def test_garbage_json_keeps_last_good_state(self, ui_dir):
        path = ui_dir / "ui.json"
        cfg = UiConfig(path)
        assert "raiden" in cfg.state().sigils
        path.write_text("{kaputt")
        os.utime(path, ns=(10**18, 10**18))  # sicher neuerer Zeitstempel
        assert "raiden" in cfg.state().sigils
        assert cfg.error and "nicht lesbar" in cfg.error
        path.write_text(json.dumps({"profiles": {}}))
        os.utime(path, ns=(2 * 10**18, 2 * 10**18))
        assert cfg.state().sigils == {} and cfg.error is None

    def test_non_dict_input_is_harmless(self, tmp_path):
        assert parse_ui([], tmp_path).sigils == {}
        assert parse_ui({"profiles": ["x"], "packs": "x", "ui": 5}, tmp_path).sigils == {}


@pytest.fixture
def ui_client(make_settings, mock, ui_dir):
    import httpx

    from tests.conftest import RouterTransport

    app = create_app(make_settings(ui_file=ui_dir / "ui.json"), transport=RouterTransport({"hermes.test": httpx.ASGITransport(app=mock)}))
    with TestClient(app) as c:
        c.headers.update(HDR)
        yield c


class TestRoutes:
    def test_config_endpoint(self, ui_client):
        data = ui_client.get("/bff/ui").json()
        assert data["sigils"]["raiden"]["src"] == "/bff/ui/glyphs/japan/raiden.svg"
        assert data["ui"]["backgroundShader"]["enabled"] is False
        assert data["error"] is None

    def test_serves_sanitized_svg_with_strict_headers(self, ui_client):
        for url in ("/bff/ui/glyphs/japan/raiden.svg", "/bff/ui/sigils/mein-symbol.svg"):
            r = ui_client.get(url)
            assert r.status_code == 200
            assert r.headers["content-type"].startswith("image/svg+xml")
            assert r.headers["content-security-policy"] == "default-src 'none'; style-src 'none'; sandbox"
            assert r.headers["x-content-type-options"] == "nosniff"
            assert "<script" not in r.text and "<path" in r.text

    @pytest.mark.parametrize("url", [
        "/bff/ui/sigils/boese.svg",             # wurde beim Laden abgelehnt
        "/bff/ui/sigils/ui.svg",                # existiert nicht im Speicher
        "/bff/ui/sigils/..%2Fui.json.svg",
        "/bff/ui/sigils/%2e%2e%2fhosts.svg",
        "/bff/ui/glyphs/japan/kaputt.svg",
        "/bff/ui/glyphs/..%2F/raiden.svg",
        "/bff/ui/glyphs/japan/RAIDEN.svg",
    ])
    def test_unknown_or_hostile_names_are_404(self, ui_client, url):
        assert ui_client.get(url).status_code == 404

    def test_works_without_ui_file(self, client):
        r = client.get("/bff/ui")
        assert r.status_code == 200 and r.json()["sigils"] == {}


def test_example_configs_load_without_warnings(tmp_path):
    from pathlib import Path

    root = Path(__file__).resolve().parent.parent
    japan = UiConfig(root / "examples" / "japan" / "ui.json").state()
    assert japan.warnings == []
    assert set(japan.sigils) == {"default", "benzai", "inari", "kaze", "omoikane", "raiden", "ryujin", "sora", "yume"}
    assert len(japan.svgs) == 9
    # Das Standardbeispiel verweist auf eine SVG-Datei, die es nur im eigenen Config-Ordner gibt: Hinweis statt Absturz.
    neutral = UiConfig(root / "ui.example.json").state()
    assert "default" in neutral.sigils and "hikari/hermes/helper" in neutral.sigils
    assert any("docs" in w for w in neutral.warnings)
