# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# Stage 1: Chef — cargo-chef pre-installed; layer is cached across all builds.
# ---------------------------------------------------------------------------
FROM lukemathwalker/cargo-chef:latest-rust-1.87-slim AS chef

RUN apt-get update && apt-get install -y --no-install-recommends \
    pkg-config \
    libssl-dev \
    libstdc++-12-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /build

# ---------------------------------------------------------------------------
# Stage 2: Planner — compute the dependency recipe from Cargo manifests.
# ---------------------------------------------------------------------------
FROM chef AS planner

COPY orchestrator/Cargo.toml orchestrator/Cargo.lock ./orchestrator/
COPY orchestrator/build.rs ./orchestrator/build.rs
COPY proto/ ./proto/

RUN mkdir -p orchestrator/src && echo "fn main() {}" > orchestrator/src/main.rs
RUN cd orchestrator && cargo chef prepare --recipe-path recipe.json

# ---------------------------------------------------------------------------
# Stage 3: Cacher — compile dependencies only.
# Re-runs only when Cargo.toml / Cargo.lock change.
# ---------------------------------------------------------------------------
FROM chef AS cacher

COPY --from=planner /build/orchestrator/recipe.json ./orchestrator/recipe.json
COPY proto/ ./proto/

RUN cd orchestrator && cargo chef cook --release --recipe-path recipe.json

# ---------------------------------------------------------------------------
# Stage 4: Builder — compile the orchestrator crate against pre-built deps.
# ---------------------------------------------------------------------------
FROM chef AS builder

COPY --from=cacher /build/orchestrator/target ./orchestrator/target
COPY --from=cacher /usr/local/cargo/registry /usr/local/cargo/registry

COPY orchestrator/Cargo.toml orchestrator/Cargo.lock ./orchestrator/
COPY orchestrator/build.rs ./orchestrator/build.rs
COPY orchestrator/src/ ./orchestrator/src/
COPY proto/ ./proto/

RUN cd orchestrator && cargo build --release

# ---------------------------------------------------------------------------
# Stage 5: Runtime — minimal image, no Rust toolchain or build artifacts.
# ---------------------------------------------------------------------------
FROM debian:bookworm-slim AS runtime

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    tzdata \
    && rm -rf /var/lib/apt/lists/*

RUN groupadd -r orchestrator && useradd -r -g orchestrator orchestrator

WORKDIR /app

COPY --from=builder /build/orchestrator/target/release/orchestrator /usr/local/bin/orchestrator

ENV ORCH__HTTP__HOST=0.0.0.0 \
    ORCH__HTTP__PORT=8080 \
    ORCH__HTTP__GRPC_HEALTH_PORT=8081 \
    ORCH__TELEMETRY__LOG_FORMAT=json \
    ORCH__TELEMETRY__LOG_LEVEL=info

EXPOSE 8080 8081

USER orchestrator

HEALTHCHECK --interval=15s --timeout=5s --start-period=15s --retries=3 \
    CMD curl -f http://localhost:8080/health || exit 1

ENTRYPOINT ["/usr/local/bin/orchestrator"]
