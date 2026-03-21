"""
Entry point for the Cognition Engine gRPC server.

Usage:
    python -m cognition_engine
    # or via installed script:
    cognition-engine
"""

from __future__ import annotations

import asyncio
import signal

import grpc
import structlog
from grpc import aio
from grpc_reflection.v1alpha import reflection

from cognition_engine.generated import cognition_pb2, cognition_pb2_grpc
from cognition_engine.llm_client import LLMClient
from cognition_engine.logging_setup import configure_logging
from cognition_engine.output_parser import OutputParser
from cognition_engine.service import CognitionServicer
from cognition_engine.settings import Settings
from cognition_engine.token_counter import TokenCounter

log = structlog.get_logger(__name__)


async def _run_server(settings: Settings) -> None:
    """Build the dependency graph, start the gRPC server, and run until signalled."""
    log.info(
        "Cognition Engine starting",
        address=settings.grpc_address,
        primary_model=settings.primary_model,
        fallback_model=settings.fallback_model,
    )

    # --- Dependency wiring ---
    llm_client = LLMClient(settings)
    token_counter = TokenCounter(
        model=settings.primary_model,
        max_context_tokens=settings.max_context_tokens,
    )
    output_parser = OutputParser(settings, llm_client=llm_client)
    servicer = CognitionServicer(
        settings=settings,
        llm_client=llm_client,
        token_counter=token_counter,
        output_parser=output_parser,
    )

    # --- gRPC server ---
    server = aio.server(
        options=[
            ("grpc.max_send_message_length", 64 * 1024 * 1024),   # 64 MiB
            ("grpc.max_receive_message_length", 64 * 1024 * 1024),
        ]
    )

    cognition_pb2_grpc.add_CognitionServiceServicer_to_server(servicer, server)

    # Server reflection (lets tools like grpcurl discover services at runtime).
    service_names = (
        cognition_pb2.DESCRIPTOR.services_by_name["CognitionService"].full_name,
        reflection.SERVICE_NAME,
    )
    reflection.enable_server_reflection(service_names, server)

    # Health checking.
    try:
        from grpc_health.v1 import health, health_pb2_grpc, health_pb2
        health_servicer = health.HealthServicer()
        health_pb2_grpc.add_HealthServicer_to_server(health_servicer, server)
        health_servicer.set(
            "cognition.CognitionService",
            health_pb2.HealthCheckResponse.SERVING,
        )
        log.info("gRPC health check enabled")
    except ImportError:
        log.warning("grpcio-health-checking not installed; health check disabled")

    server.add_insecure_port(settings.grpc_address)
    await server.start()
    log.info("gRPC server listening", address=settings.grpc_address)

    # --- Graceful shutdown ---
    stop_event = asyncio.Event()

    def _handle_signal() -> None:
        log.info("Shutdown signal received")
        stop_event.set()

    loop = asyncio.get_running_loop()
    for sig in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(sig, _handle_signal)

    await stop_event.wait()

    log.info("Draining connections (grace period 5 s)…")
    await server.stop(grace=5)
    log.info("Cognition Engine stopped")


def main() -> None:
    settings = Settings()
    configure_logging(level=settings.log_level, fmt=settings.log_format)
    asyncio.run(_run_server(settings))


if __name__ == "__main__":
    main()
