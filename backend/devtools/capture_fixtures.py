"""Nimmt echte BFF-Antworten (nur GET) auf und bereinigt sie. Nicht Teil der Tests gegen echte Hosts.

  WEBUI_COOKIE='hermes_session=...' python -m devtools.capture_fixtures https://webui.example out_dir
"""
from __future__ import annotations

import json
import os
import re
import sys
from pathlib import Path

import httpx

# Name der Fixture -> lesender Pfad unter der BFF-URL
PATHS = {
    "real_jobs_list": "/bff/h/laptop/hermes/default/jobs",
    "real_provider_matrix_server": "/bff/h/server/hermes/_provider-matrix",
    "real_providers_laptop_default": "/bff/h/laptop/hermes/default/providers",
    "real_terminals_after_exit": "/bff/h/laptop/_terminals",
    "real_hostd_info": "/bff/h/laptop/_hostd",
}
RULES = [
    (re.compile(r"«redacted:[^»]*»"), "«redacted»"),
    (re.compile(r"[\w.+-]+@[\w-]+(?:\.[\w-]+)+"), "user@example.invalid"),
    (re.compile(r"\b(?:sk|oc|ghp|gho|xox[abp]|AKIA)[-_][A-Za-z0-9_-]{8,}"), "[REDACTED]"),
    (re.compile(r"(?i)(bearer\s+)[A-Za-z0-9._~+/=-]{12,}"), r"\1[REDACTED]"),
    (re.compile(r"(discord:)\d{6,}"), r"\g<1>000000000000000000"),
]
SECRET_KEY = re.compile(r"(?i)(token|secret|password|api_?key|authorization)$")


def scrub(value):
    if isinstance(value, dict):
        return {k: ("[REDACTED]" if SECRET_KEY.search(k) and isinstance(v, str) and v else scrub(v)) for k, v in value.items()}
    if isinstance(value, list):
        return [scrub(v) for v in value]
    if isinstance(value, str):
        for rule, replacement in RULES:
            value = rule.sub(replacement, value)
    return value


def capture(client: httpx.Client, out: Path, paths: dict[str, str] = PATHS) -> list[str]:
    out.mkdir(parents=True, exist_ok=True)
    written = []
    for name, path in paths.items():
        response = client.get(path)  # ausschließlich GET
        response.raise_for_status()
        (out / f"{name}.json").write_text(json.dumps(scrub(response.json()), indent=1, ensure_ascii=False) + "\n")
        written.append(name)
    return written


def main(argv: list[str]) -> int:
    cookie = os.environ.get("WEBUI_COOKIE")
    if len(argv) != 3 or not cookie:
        print("Aufruf: WEBUI_COOKIE=... capture_fixtures.py <bff-url> <zielordner>", file=sys.stderr)
        return 2
    with httpx.Client(base_url=argv[1], headers={"Cookie": cookie}, timeout=20) as client:
        print("\n".join(capture(client, Path(argv[2]))))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
