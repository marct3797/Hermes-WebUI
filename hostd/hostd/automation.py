"""Nur lesend: Ziele (`/goal`), Heartbeats und Schleifen (`/loop`) der Hermes-Sitzungen eines Profils.

Hermes legt sie in `state.db` ab (Tabelle `state_meta`, Schlüssel `goal:<sitzung>`, `heartbeat:<sitzung>`, `loop:<sitzung>`, Wert = JSON) und bietet
dafür keine HTTP-Schnittstelle. Setzen, Pausieren und Löschen geht nur über die Hermes-Befehle in Terminal, Desktop oder Messaging; hostd öffnet die
Datenbank deshalb nie schreibend und instanziiert nie `SessionDB` (das würde migrieren).
"""
import json
import sqlite3
import time
from pathlib import Path

from .native import redact

KINDS = ('goal', 'heartbeat', 'loop')
LIMIT = 200
TEXT = 600
# Je Art nur diese Felder; alles andere (Gateway-Routing, Verdikt-Rohdaten) bleibt in Hermes.
FIELDS = {
    'goal': ('status', 'turns_used', 'max_turns', 'created_at', 'last_turn_at', 'last_verdict', 'last_reason', 'paused_reason', 'waiting_reason', 'waiting_until'),
    'heartbeat': ('status', 'interval_seconds', 'created_at', 'last_fired_at', 'fire_count'),
    'loop': ('status', 'mode', 'interval_seconds', 'current_delay', 'times', 'until', 'ticks_fired', 'created_at', 'last_fired_at', 'next_due_at',
             'paused_reason', 'last_stop_reason'),
}
TEXT_FIELDS = ('last_reason', 'paused_reason', 'waiting_reason', 'until', 'last_stop_reason')


def _entry(kind, session_id, title, raw):
    try:
        data = json.loads(raw)
    except (TypeError, ValueError):
        return None
    if not isinstance(data, dict) or data.get('status') == 'cleared':
        return None
    text = data.get('goal') if kind == 'goal' else data.get('prompt')
    out = {'kind': kind, 'session_id': session_id, 'title': redact(title or '')[:200], 'text': redact(str(text or ''))[:TEXT]}
    for name in FIELDS[kind]:
        value = data.get(name)
        if isinstance(value, str):
            value = redact(value)[:TEXT] if name in TEXT_FIELDS else value[:60]
        elif isinstance(value, bool) or not isinstance(value, (int, float)):
            value = None if value is None or isinstance(value, (list, dict)) else value
        out[name] = value
    if kind == 'goal':
        subgoals = data.get('subgoals')
        out['subgoals'] = [redact(str(s))[:200] for s in subgoals[:20]] if isinstance(subgoals, list) else []
        gates = data.get('gates')
        out['gates'] = len(gates) if isinstance(gates, list) else 0
    return out


def read(profile_root):
    """{'items': [...], 'truncated': bool, 'available': bool}; `available` false = keine lesbare state.db."""
    root = Path(profile_root)
    db = root / 'state.db'
    if root.is_symlink() or db.is_symlink() or not db.is_file():
        return {'items': [], 'truncated': False, 'available': False, 'reason': 'Session database unavailable'}
    conn = None
    try:
        conn = sqlite3.connect(db.absolute().as_uri() + '?mode=ro', uri=True, timeout=1)
        conn.execute('PRAGMA query_only=ON')
        deadline = time.monotonic() + 2
        conn.set_progress_handler(lambda: int(time.monotonic() > deadline), 1000)
        rows = conn.execute(
            "SELECT m.key, m.value, s.title FROM state_meta m LEFT JOIN sessions s ON s.id = substr(m.key, instr(m.key, ':') + 1) "
            "WHERE m.key LIKE 'goal:%' OR m.key LIKE 'heartbeat:%' OR m.key LIKE 'loop:%' LIMIT ?", (LIMIT * 3 + 1,)).fetchall()
    except sqlite3.Error:
        return {'items': [], 'truncated': False, 'available': False, 'reason': 'Session database incompatible or timed out'}
    finally:
        if conn:
            conn.close()
    items = []
    for key, raw, title in rows:
        kind, _, session_id = key.partition(':')
        if kind in KINDS and session_id:
            entry = _entry(kind, session_id, title, raw)
            if entry:
                items.append(entry)
    items.sort(key=lambda e: (e['status'] != 'active', -(e.get('last_turn_at') or e.get('last_fired_at') or e.get('created_at') or 0)))
    return {'items': items[:LIMIT], 'truncated': len(items) > LIMIT or len(rows) > LIMIT * 3, 'available': True}
