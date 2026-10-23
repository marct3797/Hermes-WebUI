import re

from fastapi.staticfiles import StaticFiles


class FingerprintedFiles(StaticFiles):
    """Only content-hashed build assets may outlive an application release."""

    async def get_response(self, path, scope):
        response = await super().get_response(path, scope)
        if response.status_code in (200, 304) and re.search(r"-[A-Za-z0-9_-]{8,}\.[a-zA-Z0-9.]+$", path):
            response.headers["Cache-Control"] = "public, max-age=31536000, immutable"
        return response
