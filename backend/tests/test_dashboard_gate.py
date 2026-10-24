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
