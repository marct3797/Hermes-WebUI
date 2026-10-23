"""Attach CredentialQueryFilter to uvicorn.access before serving requests."""
import logging
import re
from urllib.parse import unquote_plus

CREDENTIAL_KEYS = {
    "code", "state", "session_state", "token", "access_token", "refresh_token",
    "id_token", "api_key", "apikey", "key", "secret", "client_secret", "password",
    "code_verifier", "authorization", "credential", "signature", "ticket",
}
QUERY_VALUE = re.compile(r"([?&])([^=&\s\"]+)=([^&\s\"]*)")


def _redact(value: str) -> str:
    def replace(match: re.Match) -> str:
        if unquote_plus(match[2]).lower() in CREDENTIAL_KEYS:
            return f"{match[1]}{match[2]}=[REDACTED]"
        return match[0]
    return QUERY_VALUE.sub(replace, value)


class CredentialQueryFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        if isinstance(record.args, tuple) and len(record.args) == 5 and record.msg == '%s - "%s %s HTTP/%s" %d':
            # Uvicorn's AccessFormatter also reads the original five arguments.
            record.args = tuple(_redact(arg) if isinstance(arg, str) else arg for arg in record.args)
        else:
            record.msg = _redact(record.getMessage())
            record.args = ()
        return True
