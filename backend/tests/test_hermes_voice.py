"""Sprache (Punkt 10): Sprachsynthese und Transkription über die im Profil gewählten Anbieter.

Schranken des BFF:
- `voice-config` (liefert Schlüssel an den Client) wird bewusst NICHT durchgereicht,
- Text höchstens 1000 Zeichen, Aufnahmen höchstens 1,4 MB (das globale Body-Limit des BFF ist 2 MiB) und nur `audio/*`,
- Antworten des Dashboards werden geprüft (nur `data:audio/`, begrenzte Größe), Rate-Limit je Nutzer (die Anbieter können Geld kosten).
"""
import base64

import pytest

from tests.denv import BASE, client

V = f"{BASE}/hermes-voice"
AUDIO = "data:audio/webm;base64," + base64.b64encode(b"x" * 100).decode()


@pytest.fixture
def env(tmp_path, make_settings):
    yield from client(tmp_path, make_settings)


def test_status_reports_the_mode_without_extra_fields(env):
    r = env.get(f"{V}/status")
    assert r.status_code == 200 and r.json()["mode"] == "chained" and "sk-LEAK" not in r.text and set(r.json()) == {"mode", "available", "reason"}


def test_voice_config_with_keys_is_not_exposed(env):
    assert env.get(f"{V}/config").status_code in (404, 405)


@pytest.mark.parametrize("text", ["", "   ", "x" * 1001])
def test_speak_rejects_empty_or_long_text(env, text):
    assert env.post(f"{V}/speak", json={"text": text}).status_code == 422


def test_speak_returns_playable_audio_only(env):
    r = env.post(f"{V}/speak", json={"text": "Hallo"})
    assert r.status_code == 200 and r.json()["data_url"].startswith("data:audio/") and r.json()["mime_type"].startswith("audio/")
    env.dash.state.profiles["default"]["voice_bad"] = "html"
    assert env.post(f"{V}/speak", json={"text": "Hallo"}).status_code == 502  # kein Audio
    env.dash.state.profiles["default"]["voice_bad"] = "huge"
    assert env.post(f"{V}/speak", json={"text": "Hallo"}).status_code == 502  # zu groß


@pytest.mark.parametrize("payload", [
    {"data_url": "kein data url"}, {"data_url": "data:text/html;base64,AAAA"}, {"data_url": "data:audio/webm,roh"},
    {"data_url": "data:audio/webm;base64,%%%"}, {"data_url": AUDIO, "mime_type": "text/plain"}, {"data_url": "data:audio/webm;base64,"},
])
def test_transcribe_rejects_non_audio_and_broken_payloads(env, payload):
    assert env.post(f"{V}/transcribe", json=payload).status_code == 422


def test_transcribe_rejects_oversized_recordings(env):
    big = "data:audio/webm;base64," + base64.b64encode(b"x" * 1_400_001).decode()
    assert env.post(f"{V}/transcribe", json={"data_url": big}).status_code == 422
    ok = "data:audio/webm;base64," + base64.b64encode(b"x" * 1_400_000).decode()
    assert env.post(f"{V}/transcribe", json={"data_url": ok}).status_code == 200


def test_transcribe_returns_the_text(env):
    r = env.post(f"{V}/transcribe", json={"data_url": AUDIO, "mime_type": "audio/webm"})
    assert r.status_code == 200 and r.json()["transcript"] == "Hallo Welt" and r.json()["provider"] == "whisper"


def test_transcribe_with_a_wrongly_shaped_reply_is_a_502(env):
    env.dash.state.profiles["default"]["voice_bad"] = "shape"
    assert env.post(f"{V}/transcribe", json={"data_url": AUDIO}).status_code == 502
