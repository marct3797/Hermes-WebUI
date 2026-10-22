import json

import httpx
import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app
from devtools.mock_hermes import API_KEY, create_mock

HDR = {"X-Requested-With": "hermes-webui"}


@pytest.fixture
def profiles_file(tmp_path):
    f = tmp_path / "profiles.json"
    f.write_text(json.dumps({"profiles": [
        {"name": "default", "base_url": "http://hermes.test", "api_key": API_KEY},
        {"name": "bad", "base_url": "http://hermes.test", "api_key": "wrong"},
        {"name": "../evil", "base_url": "http://hermes.test", "api_key": API_KEY},
    ]}))
    return f


@pytest.fixture
def client(profiles_file):
    mock = create_mock(wait_for_user=False, delay=0)
    settings = Settings(env="dev", profiles_file=profiles_file, runs_per_minute=1000)
    app = create_app(settings, transport=httpx.ASGITransport(app=mock))
    with TestClient(app) as c:
        c.headers.update(HDR)
        yield c
