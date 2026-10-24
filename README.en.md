# Hermes-WebUI

A web UI for [Hermes Agent](https://hermes-agent.nousresearch.com/docs) installations on one or many machines. A React/Vite frontend (`frontend/`) talks only to a small FastAPI backend (the "BFF", `backend/`); API keys stay on the server. Optional per-machine daemon `hostd/` (terminals, files, native coding CLIs).

The main documentation is in German ([README.md](README.md)). This page is the English entry point.

## What it needs

| Component | Purpose | Required |
|---|---|---|
| Hermes gateway API (`API_SERVER_KEY`) | chat, runs, sessions | yes, per agent |
| `hermes dashboard` | profile, SOUL, **all Hermes settings**, keys, skills, MCP, plugins, cron, logs | no (those pages show "not configured") |
| Kanban plugin (ships with Hermes) | kanban board | no |
| `hostd` (this repo) | terminal, files, git, CLI sign-in | no |

Which Hermes version was checked, and what is covered or open: [docs/compatibility.md](docs/compatibility.md); how much of Hermes' native API and feature set the UI maps (99 of 390 routes today, with the list of gaps): [docs/coverage.md](docs/coverage.md) (both German). Check it yourself against any Hermes source tree:

```
cd backend && python -m devtools.check_upstream /path/to/hermes-agent
```

## Quick start (Docker, behind a reverse proxy)

```bash
git clone <this repository> hermes-webui && cd hermes-webui
python3 deploy/setup.py     # terminal wizard: asks for gateway, sign-in, options; tests the connections; writes config
bash deploy/deploy.sh       # builds and starts the container, waits for /healthz
```

The wizard never prints secrets, keeps existing files (it backs up `webui.env` as `webui.env.bak`) and refuses a non-https public URL, as the server does in production. A reverse-proxy example is in `deploy/Caddyfile.snippet`.

Development: `cd backend && pip install -e '.[dev]' && pytest`; `cd frontend && npm ci && npm test && npm run build`. A from-scratch install check without Docker: `bash deploy/smoke-install.sh frontend/dist`.

## Security in short

- Production requires OIDC sign-in with an allow-list of subjects (`HERMES_WEBUI_OIDC_ALLOWED_SUB`) and https.
- Risky actions (terminal, SOUL, keys, settings writes) ask for a fresh sign-in ("step-up"). It is on by default; `HERMES_WEBUI_STEP_UP=off` only makes sense when the UI is reachable from a private network only. The System page shows whether your identity provider can prove how fresh a sign-in is.
- Secrets (keys, tokens, passwords) never leave the server and cannot be written through the settings page.
- Details, threat notes and limits: [SECURITY.md](SECURITY.md) (German).

## Configuration

`config/hosts.json` (hosts, runtimes, agents; minimal template `deploy/hosts.example.json`, multi-profile template `deploy/hosts.multiplex.example.json`), `webui.env` (see `deploy/webui.env.example`). Providers can be hidden per installation with `HERMES_WEBUI_HIDDEN_PROVIDERS`.

## License

AGPL-3.0-only, see [LICENSE](LICENSE). Third-party licenses (including two OFL-1.1 fonts): [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). This is a metadata summary, not legal advice.
