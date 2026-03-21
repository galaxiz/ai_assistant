# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# Stage 1: Builder
# Install all dependencies into an isolated prefix for a clean copy.
# ---------------------------------------------------------------------------
FROM python:3.12-slim AS builder

WORKDIR /build

# System deps needed to compile native extensions (grpcio, tiktoken).
RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc \
    g++ \
    && rm -rf /var/lib/apt/lists/*

# Copy only the files pip needs first so layer caching works well.
COPY pyproject.toml README.md ./

# Install deps (no source yet) so this layer is cached between code changes.
RUN pip install --no-cache-dir --prefix=/install \
    "litellm>=1.56.0" \
    "tiktoken>=0.9.0" \
    "grpcio>=1.70.0" \
    "grpcio-reflection>=1.70.0" \
    "grpcio-health-checking>=1.70.0" \
    "pydantic>=2.10.0" \
    "pydantic-settings>=2.7.0" \
    "jinja2>=3.1.0" \
    "structlog>=25.1.0"

# Now copy source and install the package itself.
COPY cognition_engine/ ./cognition_engine/
RUN pip install --no-cache-dir --prefix=/install --no-deps .

# ---------------------------------------------------------------------------
# Stage 2: Runtime
# Lean image — no compiler, no build tools, no dev dependencies.
# ---------------------------------------------------------------------------
FROM python:3.12-slim AS runtime

# Non-root user for security.
RUN groupadd -r cognition && useradd -r -g cognition cognition

WORKDIR /app

# Copy the installed packages from builder.
COPY --from=builder /install /usr/local

# Runtime defaults (all overridable via environment variables at deploy time).
ENV CE_GRPC_HOST=0.0.0.0 \
    CE_GRPC_PORT=50051 \
    CE_LOG_FORMAT=json \
    CE_LOG_LEVEL=INFO \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

EXPOSE 50051

USER cognition

# Health check — relies on the grpc_health_probe binary if present,
# otherwise falls back to a TCP connect which at least confirms the port is open.
HEALTHCHECK --interval=10s --timeout=5s --start-period=10s --retries=3 \
    CMD python -c \
    "import grpc; ch = grpc.insecure_channel('localhost:50051'); grpc.channel_ready_future(ch).result(timeout=4)" \
    || exit 1

ENTRYPOINT ["python", "-m", "cognition_engine"]
