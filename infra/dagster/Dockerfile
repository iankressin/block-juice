# Dagster with the TypeScript sources and the dbt project, laid out as in the repo so that
# orchestration/pipeline/project.py finds ingestion/ and transformation/. Build it from the repo root.
FROM node:24-bookworm-slim

# The slim image has no CA certificates, and dbt-core's parser package downloads its wheel over
# HTTPS when it installs.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY --from=ghcr.io/astral-sh/uv:0.7.19 /uv /uvx /bin/

ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    UV_PYTHON=3.11 \
    UV_LINK_MODE=copy \
    PATH=/app/orchestration/.venv/bin:$PATH

# Dependencies first, from the lockfiles alone, so a code change reuses these layers.
WORKDIR /app/ingestion
COPY ingestion/package.json ingestion/pnpm-lock.yaml ingestion/pnpm-workspace.yaml ./
RUN corepack enable && pnpm fetch

WORKDIR /app/orchestration
COPY orchestration/pyproject.toml orchestration/uv.lock ./
RUN --mount=type=cache,target=/root/.cache/uv uv sync --frozen --no-install-project

WORKDIR /app/ingestion
COPY ingestion/ ./
RUN pnpm install --frozen-lockfile --offline \
    && for dir in sources/*/; do [ -f "$dir.env" ] || cp "$dir.env.example" "$dir.env"; done

WORKDIR /app/orchestration
COPY transformation/ /app/transformation/
COPY orchestration/ ./
RUN --mount=type=cache,target=/root/.cache/uv uv sync --frozen

EXPOSE 3000
CMD ["dagster", "dev", "-h", "0.0.0.0", "-p", "3000"]
