"""Read-only Hermes message FTS; never instantiate SessionDB (it migrates)."""
import sqlite3
import time
from pathlib import Path

from .native import redact, value


def search(profiles, query):
    results, warnings = [], []
    truncated = False
    # Quote user input as one FTS phrase, not an executable MATCH expression.
    phrase = '"' + query.replace('"', '""') + '"'
    for profile in profiles:
        identifier = value(profile, 'id')
        root = Path(value(profile, 'path'))
        db = root / 'state.db'
        if root.is_symlink() or db.is_symlink() or not db.is_file():
            warnings.append({'profile': identifier, 'reason': 'Session database unavailable'})
            continue
        conn = None
        try:
            conn = sqlite3.connect(db.absolute().as_uri() + '?mode=ro', uri=True, timeout=1)
            conn.execute('PRAGMA query_only=ON')
            deadline = time.monotonic() + 2
            conn.set_progress_handler(lambda: int(time.monotonic() > deadline), 1000)
            rows = conn.execute("""
                SELECT s.id, substr(COALESCE(s.title,''),1,200),
                       snippet(messages_fts, 0, '', '', '…', 32)
                FROM messages_fts JOIN messages m ON m.id=messages_fts.rowid
                JOIN sessions s ON s.id=m.session_id
                WHERE messages_fts MATCH ? AND m.role IN ('user','assistant')
                LIMIT 101
            """, (phrase,)).fetchall()
            seen = set()
            for session_id, title, snippet in rows:
                if session_id in seen:
                    continue
                seen.add(session_id)
                if len(results) >= 100:
                    truncated = True
                    break
                results.append({'profile': identifier, 'session_id': session_id,
                                'title': redact(title), 'snippet': redact((snippet or '')[:1000])})
            truncated |= len(rows) > 100
        except sqlite3.Error:
            warnings.append({'profile': identifier, 'reason': 'Native message FTS unavailable, incompatible, or timed out'})
        finally:
            if conn:
                conn.close()
    if not profiles:
        warnings.append({'reason': 'No profile roots configured'})
    return {'results': results, 'truncated': truncated, 'warnings': warnings}
