# Frontend bauen, dann BFF mit dem gebauten Frontend ausliefern.
FROM node:22-slim AS web
WORKDIR /web
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

FROM python:3.13-slim
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 PIP_NO_CACHE_DIR=1
WORKDIR /build
COPY backend/pyproject.toml ./
COPY backend/app ./app
RUN pip install . && rm -rf /build
COPY --from=web /web/dist /srv/static
WORKDIR /srv
ENV HERMES_WEBUI_STATIC_DIR=/srv/static
# Mit network_mode: host (Hikari) gilt dieser Port direkt auf dem Host; nur Loopback, davor liegt Caddy.
ENV WEBUI_HOST=127.0.0.1 WEBUI_PORT=8420
CMD ["sh", "-c", "exec uvicorn app.main:app_factory --factory --host \"$WEBUI_HOST\" --port \"$WEBUI_PORT\""]
