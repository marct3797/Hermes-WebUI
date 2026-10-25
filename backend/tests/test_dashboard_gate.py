"""Ein Dashboard, das Hermes 0.22 nicht für die WebUI freigibt, ergibt eine Meldung mit Ausweg statt „unerwartetes Format“."""
import httpx
import pytest

from app.adapters import UpstreamError
from app.dashboard import DashboardClient
from app.registry import DashboardCfg


def client(handler):
    return DashboardClient(DashboardCfg("http://dash.test", "t"), httpx.AsyncClient(transport=httpx.MockTransport(handler)))


async def message(handler):
    with pytest.raises(UpstreamError) as e:
        await client(handler).profiles()
    return e.value.status, e.value.detail


async def test_wrong_host_name_explains_loopback_and_tunnel():
    status, text = await message(lambda r: httpx.Response(400, json={"detail": "Invalid Host header. Dashboard requests must use the bound hostname or the configured public hostname."}))
    assert status == 502 and "127.0.0.1" in text and "Tunnel" in text and "Host" in text


async def test_redirect_to_login_means_the_dashboard_wants_its_own_sign_in():
    status, text = await message(lambda r: httpx.Response(302, headers={"location": "/login?next=/api/profiles"}))
    assert status == 502 and "Anmeldung" in text and "Tunnel" in text and "Format" not in text


async def test_401_names_both_causes_wrong_token_and_gate():
    status, text = await message(lambda r: httpx.Response(401, json={"detail": "Unauthorized"}))
    assert "Token" in text and "127.0.0.1" in text and "Tunnel" in text


async def test_plain_errors_stay_short():
    status, text = await message(lambda r: httpx.Response(500, json={"detail": "x"}))
    assert text == "Das Dashboard meldet Fehler 500"


async def test_download_returns_bytes_and_caps_size():
    c = client(lambda r: httpx.Response(200, content=b"\x50\x4b\x03\x04daten"))
    assert await c.download("/api/x", missing="fehlt") == b"\x50\x4b\x03\x04daten"
    big = client(lambda r: httpx.Response(200, content=b"y" * 11))
    with pytest.raises(UpstreamError) as e:
        await big.download("/api/x", missing="fehlt", limit=10)
    assert e.value.status == 502 and "groß" in e.value.detail


async def test_download_maps_dashboard_errors_like_json_calls():
    nf = client(lambda r: httpx.Response(404, json={"detail": "attachment not found"}))
    with pytest.raises(UpstreamError) as e:
        await nf.download("/api/x", missing="Diesen Anhang gibt es nicht")
    assert e.value.status == 404 and "Anhang" in e.value.detail
    login = client(lambda r: httpx.Response(302, headers={"location": "/login"}))
    with pytest.raises(UpstreamError) as e:
        await login.download("/api/x")
    assert e.value.status == 502 and "Anmeldung" in e.value.detail


async def test_upload_posts_multipart_and_reads_json_answer():
    seen = {}

    def handler(r: httpx.Request):
        seen["ct"] = r.headers.get("content-type", "")
        seen["body"] = r.content
        return httpx.Response(200, json={"ok": True, "id": 7})

    out = await client(handler).upload("/api/x", filename="notiz.txt", data=b"hallo", form={"a": "b"}, missing="fehlt")
    assert out == {"ok": True, "id": 7}
    assert seen["ct"].startswith("multipart/form-data") and b"notiz.txt" in seen["body"] and b"hallo" in seen["body"]

    err = client(lambda r: httpx.Response(400, json={"detail": "kaputt"}))
    with pytest.raises(UpstreamError) as e:
        await err.upload("/api/x", filename="n", data=b"d")
    assert e.value.status == 502 and "400" in e.value.detail
