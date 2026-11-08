"""Etappe 1 der Abdeckung: Checkpoints, Sicherheitsprüfung, Drain, Update-Beleg, Standardwerte, Roh-YAML, Zeitplan abbrechen, OAuth abmelden."""
import json

import pytest

from devtools.mock_dashboard import create_mock as create_dashboard
from tests.conftest import BASE
from tests.test_hermes_lifecycle import logged_in

OPS = f"{BASE}/hermes-ops"


@pytest.fixture
def env(tmp_path, make_settings):
    yield from logged_in(tmp_path, make_settings, create_dashboard())


def audited(env) -> str:
    return env.audit_file.read_text()


def test_checkpoints_list_has_no_paths(env):
    b = env.get(f"{OPS}/checkpoints").json()
    assert {s["session"] for s in b["sessions"]} == {"run_aaa", "run_bbb"} and b["total_bytes"] == 2560
    assert "/opt/data" not in json.dumps(b)


def test_checkpoints_prune_needs_the_agent_id_and_runs(env):
    r = env.post(f"{OPS}/checkpoints/prune", json={"confirm": "x"})
    assert r.status_code == 422 and env.dash.state.checkpoints
    assert env.post(f"{OPS}/checkpoints/prune", json={"confirm": "default"}).status_code == 202
    assert env.dash.state.checkpoints == []
    assert "hermes_ops.checkpoints_prune" in audited(env)
    log = env.get(f"{OPS}/actions/checkpoints-prune").json()
    assert log["exit_code"] == 0 and "sk-LEAK" not in json.dumps(log) and "/home/geheim" not in log["log"] and "[Pfad]" in log["log"]


def test_security_audit_runs_and_log_is_redacted(env):
    assert env.post(f"{OPS}/security-audit").status_code == 202
    log = env.get(f"{OPS}/actions/security-audit").json()
    assert "2 Hinweise" in log["log"] and "sk-LEAK" not in json.dumps(log)


def test_unknown_action_name_is_rejected(env):
    assert env.get(f"{OPS}/actions/rm-rf").status_code == 422


def test_drain_needs_a_typed_word_but_cancel_does_not(env):
    d = f"{BASE}/gateway/drain"
    assert env.post(d, json={"action": "drain"}).status_code == 422
    assert not env.dash.state.drain["draining"]
    assert env.post(d, json={"action": "drain", "confirm": "leeren"}).json()["ok"]
    assert env.dash.state.drain["draining"]
    assert env.post(d, json={"action": "cancel"}).json()["was_draining"] is True
    assert not env.dash.state.drain["draining"]
    assert env.post(d, json={"action": "restart"}).status_code == 422
    assert "gateway_drain_drain" in audited(env)


def test_update_receipt_keeps_followups_and_drops_paths_and_shas(env):
    b = env.get(f"{OPS}/update-receipt").json()["receipt"]
    assert b["outcome"] == "success" and b["post_version"] == "0.22.5"
    assert b["followups"] and "/opt/data" not in json.dumps(b) and "[Pfad]" in b["followups"][0]
    assert b["user_action"]["message"] == "Bitte hermes setup ausführen"
    assert "steps" not in b and "path" not in b and "pre_sha" not in b and "post_sha" not in b


def test_update_receipt_missing_is_data_not_error(env):
    env.dash.state.receipt = False
    assert env.get(f"{OPS}/update-receipt").json() == {"receipt": None}


def test_config_defaults_never_carry_secrets(env):
    d = env.get(f"{BASE}/hermes-config/defaults").json()["defaults"]
    assert d["agent"]["max_turns"] == 90 and "api_key" not in d["model"]


def test_raw_config_is_scrubbed_structurally(env):
    r = env.get(f"{BASE}/hermes-config/raw").json()
    y = r["yaml"]
    for leak in ("sk-LEAK", "ghp_", "rk_live", "/home/geheim", "/opt/data", "--token"):
        assert leak not in y, leak
    assert "claude-test" in y and "backend: local" in y and r["redacted"]
    assert "max_tokens: 4096" in y and "redact_secrets: true" in y  # harmlose Werte bleiben lesbar
    assert "command: npx" in y


def test_raw_config_cannot_be_written(env):
    assert env.put(f"{BASE}/hermes-config/raw", json={"yaml": "a: 1"}).status_code in (404, 405)


def test_cron_cancel_goes_through(env):
    r = env.post("/bff/h/server/_cron/default/schedules/abc123def456/cancel")
    assert r.status_code == 200 and r.json() == {"ok": True, "cancelled": True} and env.dash.state.cron_cancels == ["abc123def456"]
    assert "cron.cancel" in audited(env)


def test_oauth_logout_needs_provider_typed(env):
    u = f"{BASE}/providers/oauth/anthropic"
    assert env.request("DELETE", u, json={"confirm": ""}).status_code == 422
    assert env.request("DELETE", u, json={"confirm": "anthropic"}).json()["ok"]
    assert env.dash.state.oauth_logouts == ["anthropic"]
    assert "hermes_oauth.logout" in audited(env)
    assert env.request("DELETE", f"{BASE}/providers/oauth/Bad..", json={"confirm": "x"}).status_code == 422


def test_old_hermes_gives_a_clear_501(env):
    env.dash.state.hidden = {"/api/ops/checkpoints", "/api/gateway/drain", "/api/config/raw"}
    for r in (env.get(f"{OPS}/checkpoints"), env.get(f"{BASE}/hermes-config/raw"), env.post(f"{BASE}/gateway/drain", json={"action": "cancel"})):
        assert r.status_code == 501 and "Hermes" in r.json()["detail"]


def test_action_text_reads_real_hermes_lines_form():
    from app.routes.lifecycle import _action_text
    assert _action_text({"lines": ["a", "b"]}) == "a\nb" and _action_text({"log": "x"}) == "x" and _action_text({}) == ""
