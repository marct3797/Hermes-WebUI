# Host operations router

`hostd.operations.router` is an independent FastAPI router with prefix `/v1`.
It is **not an authentication service**. Mount it only in the authenticated host
daemon, after its bearer, Origin, request-body-size and no-store protections.
Browser callers must go through the authenticated BFF; never expose the daemon's
bearer token to browsers. BFF writes require fresh user authentication and
metadata-only audit events. Router helpers do not log request bodies, commands'
output, terminal contents, credentials, or native error text.

## Integration

```python
from hostd.operations import router as operations_router
app.include_router(operations_router)  # no second prefix
```

The router reads `request.app.state.settings`. Both dicts and dataclass/attribute
objects work. Workspace entries are `{id,label,path}`; profile entries can be
`[{id,path,...}]` or `{id: "/absolute/profile"}` / `{id: {path: ...}}`.
All root paths are server configuration, never request parameters. The core
configuration owner must validate absolute existing roots and add optional native
settings before accepting the example below. PyYAML is required for MCP name-only
configuration parsing; no Hermes package is imported into the daemon process.

Example **operator-managed** configuration fragment (not a usable deployment):

```json
{
  "workspaces": [{"id": "project", "label": "Project", "path": "/srv/projects/project"}],
  "profiles": {
    "worker": {
      "path": "/srv/hermes/worker",
      "kanban_db": "/srv/hermes/shared/kanban/boards/existing/kanban.db",
      "allow_management": false,
      "allowed_plugins": []
    }
  },
  "hermes_command": ["/opt/hermes/bin/hermes"],
  "native_python": "/opt/hermes/bin/python",
  "native_source": "/opt/hermes/source",
  "reviewed_catalog": []
}
```

`native_python` must be the native Hermes interpreter (or an interpreter whose
Hermes bootstrap can resolve native dependencies). `native_source` is the trusted
local Hermes source, not a downloaded/client-controlled module tree. Both are
operator-only executable-code trust decisions. The Kanban database is explicitly
configured because boards can be shared across profiles and are not necessarily
inside a profile. Missing/incompatible native capabilities return
`{available:false,reason,items:[],actions:[]}`; they are not successful empty data.

## HTTP contract

| Method/path | Input | Output |
| --- | --- | --- |
| GET `/v1/workspaces` | none | `{workspaces:[{id,label}]}` |
| GET `/v1/files` | `workspace`, optional relative `path` | `{workspace,path,entries,content?,mime?,truncated?}` |
| GET `/v1/files/download` | `workspace`, relative `path` | octet-stream attachment, no inline execution |
| POST `/v1/files/upload` | `{workspace,path,content_base64}` | `{ok,path,size}` |
| GET `/v1/git` | `workspace` | `{branch,status,diff,remotes:[{name,url}],truncated}` |
| GET `/v1/search` | `q` (1–200 chars) | `{results:[{profile,session_id,title,snippet}],warnings,truncated}` |
| GET `/v1/manage` | none | `{profiles:[{id}],clis:[{id,label}],sources:[...]}` |
| GET `/v1/manage/{profile}/{kind}` | `skills`, `mcp`, `plugins`, `logs`, `kanban` | `{available,items,actions,...}` |
| POST `/v1/manage/{profile}/plugins/{action}` | `{id}` only | `{ok,id,action,item}` after native readback |

Unknown workspace/profile/kind is 404. Denied paths/management/catalog identifiers
are 403. Existing upload targets are 409. Invalid base64 is 400; oversized decoded
uploads/downloads are 413 (an oversized JSON model may be rejected with 422 before
decoding). Binary preview is 415. Unsupported writes are 501 after profile-write
authorization. Native failures/refusals are 409 or 503; timeout is 504 and explicitly
means the action's outcome is unknown, not that it was rolled back.

## Files and Git boundaries

- Descriptor-relative `openat` traversal with `O_NOFOLLOW` rejects **all** symlinks,
  including within-root links. Rejects absolute paths, `.`/`..`, NUL, backslash,
  empty path components, FIFO/devices and directories used as downloads.
- Hidden paths except `.gitignore`, credential/token/secret names, `config.*`,
  common auth/SSH/cloud files, private-key/container formats, `.env` variants,
  and SQLite files are denied for browsing, preview, upload and download.
- Preview reads at most 64 KiB plus one byte, UTF-8 text only. PDF remains available
  for upload/download, never inline preview. Directory listing: at most 1,000
  visible entries. Downloads: at most 16 MiB, read from the same verified open fd;
  response name is percent-encoded and MIME is always octet-stream.
- Upload decoded size: at most 1 MiB. Existing parents required, no implicit mkdir.
  `O_CREAT|O_EXCL` and mode 0600 prevent overwrite, including racing creators and
  symlink replacement. A storage failure can leave the newly created partial
  file; an existing file is never overwritten or deleted by this path.
- Git is read-only: fixed argv, no shell, no user URL/command. Requires standalone
  `.git` directory (linked-worktree indirections intentionally unavailable).
  New repositories without HEAD return empty diff. Existing repositories compare
  HEAD to working tree (staged plus unstaged); untracked file content is omitted.
  Diff selects at most 100 individually validated existing tracked paths;
  sensitive/deleted/symlink paths are omitted. Status still reports tracked
  deletions. No external diff, textconv, fsmonitor or hooks. Literal pathspecs
  prevent a tracked filename such as `:(glob)*` from bypassing the file filter.
- Each git/native read subprocess: 64-KiB output cap, eight-second timeout,
  process-group cleanup; native writes: 30 seconds. No terminal output/error text
  is returned. HTTP responses redact secret-bearing diff/log lines, key blocks
  and URL userinfo/query/fragment (including SSH URLs).

### Write paths (0.3.0)

All stay inside the configured workspace (descriptor-relative, `O_NOFOLLOW`, same
denylist as above). There is no delete endpoint.

- `POST /v1/files/mkdir {workspace,path}`: one directory, parents must exist, mode 0700, 409 if present.
- `PUT /v1/files/write {workspace,path,content,expected_sha256?,create?}`: UTF-8 text, at most 1 MiB
  (bytes), no NUL/control bytes (415). Overwrite requires `expected_sha256` (422 without, 409 on mismatch,
  checked again right before the swap); written to a hidden temp file in the same directory, fsync, `rename`;
  mode kept. `create:true` creates only (link-based, 409 if present). Returns `{sha256,size}`.
- `POST /v1/files/move {workspace,from,to}`: rename/move inside the workspace; 409 if the target exists, never
  through symlinks. Files use link+unlink (atomic no-overwrite); directories check then rename (small race).
- `GET /v1/files[?full=true]`: entries carry `kind,size,mtime`; file reads carry `sha256`, `size`, `editable`
  (false above 1 MiB). `full=true` returns up to 1 MiB for the editor, otherwise the 64 KiB preview.
- `GET /v1/git` adds `files` (`{path,state}` from `status --porcelain`, untracked included), `log` (last 20:
  hash, subject, author, date) and `branches`; still read-only and redacted.
- `GET /v1/workspaces` returns `{id,label,is_git}` (no path). Write bodies: 7 MB limit on `/v1/files/write`.

### Adding a workspace

`python -m hostd.workspaces add --config CONFIG --id ID --path /abs/dir [--label TEXT]` (also `list`; no
`remove`). Validated like `Settings.from_dict`, `/` and the home directory itself are refused, existing IDs are
never overwritten (exit 3). Restart hostd afterwards. The installer takes `--workspace ID=/abs/dir[:Label]` (repeatable).

The operator must allowlist **project directories, not a home directory or a
credential directory**. A filename denylist cannot identify a secret pasted into
an innocuously named source file. Similarly, redaction is conservative pattern
matching, not a proof that arbitrary unstructured logs contain no secrets.
Configured roots and trusted native installations must not be writable by a
hostile local user. This is not an OS sandbox against another process running as
the same Unix user, hard-link attacks, or a concurrent local root rename.

## Native support and trust

Inspected the installed Hermes source and real CLI help, not guessed commands:

- Sessions: native `sessions(id,title)` / `messages(id,session_id,role,content)` and
  `messages_fts` FTS5 (legacy inline and current external-content schema).
  SQLite opens `mode=ro`, `PRAGMA query_only=ON`, two-second query budget; no
  SessionDB constructor, migrations, repairs or FTS rebuild. Search uses a quoted
  phrase, not arbitrary FTS operators, and excludes tool-role results. Global cap
  100 results; absent FTS/database produces per-profile warnings. No title-only
  fallback pretending to be full-text search.
- Skills: profile-local `skills/**/SKILL.md` identities only, no skill execution,
  content or private configuration output. Six-directory nesting, 1,000 skills,
  5,000 visited entries maximum. External/project/bundled roots are explicitly
  not covered. Native `hermes skills config` is interactive, so enable/disable
  and install are unavailable here; scan/trust prompts are not bypassed.
- MCP: parse bounded native `config.yaml` with safe YAML loader; emit **only**
  server identifier and enabled boolean. Never emit command, args, headers, env,
  credentials or server URLs. Native CLI has no suitable noninteractive toggle;
  installation requires native trust/setup. MCP install/enable/disable are
  unavailable, not silently emulated through config edits.
- Plugins: exact native read command `hermes plugins list --json`; output only
  identifier, enabled and status. No plugin import into the host daemon. Native
  listing may consult its own catalog/provenance cache according to installed
  Hermes behavior; no auth inference is made.
- Kanban: **do not use `hermes kanban list` for reads**: source calls
  `recompute_ready`, which writes task states. Fixed child Python script imports
  `hermes_bootstrap` and `hermes_cli.kanban_db.list_tasks`, supplies a read-only
  SQLite connection, and returns at most 200 real tasks with id/title/status/
  assignee/priority. No connect initializer, migration, dispatch, inference,
  duplicate board or task writes. Missing DB is never created.
- Logs: only the fixed native `logs/agent.log`, last 64 KiB, bounded and redacted.
  No client filename, arbitrary log path, follow mode or raw credential dump.

### Only supported writes: reviewed plugins

All require `profile.allow_management=true` **and** name in
`profile.allowed_plugins`. Names must be bare safe identifiers, not URLs, paths,
option-looking strings or repository shorthand. Install additionally requires a
server-configured `reviewed_catalog` entry `{id,kind:"plugins",reviewed:true,url}`.
The `url` is reviewed-source display metadata; it is **not** passed to subprocess.
The native curated catalog resolves the approved bare identifier. Operators must
check that the catalog identifier still resolves to the reviewed source.

Exact commands:

```text
hermes plugins install NAME --no-deps --no-enable
hermes plugins enable NAME --no-allow-tool-override
hermes plugins disable NAME
```

No `--force`, `--yes-deps`, automatic trust grants, tool overrides or implicit
removal/update. stdin is closed: native flows needing more consent must refuse;
complete those approvals through the native CLI, not this API. Install means
**downloaded disabled without dependency installation**, not ready-to-run. Enable
can still fail if native dependencies/admission/trust are not satisfied. Native
inventory is re-read and state checked after every write. Plugin mutations were
tested with a synthetic command adapter; real profile changes and real plugin
installation/activation were deliberately not exercised.

## Verification

```sh
PYTHONPATH=hostd /path/to/test/venv/bin/python -m pytest hostd/tests/test_operations.py -q
PYTHONPATH=hostd /path/to/test/venv/bin/python -m pytest hostd/tests -q
```

Tests use temporary workspaces/profiles, synthetic databases and a temporary Git
repository. Optional tests exercise real local native plugin listing against a
temporary profile, and the real native Kanban read API against synthetic tasks;
CI without that local installation skips those explicit integration checks.
No live inference, real credential reads into output, real profile config writes,
SSH or publication form part of verification.
