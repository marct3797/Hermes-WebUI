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
    (d / "packs" / "japan.json").write_text(json.dumps({"id": "japan", "glyphs": {"gamma": GLYPH, "kaputt": svg("<script/>")}}))
    (d / "ui.json").write_text(json.dumps({
        "ui": {"backgroundShader": {"enabled": False, "strength": 9, "speed": "schnell"}},
        "packs": ["japan", "../geheim", "neutral", "fehlt"],
        "profiles": {
            "gamma": {"sigil": {"type": "glyph", "glyph": "japan/gamma", "hue": 98}},
            "server/hermes/default": {"sigil": {"type": "glyph", "glyph": "neutral/bolt", "hue": None}},
            "eta": {"sigil": {"type": "initials", "text": "SO", "hue": "auto"}},
            "epsilon": {"sigil": {"type": "svg", "src": "sigils/mein-symbol.svg"}},
            "theta": {"sigil": {"type": "svg", "src": "sigils/boese.svg"}},
            "delta": {"sigil": {"type": "svg", "src": "../hosts.json"}},
            "alpha": {"sigil": {"type": "svg", "src": "sigils/../ui.json"}},
            "zeta": {"sigil": {"type": "glyph", "glyph": "japan/kaputt"}},
            "beta": {"sigil": {"type": "glyph", "glyph": "ghost/pack"}},
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
        assert state.sigils["gamma"] == {"type": "glyph", "hue": 98.0, "glyph": "japan/gamma", "src": "/bff/ui/glyphs/japan/gamma.svg"}
        assert state.sigils["server/hermes/default"] == {"type": "glyph", "hue": None, "glyph": "neutral/bolt"}
        assert state.sigils["eta"] == {"type": "initials", "hue": "auto", "text": "SO"}
        assert state.sigils["epsilon"]["src"] == "/bff/ui/sigils/mein-symbol.svg"
        assert state.sigils["hue"]["hue"] == 360.0
        assert "text" not in state.sigils["long"]  # zu lang: Initialen kommen dann aus dem Namen

    def test_rejects_unsafe_entries_and_reports_them(self, ui_dir):
        state = UiConfig(ui_dir / "ui.json").state()
        for key in ("theta", "delta", "alpha", "zeta", "beta", "../evil", "x"):
            assert key not in state.sigils
        text = " ".join(state.warnings)
        assert "kaputt" in text and "../geheim" in text and "Pack fehlt" in text
        assert "sigil/boese" not in state.svgs and "glyph/japan/kaputt" not in state.svgs
        assert set(state.svgs) == {"glyph/japan/gamma", "sigil/mein-symbol"}

    def test_defaults_without_a_file(self, tmp_path):
        cfg = UiConfig(tmp_path / "gibt-es-nicht.json")
        shader = {"enabled": True, "strength": 1.6, "speed": 1.0}
        assert cfg.public() == {
            "ui": {"backgroundShader": shader}, "sigils": {}, "labels": {}, "packs": {},
            "writable": True, "write_error": None, "warnings": [], "error": None,
        }
        assert UiConfig(None).public()["writable"] is False and "HERMES_WEBUI_UI_FILE" in UiConfig(None).public()["write_error"]
        assert UiConfig(None).public()["sigils"] == {}

    def test_garbage_json_keeps_last_good_state(self, ui_dir):
        path = ui_dir / "ui.json"
        cfg = UiConfig(path)
        assert "gamma" in cfg.state().sigils
        path.write_text("{kaputt")
        os.utime(path, ns=(10**18, 10**18))  # sicher neuerer Zeitstempel
        assert "gamma" in cfg.state().sigils
        assert cfg.error and "nicht lesbar" in cfg.error
        path.write_text(json.dumps({"profiles": {}}))
        os.utime(path, ns=(2 * 10**18, 2 * 10**18))
        assert cfg.state().sigils == {} and cfg.error is None

    def test_labels_and_packs(self, tmp_path):
        (tmp_path / "packs").mkdir()
        (tmp_path / "packs" / "demo.json").write_text(json.dumps({"glyphs": {"zwei": GLYPH, "eins": GLYPH}}))
        state = parse_ui({
            "packs": ["demo"],
            "profiles": {
                "gamma": {"label": "  Gamma  "},
                "eta": {"label": "Eta", "sigil": {"type": "initials", "text": "SO"}},
                "theta": {"label": "x" * 41},
                "epsilon": {"label": 7},
            },
        }, tmp_path)
        assert state.packs == {"demo": ["eins", "zwei"]}
        assert state.labels == {"gamma": "Gamma", "eta": "Eta"}
        assert set(state.sigils) == {"eta"}
        warned = " ".join(state.warnings)
        assert "theta: label" in warned and "epsilon: label" in warned
        assert "gamma" not in warned  # nur ein Name ist ein gültiger Eintrag

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
        assert data["sigils"]["gamma"]["src"] == "/bff/ui/glyphs/japan/gamma.svg"
        assert data["ui"]["backgroundShader"]["enabled"] is False
        assert data["error"] is None

    def test_serves_sanitized_svg_with_strict_headers(self, ui_client):
        for url in ("/bff/ui/glyphs/japan/gamma.svg", "/bff/ui/sigils/mein-symbol.svg"):
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
        "/bff/ui/glyphs/..%2F/gamma.svg",
        "/bff/ui/glyphs/japan/GAMMA.svg",
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
    assert set(japan.sigils) == {"default", "zeta", "delta", "epsilon", "beta", "gamma", "alpha", "eta", "theta"}
    assert len(japan.svgs) == 9
    # Das Standardbeispiel verweist auf eine SVG-Datei, die es nur im eigenen Config-Ordner gibt: Hinweis statt Absturz.
    neutral = UiConfig(root / "ui.example.json").state()
    assert "default" in neutral.sigils and "server/hermes/helper" in neutral.sigils
    assert any("docs" in w for w in neutral.warnings)


PNG_OF_LIES = '<svg viewBox="0 0 24 24"><script>alert(1)</script></svg>'


@pytest.fixture
def save_dir(tmp_path):
    d = tmp_path / "cfg"
    d.mkdir()
    (d / "packs").mkdir()
    (d / "packs" / "japan.json").write_text(json.dumps({"glyphs": {"gamma": GLYPH}}))
    (d / "ui.json").write_text(json.dumps({
        "packs": ["japan"],
        "theme": {"accent": "crimson"},
        "profiles": {"eta": {"sigil": {"type": "initials", "text": "SO"}, "note": "bleibt"}},
    }))
    return d


@pytest.fixture
def save_client(make_settings, mock, save_dir):
    import httpx

    from tests.conftest import RouterTransport

    app = create_app(make_settings(ui_file=save_dir / "ui.json"), transport=RouterTransport({"hermes.test": httpx.ASGITransport(app=mock)}))
    with TestClient(app) as c:
        c.headers.update(HDR)
        yield c


def on_disk(d):
    return json.loads((d / "ui.json").read_text())


KEY = "server/hermes/gamma"


class TestSave:
    def test_glyph_with_label_is_written_and_served_back(self, save_client, save_dir):
        r = save_client.put(f"/bff/ui/profiles/{KEY}", json={"label": " Gamma ", "sigil": {"type": "glyph", "glyph": "neutral/bolt", "hue": 98}})
        assert r.status_code == 200
        body = r.json()
        assert body["sigils"][KEY] == {"type": "glyph", "hue": 98.0, "glyph": "neutral/bolt"}
        assert body["labels"][KEY] == "Gamma"
        saved = on_disk(save_dir)
        assert saved["profiles"][KEY] == {"label": "Gamma", "sigil": {"type": "glyph", "hue": 98.0, "glyph": "neutral/bolt"}}
        # Unbekannte Schlüssel und andere Profile bleiben, der Stand davor liegt als Sicherung daneben.
        assert saved["theme"] == {"accent": "crimson"} and saved["profiles"]["eta"]["note"] == "bleibt"
        assert "gamma" not in json.loads((save_dir / "ui.json.bak").read_text())["profiles"]
        assert save_client.get("/bff/ui").json()["sigils"][KEY]["glyph"] == "neutral/bolt"

    def test_pack_glyph_initials_and_neutral_hue(self, save_client):
        r = save_client.put(f"/bff/ui/profiles/{KEY}", json={"sigil": {"type": "glyph", "glyph": "japan/gamma", "hue": None}})
        assert r.json()["sigils"][KEY] == {"type": "glyph", "hue": None, "glyph": "japan/gamma", "src": "/bff/ui/glyphs/japan/gamma.svg"}
        r = save_client.put(f"/bff/ui/profiles/{KEY}", json={"sigil": {"type": "initials", "text": "RA"}})
        assert r.json()["sigils"][KEY] == {"type": "initials", "hue": "auto", "text": "RA"}

    def test_uploaded_svg_is_sanitized_stored_and_served(self, save_client, save_dir):
        r = save_client.put(f"/bff/ui/profiles/{KEY}", json={"sigil": {"type": "svg", "svg": GLYPH, "hue": 200}})
        assert r.status_code == 200
        src = r.json()["sigils"][KEY]["src"]
        assert src.startswith("/bff/ui/sigils/server-hermes-gamma-")
        assert save_client.get(src).headers["content-security-policy"].startswith("default-src 'none'")
        stored = list((save_dir / "sigils").glob("*.svg"))
        assert len(stored) == 1 and "<path" in stored[0].read_text()
        # Farbton ändern, ohne die Datei erneut zu senden.
        r = save_client.put(f"/bff/ui/profiles/{KEY}", json={"sigil": {"type": "svg", "hue": 10}})
        assert r.status_code == 200 and r.json()["sigils"][KEY] == {"type": "svg", "hue": 10.0, "src": src}

    def test_hostile_svg_is_refused_and_nothing_is_written(self, save_client, save_dir):
        before = (save_dir / "ui.json").read_text()
        r = save_client.put(f"/bff/ui/profiles/{KEY}", json={"sigil": {"type": "svg", "svg": PNG_OF_LIES}})
        assert r.status_code == 422 and "SVG abgelehnt" in r.json()["detail"]
        assert (save_dir / "ui.json").read_text() == before
        assert not (save_dir / "sigils").exists()
        assert save_client.put(f"/bff/ui/profiles/{KEY}", json={"sigil": {"type": "svg"}}).status_code == 422  # keine Datei, keine alte

    @pytest.mark.parametrize("sigil", [
        {"type": "glyph", "glyph": "ghost/pack"},
        {"type": "glyph", "glyph": ""},
        {"type": "glyph", "glyph": "../../etc/passwd"},
        {"type": "nichts"},
        {"type": "initials", "text": "TOOLONG"},
    ])
    def test_invalid_sigils_are_422(self, save_client, save_dir, sigil):
        before = (save_dir / "ui.json").read_text()
        assert save_client.put(f"/bff/ui/profiles/{KEY}", json={"sigil": sigil}).status_code == 422
        assert (save_dir / "ui.json").read_text() == before

    def test_label_only_and_reset(self, save_client, save_dir):
        r = save_client.put("/bff/ui/profiles/eta", json={"label": "Eta"})
        assert r.status_code == 200
        entry = on_disk(save_dir)["profiles"]["eta"]
        assert entry == {"note": "bleibt", "label": "Eta"}  # ohne sigil-Feld: Sigil ist entfernt, Unbekanntes bleibt
        assert save_client.put("/bff/ui/profiles/eta", json={}).status_code == 200
        assert on_disk(save_dir)["profiles"]["eta"] == {"note": "bleibt"}
        assert save_client.put(f"/bff/ui/profiles/{KEY}", json={"label": "A"}).status_code == 200
        assert save_client.put(f"/bff/ui/profiles/{KEY}", json={}).status_code == 200
        assert KEY not in on_disk(save_dir)["profiles"]

    @pytest.mark.parametrize("key", ["../evil", "a b", "x/y", "a" * 70])
    def test_bad_keys_are_refused(self, save_client, key):
        assert save_client.put(f"/bff/ui/profiles/{key}", json={"label": "x"}).status_code in (404, 405, 422)

    def test_label_too_long(self, save_client):
        assert save_client.put(f"/bff/ui/profiles/{KEY}", json={"label": "x" * 41}).status_code == 422

    def test_shader_defaults_are_saved_and_validated(self, save_client, save_dir):
        r = save_client.put("/bff/ui/shader", json={"enabled": False, "strength": 2.5, "speed": 0.4})
        assert r.status_code == 200 and r.json()["ui"]["backgroundShader"] == {"enabled": False, "strength": 2.5, "speed": 0.4}
        assert on_disk(save_dir)["ui"]["backgroundShader"] == {"enabled": False, "strength": 2.5, "speed": 0.4}
        for bad in ({"enabled": True, "strength": 9, "speed": 1}, {"enabled": True, "strength": 1, "speed": -1}, {"enabled": "ja", "strength": 1, "speed": 1}):
            assert save_client.put("/bff/ui/shader", json=bad).status_code == 422

    def test_needs_csrf_header_and_login(self, save_client):
        r = save_client.put(f"/bff/ui/profiles/{KEY}", json={"label": "x"}, headers={"X-Requested-With": ""})
        assert r.status_code == 403

    def test_audit_line_without_content(self, save_client, make_settings):
        save_client.put(f"/bff/ui/profiles/{KEY}", json={"label": "Geheimname", "sigil": {"type": "initials", "text": "RA"}})
        log = make_settings().audit_file.read_text()
        assert '"action":"ui.profile"' in log and KEY in log and "Geheimname" not in log

    def test_invalid_json_on_disk_is_never_overwritten(self, save_client, save_dir):
        (save_dir / "ui.json").write_text("{kaputt")
        r = save_client.put(f"/bff/ui/profiles/{KEY}", json={"label": "x"})
        assert r.status_code == 409 and "nicht überschrieben" in r.json()["detail"]
        assert (save_dir / "ui.json").read_text() == "{kaputt"

    def test_read_only_file_is_reported_and_refused(self, save_client, save_dir, monkeypatch):
        monkeypatch.setattr(os, "access", lambda *a, **k: False)
        data = save_client.get("/bff/ui").json()
        assert data["writable"] is False and "schreibgeschützt" in data["write_error"]
        r = save_client.put(f"/bff/ui/profiles/{KEY}", json={"label": "x"})
        assert r.status_code == 409 and "schreibgeschützt" in r.json()["detail"]

    def test_no_ui_file_configured(self, client):
        assert client.get("/bff/ui").json()["writable"] is False
        assert client.put(f"/bff/ui/profiles/{KEY}", json={"label": "x"}).status_code == 409
        assert client.put("/bff/ui/shader", json={"enabled": True, "strength": 1, "speed": 1}).status_code == 409

    def test_creates_the_file_when_only_the_folder_exists(self, make_settings, mock, tmp_path):
        import httpx

        from tests.conftest import RouterTransport

        target = tmp_path / "neu" / "ui.json"
        target.parent.mkdir()
        app = create_app(make_settings(ui_file=target), transport=RouterTransport({"hermes.test": httpx.ASGITransport(app=mock)}))
        with TestClient(app) as c:
            c.headers.update(HDR)
            assert c.put("/bff/ui/shader", json={"enabled": True, "strength": 1, "speed": 1}).status_code == 200
        assert json.loads(target.read_text())["ui"]["backgroundShader"]["strength"] == 1

    def test_falls_back_to_direct_write_when_replace_is_impossible(self, save_client, save_dir, monkeypatch):
        import errno

        def busy(*a, **k):
            raise OSError(errno.EBUSY, "Device or resource busy")

        monkeypatch.setattr(os, "replace", busy)
        assert save_client.put("/bff/ui/profiles/eta", json={"label": "Eta"}).status_code == 200
        assert on_disk(save_dir)["profiles"]["eta"]["label"] == "Eta"
        assert not list(save_dir.glob(".ui.json.*.tmp"))
