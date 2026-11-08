"""Eine frische Installation (nur pyproject) muss starten: FastAPI verlangt `python-multipart` schon beim Anlegen einer Route mit Formular-Upload."""
import re
import tomllib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def test_form_uploads_come_with_python_multipart_declared():
    uses = [f.name for f in (ROOT / "app").rglob("*.py") if re.search(r"\b(UploadFile|Form)\(|: UploadFile", f.read_text())]
    deps = tomllib.loads((ROOT / "pyproject.toml").read_text())["project"]["dependencies"]
    assert not uses or any(d.lower().startswith("python-multipart") for d in deps), f"{uses} brauchen python-multipart in pyproject.toml"
