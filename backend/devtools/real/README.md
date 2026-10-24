# Gegen echten Hermes-Code prüfen

Der Mock (`devtools/mock_hermes.py`) antwortet immer gleich. Diese Skripte starten **echte** Hermes-Gateways mit einem Dummy-Modell und
lassen das BFF dagegen laufen. Damit wurden die Räume (Ursache des „Bots antworten nicht“) und die Anbieter-Routen geprüft.

```
python -m venv .real/hv && .real/hv/bin/pip install hermes-agent aiohttp fastapi uvicorn httpx   # PyPI hat Hermes bis 0.19.0
export WORK=$PWD/.real HERMES_BIN=$PWD/.real/hv/bin/hermes
python devtools/real/fakellm.py 9300 .real/llm.log &                   # Dummy-Modell (FAKE_MODE=tools lässt es ein Werkzeug aufrufen)
bash devtools/real/gw.sh eta 8651; bash devtools/real/gw.sh beta 8652
python devtools/real/drive.py "Hallo zusammen, bitte prüft die Config."   # Raum mit zwei echten Agents durch das echte BFF
```

- `prov.py` prüft die Anbieter-Matrix, die Modellliste und den Start der Anmeldung gegen ein echtes Dashboard
  (`HERMES_HOME=.real/hhome-eta hermes dashboard --port 9123 --no-open --skip-build`, Token per `HERMES_DASHBOARD_SESSION_TOKEN=dashtok-0123456789abcdef`).
- Stoppen: `fuser -k 8651/tcp 8652/tcp 9300/tcp` (nie `pkill -f`).
- Die Codex-Anmeldung braucht Netz zu OpenAI und lässt sich so nicht prüfen.
