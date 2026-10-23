# Hermes host daemon

Linux/macOS per-user FastAPI daemon running **real native CLI processes** in PTYs.
No provider SDK, inferred login status, shell command endpoint, or copied account
credentials. Run as the same unprivileged OS user that owns the existing CLI
installation/login. Root runtime is rejected. The daemon is a trusted remote
control endpoint, **not a process or filesystem sandbox**: an allowed agent CLI
retains that user's normal filesystem/network permissions.

## Install (Linux user systemd)

From the repository, as your normal user:

```sh
bash deploy/install-hostd.sh --no-start
```

Defaults:

- Python: absolute `command -v python3` result
- Virtualenv/executable: `~/.local/share/hermes-hostd/venv/bin/hermes-hostd`
- Config: `~/.config/hermes-hostd/config.json`
- Environment: `~/.config/hermes-hostd/daemon.env` (0600, new random daemon-only bearer)
- Unit: `~/.config/systemd/user/hermes-hostd.service`

`XDG_DATA_HOME` / `XDG_CONFIG_HOME` are respected. Overrides: `--python ABS`,
`--venv ABS`, `--config ABS`, `--env-file ABS`, `--unit-dir ABS`.
The unit embeds explicit absolute executable, config and environment-file paths;
its PATH captures the installing user's CLI search path. Existing config/env
files are not replaced. Never place provider credentials in the daemon env file.
Review it locally without sharing its contents; configure the BFF with the same
**daemon-only** token via its server-side environment, never browser JavaScript.

The generated config has empty allowlists, so no CLI can start until reviewed:

```json
{
  "listen_host": "127.0.0.1",
  "port": 8790,
  "token_env": "HERMES_HOSTD_TOKEN",
  "allowed_origins": ["https://console.example.org"],
  "clis": [{"id": "hermes", "label": "Hermes", "command": ["/absolute/path/to/hermes"]}],
  "workspaces": [{"id": "project", "label": "Project", "path": "/absolute/path/to/project"}],
  "profiles": {},
  "allow_shell": false,
  "max_terminals": 8
}
```

Use actual installed executable paths and existing workspace directories; no
client-provided argv or paths are accepted. Configured symlinks are canonicalized
once; subsequent workspace retargeting is rejected. Binding accepts loopback,
RFC1918, CGNAT/Tailscale and IPv6 ULA literal addresses only, never wildcard,
public IP or hostnames. A private bind does not provide encryption: keep loopback
or use an authenticated encrypted private transport/firewall. Origins must be
exact HTTP(S) origins; supplied non-allowlisted origins are rejected. Bearer auth
is required even when Origin is absent (BFF/service clients).

After reviewing configuration:

```sh
systemctl --user daemon-reload
systemctl --user enable --now hermes-hostd.service
systemctl --user status hermes-hostd.service
```

On a host with `~/.hermes` the installer also runs `python -m hostd.discover --config CONFIG`,
which adds `default` and every folder in `~/.hermes/profiles/` under `profiles`
(`{"name": {"path": "..."}}`). Existing entries are never changed; one summary line is printed.

No root service, credential migration, or automatic lingering setup is performed.
A user unit normally stops at logout unless the administrator already enabled
lingering. A custom `--unit-dir` must be on the user's systemd unit search path.
The unit kills its entire control group on stop; all live PTYs terminate at daemon
shutdown. CLI processes survive WebSocket disconnect/navigation, **not daemon
restart**. Installer execution/service activation remains a deployment step.

For non-systemd development: install `hostd/` in a venv, set the configured token
environment variable (ASCII, no whitespace, at least 32 characters), then run
`/absolute/venv/bin/hermes-hostd --config /absolute/config.json`.

## API and limits

All HTTP and WebSocket requests require `Authorization: Bearer …`.

- `GET /v1/info`: executable availability. `authenticated` comes from the `/v1/auth`
  cache (`null` until checked or when unclear); it never runs a probe itself.
- `GET /v1/auth[?refresh=1]`: `{clis:[{id,state:signed_in|signed_out|unknown,method,checked_at,reason}]}`.
  Fixed status commands per CLI id (`codex login status`, `claude auth status`,
  `opencode auth list`, `agy models`), never taken from the config, 15 s timeout, no
  model run, output never logged or returned. Cached 60 s; `refresh=1` is limited to
  one real check per CLI per 10 s. Unknown ids report `unknown`.
- `GET /v1/terminals`: `{terminals:[Terminal]}`.
- `POST /v1/terminals`: `{cli,workspace,cols:80,rows:24}`. Rejects extra fields.
- `DELETE /v1/terminals/{id}`: terminates the process group, removes the record.
- `WS /v1/terminals/{id}/stream?after=0`: initial and changed
  `{type:"state",terminal:Terminal}`, then
  `{type:"output",data:BASE64,offset:BYTE_START}`. Reconnect with the next byte
  offset (`offset + decoded byte count`). A replay gap is explicitly
  `{type:"gap",requested:OLD_OFFSET,available_from:FIRST_RETAINED_BYTE}` before
  retained output. Future/negative offsets are rejected. Output is raw bytes;
  use a streaming UTF-8 decoder or xterm's byte input.
- Client frames: `{type:"input",data:BASE64}` or
  `{type:"resize",cols:80,rows:24}`. No binary WebSocket frames.

Replay: 256 KiB per terminal, output chunks at most 8 KiB; no unbounded subscriber
queues. Input: 16 KiB decoded, 24 KiB JSON frame; terminal-create body: 4 KiB;
other write bodies: 1.5 MB (for the independent bounded-upload router).
Dimensions: 1–500 columns, 1–300 rows. Default terminal count: eight, including
exited records until explicit DELETE (configurable 1–64). Slow writes/sends time
out. Access logs are disabled; terminal text and bearer values are not logged.
The daemon token is removed from CLI child environments; normal native account
environment remains available. Fixed argv in config is trusted operator input.

The independent operations router is intentionally **not registered here**;
parent integration can `app.include_router(operations.router)` (and any native
router) inside this same auth/origin boundary. `app.state.settings` exposes the
Settings dataclass with dict entries in `clis`, `workspaces`, `profiles`.

## Verification

```sh
PYTHONPATH=hostd python -m pytest hostd/tests/test_terminals.py -q
```

Tests use only `/bin/cat` and Python: real PTY I/O, replay eviction/gaps,
disconnect survival, resizing, explicit/shutdown cleanup, token/origin/bind
validation, request/input/frame limits and no-spawn info. No provider model or
real account credential is used. Installer shell syntax is checked, but actual
user service installation/activation must be verified on the target account.
