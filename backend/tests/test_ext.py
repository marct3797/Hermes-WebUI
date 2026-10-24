"""Paket ext: Verwaltung (Skills, MCP, Plugins), Marktplatz, eigene Quellen und SSRF-Schutz gegen das Dashboard-Mock in echten Formen."""
import json
import stat

import httpx
import pytest
from fastapi.testclient import TestClient

from app import marketplace as mk
from app.auth import SESSION_COOKIE, User
from app.main import create_app
from conftest import HDR, RouterTransport
from devtools.mock_ext import create_mock, create_registry

PUBLIC = {"registry.test": ["93.184.216.34"], "registry.modelcontextprotocol.io": ["93.184.216.36"], "evil.example.org": ["93.184.216.35"], "intern.test": ["10.0.0.5"], "lo.test": ["127.0.0.1"],
          "v6.test": ["fe80::1"], "mapped.test": ["::ffff:10.0.0.1"], "mixed.test": ["93.184.216.34", "192.168.1.5"]}
SKILL = "---\nname: delta\ndescription: Ein Beispiel\n---\n# Delta\n"


async def resolver(host, port):
    if host not in PUBLIC:
        raise OSError("unbekannt")
    return PUBLIC[host]


def build(tmp_path, make_settings, mode="none", **kw):
    f = tmp_path / "hosts.json"
    agent = {"id": "hermes", "base_url": "http://daemon.test", "api_key": "k", "multiplex": True, "agents": ["default", "beta"]}
    f.write_text(json.dumps({"hosts": [{"id": "ct", "runtimes": [{**agent, "dashboard": {"base_url": "http://dash.test"}}]}, {"id": "plain", "runtimes": [agent]}]}))
    dash, reg = create_mock(**kw), create_registry()
    transport = RouterTransport({"dash.test": httpx.ASGITransport(app=dash), "registry.test": httpx.ASGITransport(app=reg), "registry.modelcontextprotocol.io": httpx.ASGITransport(app=reg),
                                 "evil.example.org": httpx.ASGITransport(app=reg), "10.0.0.5": httpx.ASGITransport(app=reg)})
    extra = dict(auth_mode="oidc", oidc_issuer="https://id.test", oidc_client_id="t", oidc_client_secret="t", oidc_allowed_sub="user",
                 public_url="http://testserver") if mode == "oidc" else {}
    settings = make_settings(hosts_file=f, marketplaces_file=tmp_path / "marketplaces.json", **extra)
    app = create_app(settings, transport=transport)
    app.state.resolver = resolver
    return app, dash.state.s, reg


@pytest.fixture
def ext(tmp_path, make_settings):
    app, dash, reg = build(tmp_path, make_settings)
    with TestClient(app) as c:
        c.headers.update(HDR)
        yield c, dash, reg, tmp_path


E = "/bff/h/ct/_ext/default"
M = "/bff/h/ct/_market"


def audit_text(tmp_path):
    return (tmp_path / "audit.log").read_text()


# --- Skills ---
def test_skill_list_and_content_hide_paths(ext):
    c, s, _, _ = ext
    skills = c.get(f"{E}/skill-list").json()["skills"]
    assert [x["name"] for x in skills] == ["claude-code", "codex", "gamma", "alpha"]
    assert skills[2]["provenance"] == "hub" and skills[3]["enabled"] is False
    got = c.get(f"{E}/skills/claude-code").json()
    assert got["content"].startswith("---\nname: claude-code") and "path" not in got and "/opt/" not in json.dumps(got)
    assert c.get(f"{E}/skills/nope").status_code == 404
    assert c.get(f"{E}/skills/..%2Fx").status_code in (404, 422)
    assert c.get(f"{E}/skills/a..b").status_code == 422
    assert c.get("/bff/h/ct/_ext/default/skills/claude-code", params={}).status_code == 200
    assert s.calls[0][3] == {"profile": "default"}


def test_skill_save_validates_frontmatter_and_size(ext):
    c, s, _, tmp = ext
    ok = c.put(f"{E}/skills/alpha", json={"content": "---\nname: alpha\ndescription: Neu\n---\ntext"})
    assert ok.status_code == 200 and s.contents["alpha"].endswith("text")
    for bad, why in [("kein frontmatter", "Frontmatter"), ("---\ndescription: x\n---\n", "name:"), ("---\nname: andere\ndescription: x\n---\n", "erwartet wird alpha"),
                     ("---\nname: alpha\n---\n", "description")]:
        r = c.put(f"{E}/skills/alpha", json={"content": bad})
        assert r.status_code == 422 and why in r.json()["detail"], (bad, r.text)
    assert c.put(f"{E}/skills/alpha", json={"content": "x" * (200 * 1024 + 1)}).status_code == 422
    assert c.put(f"{E}/skills/alpha", json={"content": SKILL, "extra": 1}).status_code == 422
    audit = audit_text(tmp)
    assert "ext.skill.save" in audit and "Neu" not in audit and "text" not in audit.replace("ext.skill", "")


def test_skill_folded_description_is_accepted(ext):
    c, *_ = ext
    folded = "---\nname: alpha\ndescription: >-\n  Lang und\n  umbrochen\n---\n"
    assert c.put(f"{E}/skills/alpha", json={"content": folded}).status_code == 200


def test_skill_create_toggle_and_errors(ext):
    c, s, _, _ = ext
    assert c.post(f"{E}/skills", json={"name": "delta", "category": "beispiel", "content": SKILL}).json() == {"ok": True, "name": "delta"}
    assert "delta" in s.contents
    assert c.post(f"{E}/skills", json={"name": "delta", "content": SKILL}).status_code == 502  # gibt es schon: Fehlertext des Dashboards
    assert "400" in c.post(f"{E}/skills", json={"name": "delta", "content": SKILL}).json()["detail"]
    for bad in ({"name": "../x", "content": SKILL}, {"name": "Gross", "content": SKILL}, {"name": "delta", "category": "a/b", "content": SKILL},
                {"name": "delta", "content": "ohne"}, {"name": "delta", "content": SKILL.replace("delta", "x")}):
        assert c.post(f"{E}/skills", json=bad).status_code == 422, bad
    assert c.put(f"{E}/skills/alpha/enabled", json={"enabled": True}).json() == {"ok": True, "name": "alpha", "enabled": True}
    assert next(k for k in s.skills if k["name"] == "alpha")["enabled"] is True
    assert c.put(f"{E}/skills/alpha/enabled", json={"enabled": "ja"}).status_code == 422


def test_skill_update_and_uninstall_only_for_hub_skills(ext):
    c, s, _, _ = ext
    assert c.post(f"{E}/skills/codex/update").status_code == 409
    assert c.delete(f"{E}/skills/codex").status_code == 409
    assert c.delete(f"{E}/skills/ghost").status_code == 404
    assert c.post(f"{E}/skills/gamma/update").json() == {"ok": True, "started": True}
    assert c.delete(f"{E}/skills/gamma").json()["ok"] is True
    assert ("POST", "/api/skills/hub/uninstall", {"name": "gamma"}, {"profile": "default"}) in s.calls


def test_upstream_errors_and_missing_dashboard(ext):
    c, s, _, _ = ext
    s.fail["/api/skills"] = 500
    assert c.get(f"{E}/skill-list").status_code == 502
    assert c.get("/bff/h/plain/_ext/default/skill-list").status_code == 503
    assert c.get("/bff/h/nope/_ext/default/skill-list").status_code == 404
    assert c.get("/bff/h/ct/_ext/bad..name/skill-list").status_code == 422


# --- MCP ---
def test_mcp_list_never_shows_env_values_or_url_query(ext):
    c, _, _, _ = ext
    servers = {x["name"]: x for x in c.get(f"{E}/mcp").json()["servers"]}
    assert servers["rag"]["env_names"] == ["EXAMPLE_API_URL"] and "env" not in servers["rag"]
    assert servers["plug"]["url"] == "https://example.com/mcp" and servers["plug"]["tool_count"] == 2 and servers["plug"]["source"] == "plugin"
    assert servers["rag"]["tool_count"] is None and servers["rag"]["transport"] == "stdio"
    text = json.dumps(servers)
    assert "geheim" not in text and "http...8000" not in text


def test_mcp_add_stdio_and_http_with_token_never_echoed(ext):
    c, s, _, tmp = ext
    r = c.post(f"{E}/mcp", json={"name": "alpha-db", "transport": "stdio", "command": "npx", "args": ["-y", "pkg"], "env": {"DB_KEY": "supergeheim"}})
    assert r.status_code == 200 and r.json()["env_names"] == ["DB_KEY"] and "supergeheim" not in r.text
    r = c.post(f"{E}/mcp", json={"name": "web", "transport": "http", "url": "https://example.com/mcp", "auth": "header", "bearer_token": "tok-123456"})
    assert r.status_code == 200 and "tok-123456" not in r.text and s.bearer["web"] == "tok-123456"
    audit = audit_text(tmp)
    assert "supergeheim" not in audit and "tok-123456" not in audit and "DB_KEY" in audit and "ext.mcp.add" in audit
    assert c.post(f"{E}/mcp", json={"name": "web", "transport": "http", "url": "https://example.com/mcp"}).status_code == 502  # doppelt


@pytest.mark.parametrize("body", [
    {"name": "a b", "transport": "stdio", "command": "x"},
    {"name": "x", "transport": "stdio"},
    {"name": "x", "transport": "stdio", "command": "x", "url": "https://e.com"},
    {"name": "x", "transport": "stdio", "command": "x", "auth": "oauth"},
    {"name": "x", "transport": "stdio", "command": "x", "env": {"1BAD": "v"}},
    {"name": "x", "transport": "stdio", "command": "x", "env": {"OK": "v" * 5000}},
    {"name": "x", "transport": "http"},
    {"name": "x", "transport": "http", "url": "ftp://e.com"},
    {"name": "x", "transport": "http", "url": "https://user:pw@e.com"},
    {"name": "x", "transport": "http", "url": "https://e.com", "command": "x"},
    {"name": "x", "transport": "http", "url": "https://e.com", "auth": "header"},
    {"name": "x", "transport": "http", "url": "https://e.com", "bearer_token": "t"},
    {"name": "x", "transport": "grpc", "command": "x"},
    {"name": "x", "transport": "stdio", "command": "x", "unbekannt": 1},
])
def test_mcp_add_validation(ext, body):
    c, s, _, _ = ext
    assert c.post(f"{E}/mcp", json=body).status_code == 422
    assert not [x for x in s.calls if x[0] == "POST" and x[1] == "/api/mcp/servers"]


def test_mcp_args_hide_secret_values():
    from app.extensions import safe_args
    assert safe_args(["--api-key", "abc", "--port", "1", "--token=xyz", "plain"]) == ["--api-key", "«gesetzt»", "--port", "1", "--token=«gesetzt»", "plain"]


def test_mcp_toggle_test_auth_remove(ext):
    c, s, _, tmp = ext
    assert c.put(f"{E}/mcp/rag/enabled", json={"enabled": False}).json()["enabled"] is False
    assert s.mcp[0]["enabled"] is False
    t = c.post(f"{E}/mcp/rag/test").json()
    assert t["ok"] and [x["name"] for x in t["tools"]] == ["search", "fetch"] and t["resources"] == 2
    a = c.post(f"{E}/mcp/rag/auth").json()
    assert a["authorization_url"].startswith("https://auth.example.com/") and a["flow_id"] == "flow_abcdefgh"
    assert c.get(f"{E}/mcp/oauth/flow_abcdefgh").json()["status"] == "completed"
    assert c.get(f"{E}/mcp/oauth/x").status_code == 422
    assert c.delete(f"{E}/mcp/rag").json() == {"ok": True}
    assert c.delete(f"{E}/mcp/rag").status_code == 404
    assert "ext.mcp.remove" in audit_text(tmp) and "authorize" not in audit_text(tmp)


def test_mcp_catalog_and_install_with_env(ext):
    c, s, _, tmp = ext
    entries = {e["name"]: e for e in c.get(f"{E}/mcp/catalog").json()["entries"]}
    assert entries["beta-db"]["required_env"] == [{"name": "BETA_DB_KEY", "prompt": "Zugangsschlüssel", "required": True}]
    assert entries["airtable"]["transport"] == "http" and entries["airtable"]["auth_type"] == "oauth"
    r = c.post(f"{E}/mcp/catalog/install", json={"name": "beta-db", "env": {"BETA_DB_KEY": "streng-geheim"}, "enable": True})
    assert r.json() == {"ok": True, "name": "beta-db"} and "streng-geheim" not in audit_text(tmp)
    assert [x for x in s.calls if x[1] == "/api/mcp/catalog/install"][-1][2]["env"] == {"BETA_DB_KEY": "streng-geheim"}
    assert c.post(f"{E}/mcp/catalog/install", json={"name": "unbekannt"}).status_code == 404
    assert c.post(f"{E}/mcp/catalog/install", json={"name": "../x"}).status_code == 422


# --- Plugins ---
def test_plugins_list_hides_paths_and_actions(ext):
    c, s, _, tmp = ext
    plugins = c.get(f"{E}/plugins").json()["plugins"]
    assert [p["name"] for p in plugins] == ["browser-browser-use", "browser-browserbase", "beta-plugin"]
    assert "/opt/" not in json.dumps(plugins) and plugins[0]["can_remove"] is False and plugins[2]["can_update_git"] is True
    assert c.post(f"{E}/plugins/beta-plugin/disable").json()["ok"] is True
    assert s.plugins[2]["runtime_status"] == "disabled"
    assert c.post(f"{E}/plugins/beta-plugin/enable").json()["ok"] is True
    assert c.post(f"{E}/plugins/beta-plugin/update", json={"accept_capabilities": True}).status_code == 200
    assert [x for x in s.calls if x[1].endswith("/update")][-1][2] == {"accept_capabilities": True}
    assert c.post(f"{E}/plugins/beta-plugin/restart").status_code == 422
    assert c.post(f"{E}/plugins/a..b/enable").status_code == 422
    assert c.post(f"{E}/plugins/ghost/enable").status_code == 502
    assert "ext.plugin.disable" in audit_text(tmp)


def test_plugin_remove_only_when_allowed(ext):
    c, s, _, _ = ext
    assert c.delete(f"{E}/plugins/browser-browser-use").status_code == 409
    assert c.delete(f"{E}/plugins/ghost").status_code == 404
    assert c.delete(f"{E}/plugins/beta-plugin").json() == {"ok": True}
    assert "beta-plugin" not in [p["name"] for p in s.plugins]


def test_plugin_install_validation_consent_and_no_paths(ext):
    c, s, _, _ = ext
    r = c.post(f"{E}/plugins/install", json={"identifier": "owner/repo"})
    assert r.json() == {"ok": True, "name": "installed-plugin"}
    assert c.post(f"{E}/plugins/install", json={"identifier": "https://example.com/o/r.git", "ref": "a" * 40}).status_code == 200
    assert c.post(f"{E}/plugins/install", json={"catalog_name": "0bull"}).status_code == 200
    consent = c.post(f"{E}/plugins/install", json={"identifier": "needs/consent"}).json()
    assert consent["consent_required"] is True and consent["ok"] is False
    for bad in ({"identifier": "../etc"}, {"identifier": "http://example.com/o/r"}, {"identifier": "a b/c"}, {"identifier": "o/r", "ref": "main"},
                {"identifier": "o/r", "catalog_name": "x"}, {}, {"identifier": "https://example.com/o?x=1"}, {"identifier": "https://u:p@example.com/o/r"}):
        assert c.post(f"{E}/plugins/install", json=bad).status_code == 422, bad
    entries = c.get(f"{E}/plugins/catalog").json()["entries"]
    assert entries[0]["name"] == "0bull" and entries[0]["tier"] == "community" and entries[0]["repo"].startswith("https://github.com/")


# --- Marktplatz ---
def test_market_featured_official_and_search(ext):
    c, s, _, _ = ext
    featured = c.get(f"{M}/skills").json()
    assert featured["featured"] is True and featured["results"][0]["identifier"] == "official/security/1password"
    assert featured["results"][0]["trust_level"] == "builtin" and featured["results"][0]["installed"] is False
    off = c.get(f"{M}/skills", params={"source": "official"}).json()
    assert off["results"][0]["category"] == "autonomous-ai-agents" and "autonomous-ai-agents" in off["categories"]
    assert [r["name"] for r in c.get(f"{M}/skills", params={"source": "official", "category": "nichts"}).json()["results"]] == []
    found = c.get(f"{M}/skills", params={"q": "pr review", "source": "browse-sh"}).json()
    assert found["results"][0]["source"] == "browse-sh" and found["source_counts"]["browse-sh"] == 9
    hub = [x for x in s.calls if x[1] == "/api/skills/hub/search"][-1]
    assert hub[3]["q"] == "pr review" and hub[3]["source"] == "browse-sh" and hub[3]["profile"] == "default"
    assert c.get(f"{M}/skills", params={"source": "../x"}).status_code == 422
    assert c.get(f"{M}/skills", params={"source": "browse-sh"}).json()["note"]


def test_market_marks_installed(ext):
    c, s, _, _ = ext
    s.fx["hub_search"]["installed"]["browse-sh/github.com/get-pr-review-st0euo"] = {"name": "x"}
    res = c.get(f"{M}/skills", params={"q": "pr"}).json()["results"]
    assert res[0]["installed"] is True and res[1]["installed"] is False


def test_market_preview_and_scan(ext):
    c, s, _, _ = ext
    ident = "browse-sh/github.com/get-pr-review-st0euo"
    pv = c.get(f"{M}/skills/preview", params={"identifier": ident}).json()
    assert pv["skill_md"].startswith("---\nname: get-pr-review") and pv["files"] == ["SKILL.md"] and pv["trust_level"] == "community"
    sc = c.get(f"{M}/skills/scan", params={"identifier": ident}).json()
    assert sc["verdict"] == "safe" and sc["policy"] == "allow" and sc["findings"] == []
    for bad in ("../x", "a", "x y/z", "http://example.com/a.md", "https://u:p@example.com/a.md", "official/../x", "a/b?c"):
        assert c.get(f"{M}/skills/preview", params={"identifier": bad}).status_code == 422, bad
    assert c.get(f"{M}/skills/preview", params={"identifier": "https://example.com/dir/SKILL.md"}).status_code == 200
    assert c.get(f"{M}/skills/preview", params={"identifier": "well-known:https://example.com/.well-known/skills/x"}).status_code == 200
    assert c.get(f"{M}/skills/preview", params={"identifier": "NousResearch/hermes-agent/optional-skills/security/1password"}).status_code == 200


def test_install_into_two_profiles_after_safe_scan(ext):
    c, s, _, tmp = ext
    r = c.post(f"{M}/skills/install", json={"identifier": "official/security/1password", "profiles": ["default", "beta", "beta"]}).json()
    assert [x["profile"] for x in r["results"]] == ["default", "beta"] and all(x["ok"] for x in r["results"]) and r["scan"]["verdict"] == "safe"
    installs = [x for x in s.calls if x[1] == "/api/skills/hub/install"]
    assert [i[3]["profile"] for i in installs] == ["default", "beta"] and installs[0][2] == {"identifier": "official/security/1password"}
    audit = audit_text(tmp)
    assert audit.count("market.skill.install") == 2


def test_install_requires_acceptance_for_findings_and_blocks_dangerous(tmp_path, make_settings):
    for verdict, code in (("caution", "scan_confirm_required"), ("dangerous", "scan_blocked")):
        app, dash, _ = build(tmp_path, make_settings, verdict=verdict)
        with TestClient(app) as c:
            c.headers.update(HDR)
            r = c.post(f"{M}/skills/install", json={"identifier": "official/x/y", "profiles": ["default"]})
            assert r.status_code == 409 and r.json()["detail"]["code"] == code and r.json()["detail"]["scan"]["findings"]
            assert not [x for x in dash.calls if x[1] == "/api/skills/hub/install"]
            r = c.post(f"{M}/skills/install", json={"identifier": "official/x/y", "profiles": ["default"], "accept_risk": True})
            assert (r.status_code == 200) == (verdict == "caution")  # blockiert bleibt blockiert, auch mit Zustimmung


def test_install_reports_failures_per_profile_and_validates(ext):
    c, s, _, _ = ext
    s.fail["hub/install"] = 500
    r = c.post(f"{M}/skills/install", json={"identifier": "official/x/y", "profiles": ["default", "beta"]}).json()
    assert [x["ok"] for x in r["results"]] == [False, False] and "500" in r["results"][0]["error"]
    for bad in ({"identifier": "official/x/y", "profiles": []}, {"identifier": "../x", "profiles": ["default"]}, {"identifier": "official/x/y", "profiles": ["../x"]},
                {"identifier": "official/x/y", "profiles": ["default"], "x": 1}, {"identifier": "official/x/y", "profiles": [f"p{i}" for i in range(21)]}):
        assert c.post(f"{M}/skills/install", json=bad).status_code == 422, bad


def test_market_mcp_and_plugin_catalogs_filter(ext):
    c, *_ = ext
    names = [e["name"] for e in c.get(f"{M}/mcp").json()["entries"]]
    assert names == ["airtable", "algolia", "beta-db"]
    assert [e["name"] for e in c.get(f"{M}/mcp", params={"q": "datenbank"}).json()["entries"]] == ["beta-db"]
    plug = c.get(f"{M}/plugins").json()
    assert [e["name"] for e in plug["entries"]] == ["0bull", "aave-mcp"] and plug["categories"] and plug["custom"] == []
    assert [e["name"] for e in c.get(f"{M}/plugins", params={"q": "aave"}).json()["entries"]] == ["aave-mcp"]
    assert c.get(f"{M}/plugins", params={"category": "gibt-es-nicht"}).json()["entries"] == []


# --- Eigene Quellen ---
def test_sources_crud_persistence_permissions_and_audit(ext):
    c, _, _, tmp = ext
    assert c.get("/bff/market/sources").json()["custom"] == [] and c.get("/bff/market/sources").json()["builtin"][0]["id"] == "official-registry"
    a = c.post("/bff/market/sources", json={"label": "Meine Skills", "kind": "github", "target": "owner/repo/skills"})
    assert a.status_code == 200 and a.json()["id"].startswith("github-")
    b = c.post("/bff/market/sources", json={"label": "Registry", "kind": "mcp-registry", "target": "https://registry.test"}).json()
    f = tmp / "marketplaces.json"
    assert stat.S_IMODE(f.stat().st_mode) == 0o600 and [x["id"] for x in json.loads(f.read_text())["sources"]] == [a.json()["id"], b["id"]]
    assert c.post("/bff/market/sources", json={"label": "Doppelt", "kind": "github", "target": "owner/repo/skills"}).status_code == 409
    listed = c.get("/bff/market/sources").json()["custom"]
    assert [x["label"] for x in listed] == ["Meine Skills", "Registry"]
    assert c.delete(f"/bff/market/sources/{a.json()['id']}").json() == {"ok": True}
    assert c.delete(f"/bff/market/sources/{a.json()['id']}").status_code == 404
    assert c.delete("/bff/market/sources/official-registry").status_code == 422  # vorinstalliert: nicht löschbar
    assert [x["id"] for x in c.get("/bff/market/sources").json()["custom"]] == [b["id"]]
    audit = audit_text(tmp)
    assert "market.source.add" in audit and "market.source.remove" in audit


@pytest.mark.parametrize("kind,target", [
    ("github", "../x"), ("github", "nur-ein-name"), ("github", "o/r/../x"), ("well-known", "http://example.com"), ("well-known", "https://u:p@example.com"),
    ("well-known", "https://example.com:8443/x"), ("well-known", "https://example.com/x?a=1"), ("url", "https://example.com/readme.txt"),
    ("mcp-registry", "http://registry.test"), ("mcp-registry", "https://intern.test"), ("mcp-registry", "https://lo.test"), ("mcp-registry", "https://127.0.0.1"),
    ("mcp-registry", "https://[::1]"), ("mcp-registry", "https://mapped.test"), ("mcp-registry", "https://mixed.test"), ("mcp-registry", "https://v6.test"),
    ("mcp-registry", "https://gibt-es-nicht.test"), ("plugin-git", "http://example.com/o/r"), ("plugin-git", "a b"), ("mcp-registry", "https://169.254.169.254"),
])
def test_source_targets_are_rejected(ext, kind, target):
    c, *_ = ext
    r = c.post("/bff/market/sources", json={"label": "X", "kind": kind, "target": target})
    assert r.status_code in (422, 502), r.text
    assert c.get("/bff/market/sources").json()["custom"] == []


def test_source_label_kind_and_limit(ext):
    c, _, _, tmp = ext
    for bad in ({"label": "", "kind": "github", "target": "o/r"}, {"label": "x" * 61, "kind": "github", "target": "o/r"},
                {"label": "A", "kind": "ftp", "target": "o/r"}, {"label": "A", "kind": "github", "target": "o/r", "extra": 1}):
        assert c.post("/bff/market/sources", json=bad).status_code == 422
    store = mk.Marketplaces(tmp / "x.json")
    for i in range(mk.MAX_SOURCES):
        store.add(f"S{i}", "github", f"owner/repo{i}")
    with pytest.raises(mk.SourceError, match="höchstens 50"):
        store.add("Zuviel", "github", "owner/extra")


def test_unwritable_sources_file_is_reported(tmp_path, make_settings):
    app, *_ = build(tmp_path, make_settings)
    app.state.settings.marketplaces_file = tmp_path / "gibt-es-nicht" / "m.json"
    with TestClient(app) as c:
        c.headers.update(HDR)
        r = c.post("/bff/market/sources", json={"label": "A", "kind": "github", "target": "o/r"})
        assert r.status_code == 503 and "lässt sich nicht schreiben" in r.json()["detail"]


def test_host_sources_merge_hub_builtin_and_custom(ext):
    c, *_ = ext
    c.post("/bff/market/sources", json={"label": "Eigene", "kind": "github", "target": "owner/repo"})
    src = c.get(f"{M}/sources").json()["sources"]
    assert [x["ref"] for x in src][:2] == ["official", "hermes-index"] and "official" in [x["ref"] for x in src]
    assert src[-1]["builtin"] is False and src[-1]["ref"].startswith("custom:github-")
    assert next(x for x in src if x["id"] == "skills-sh")["searchable"] is False


def test_custom_sources_drive_the_skill_search(ext):
    c, s, _, _ = ext
    gh = c.post("/bff/market/sources", json={"label": "G", "kind": "github", "target": "owner/repo"}).json()["id"]
    wk = c.post("/bff/market/sources", json={"label": "W", "kind": "well-known", "target": "https://example.com"}).json()["id"]
    ur = c.post("/bff/market/sources", json={"label": "U", "kind": "url", "target": "https://example.com/dir/SKILL.md"}).json()["id"]
    bad = c.post("/bff/market/sources", json={"label": "M", "kind": "url", "target": "https://missing.example.com/x.md"}).json()["id"]
    reg = c.post("/bff/market/sources", json={"label": "R", "kind": "mcp-registry", "target": "https://registry.test"}).json()["id"]
    res = c.get(f"{M}/skills", params={"q": "one", "source": f"custom:{gh}"}).json()["results"]
    assert [r["identifier"] for r in res] == ["owner/repo/skills/one"]  # fremdes Repo wird herausgefiltert
    assert "note" in c.get(f"{M}/skills", params={"source": f"custom:{gh}"}).json() and c.get(f"{M}/skills", params={"source": f"custom:{gh}"}).json()["note"]
    res = c.get(f"{M}/skills", params={"source": f"custom:{wk}"}).json()["results"]
    assert res[0]["identifier"] == "well-known:https://example.com/demo"
    assert [x for x in s.calls if x[1] == "/api/skills/hub/search"][-1][3]["source"] == "well-known"
    assert c.get(f"{M}/skills", params={"source": f"custom:{ur}"}).json()["results"][0]["identifier"] == "https://example.com/dir/SKILL.md"
    assert c.get(f"{M}/skills", params={"source": f"custom:{bad}"}).json()["results"] == []
    assert c.get(f"{M}/skills", params={"source": f"custom:{reg}"}).json()["note"]
    assert c.get(f"{M}/skills", params={"source": "custom:github-00000000"}).status_code == 404


def test_plugin_git_sources_show_up_in_plugin_market(ext):
    c, *_ = ext
    c.post("/bff/market/sources", json={"label": "Mein Git", "kind": "plugin-git", "target": "owner/plugin"})
    assert c.get(f"{M}/plugins").json()["custom"][0]["target"] == "owner/plugin"


# --- MCP-Registry und SSRF ---
def test_registry_entries_are_normalized(ext):
    c, _, reg, _ = ext
    data = c.get("/bff/market/registry", params={"q": "alpha"}).json()
    by = {e["name"]: e for e in data["entries"]}
    alpha = by["io.example/alpha-mcp"]
    assert alpha["transport"] == "stdio" and alpha["command"] == "npx" and alpha["args"] == ["-y", "alpha-mcp@1.2.0"] and alpha["installable"] is True
    assert alpha["env"] == [{"name": "ALPHA_TOKEN", "description": "Zugang", "required": True, "secret": True}] and alpha["slug"] == "alpha-mcp"
    assert by["io.example/beta"]["url"] == "https://mcp.example.com/mcp" and "geheim" not in json.dumps(data)
    assert by["io.example/gamma"]["installable"] is False and data["cursor"] == "next1"
    assert reg.state.hits[0] == {"search": "alpha", "limit": "30", "version": "latest"}


def test_registry_uses_custom_source_by_id_only(ext):
    c, _, reg, _ = ext
    rid = c.post("/bff/market/sources", json={"label": "R", "kind": "mcp-registry", "target": "https://registry.test"}).json()["id"]
    assert len(c.get("/bff/market/registry", params={"source": rid}).json()["entries"]) == 3
    assert c.get("/bff/market/registry", params={"source": "https://intern.test"}).status_code == 422
    assert c.get("/bff/market/registry", params={"source": "github-00000000"}).status_code == 404
    gh = c.post("/bff/market/sources", json={"label": "G", "kind": "github", "target": "o/r"}).json()["id"]
    assert c.get("/bff/market/registry", params={"source": gh}).status_code == 404


@pytest.fixture
def reg_url(ext):
    c, _, _, _ = ext

    def to(path: str, host: str = "registry.test") -> str:
        entry = {"label": "R", "kind": "mcp-registry", "target": f"https://{host}{path}"}
        # Direkt in die Datei, weil der SSRF-Schutz beim Anlegen schon greift (private Ziele könnten später per DNS dorthin zeigen).
        store = c.app.state.marketplaces if getattr(c.app.state, "marketplaces", None) else None
        if store is None:
            c.get("/bff/market/sources")
            store = c.app.state.marketplaces
        sid = f"mcp-registry-{abs(hash(path + host)) % 10**8:08x}"
        store._write([*store.list(), {"id": sid, "label": entry["label"], "kind": "mcp-registry", "target": entry["target"]}])
        return sid
    return to


def test_ssrf_redirects_and_limits(ext, reg_url):
    c, *_ = ext
    same = c.get("/bff/market/registry", params={"source": reg_url("/redir/same")})
    assert same.status_code == 200 and len(same.json()["entries"]) == 3  # Weiterleitung innerhalb des Hosts wird verfolgt
    other = c.get("/bff/market/registry", params={"source": reg_url("/redir/other")})
    assert other.status_code == 422 and "anderen Host" in other.json()["detail"]
    private = c.get("/bff/market/registry", params={"source": reg_url("/redir/private")})
    assert private.status_code == 422
    big = c.get("/bff/market/registry", params={"source": reg_url("/big")})
    assert big.status_code == 502 and "1 MiB" in big.json()["detail"]
    bad = c.get("/bff/market/registry", params={"source": reg_url("/bad")})
    assert bad.status_code == 502 and "JSON" in bad.json()["detail"]
    internal = c.get("/bff/market/registry", params={"source": reg_url("", "intern.test")})
    assert internal.status_code == 422 and "nicht öffentlich" in internal.json()["detail"]


def test_ssrf_helpers():
    import asyncio
    for ip in ("10.0.0.1", "127.0.0.1", "169.254.169.254", "192.168.0.1", "172.16.0.1", "100.64.0.1", "::1", "fe80::1", "fc00::1", "::ffff:10.0.0.1", "0.0.0.0", "224.0.0.1"):
        assert not mk.is_public(ip), ip
    assert mk.is_public("93.184.216.34") and mk.is_public("2606:2800:220:1:248:1893:25c8:1946")
    for url in ("http://registry.test", "https://registry.test:8443", "https://u@registry.test", "ftp://registry.test", "https://", "https://registry.test/#f"):
        with pytest.raises(mk.SourceError):
            asyncio.run(mk.check_public_url(url, resolver))
    assert asyncio.run(mk.check_public_url("https://registry.test/x", resolver)) == "registry.test"


def test_registry_timeout_is_reported(ext, monkeypatch):
    c, *_ = ext

    async def slow(*a, **k):
        raise httpx.ReadTimeout("zu langsam")
    monkeypatch.setattr(httpx.AsyncClient, "stream", lambda self, *a, **k: (_ for _ in ()).throw(httpx.ReadTimeout("t")))
    r = c.get("/bff/market/registry")
    assert r.status_code == 504 and "8 Sekunden" in r.json()["detail"]


# --- Zugriff ---
def test_all_routes_need_login_and_writes_need_fresh_login(tmp_path, make_settings):
    app, *_ = build(tmp_path, make_settings, mode="oidc")
    with TestClient(app) as c:
        c.headers.update(HDR)
        assert c.get(f"{E}/skill-list").status_code == 401 and c.get("/bff/market/sources").status_code == 401 and c.get(f"{M}/skills").status_code == 401
        session = app.state.sessions.create(User("user", "Test"))
        c.cookies.set(SESSION_COOKIE, session.id)
        session.auth_time = app.state.sessions.now() - 3 * 3600  # Anmeldung zu alt
        assert c.get(f"{E}/skill-list").status_code == 200
        for method, url, body in (("PUT", f"{E}/skills/alpha", {"content": SKILL}), ("POST", f"{E}/mcp/rag/test", None), ("DELETE", f"{E}/mcp/rag", None),
                                  ("POST", "/bff/market/sources", {"label": "A", "kind": "github", "target": "o/r"}),
                                  ("POST", f"{M}/skills/install", {"identifier": "official/x/y", "profiles": ["default"]})):
            r = c.request(method, url, json=body)
            assert r.status_code == 401 and r.json()["detail"]["code"] == "step_up_required", (url, r.text)
        session.auth_time = app.state.sessions.now()
        assert c.post(f"{E}/mcp/rag/test").status_code == 200
