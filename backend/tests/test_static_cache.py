from fastapi.testclient import TestClient
from app.main import create_app


def test_fingerprinted_assets_are_immutable_and_html_is_revalidated(make_settings, tmp_path):
    static = tmp_path / "static"
    (static / "assets").mkdir(parents=True)
    (static / "index.html").write_text("<html>current</html>")
    (static / "assets" / "index-abcdefgh.js").write_text("export default 1")
    (static / "assets" / "plain.js").write_text("export default 2")
    with TestClient(create_app(make_settings(static_dir=static))) as client:
        asset = client.get("/assets/index-abcdefgh.js")
        assert asset.status_code == 200
        assert asset.headers["cache-control"] == "public, max-age=31536000, immutable"
        assert "immutable" not in client.get("/assets/plain.js").headers.get("cache-control", "")
        assert client.get("/memory").headers["cache-control"] == "no-cache"
        assert client.get("/bff/me").headers["cache-control"] == "no-store"
        assert client.get("/assets/missing-abcdefgh.js").status_code == 404
