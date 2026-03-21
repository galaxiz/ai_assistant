//! Telemetry — structured logging, OpenTelemetry traces, and OTLP metrics.
//!
//! Call `init()` once at startup before any other code logs.
//! After `init()`, call `metrics()` anywhere to record against shared instruments.

use opentelemetry::{
    global,
    metrics::{Counter, Histogram},
    KeyValue,
};
use opentelemetry_sdk::{
    metrics::PeriodicReader,
    runtime::Tokio,
    trace::Sampler,
};
use tracing_subscriber::{fmt, layer::SubscriberExt, util::SubscriberInitExt, EnvFilter, Layer};

use crate::config::Settings;

// ---------------------------------------------------------------------------
// Metrics instruments
// ---------------------------------------------------------------------------

/// Key OpenTelemetry metric instruments.
/// Obtain via `metrics()` after `init()` has been called.
pub struct Metrics {
    /// Total inbound agent requests, tagged with `endpoint` (ws | webhook).
    pub requests_total: Counter<u64>,
    /// End-to-end agent loop duration in milliseconds.
    pub request_duration_ms: Histogram<f64>,
    /// Tool invocations, tagged with `tool` and `status` (ok | error | denied).
    pub tool_calls_total: Counter<u64>,
    /// Tool execution wall-clock duration in milliseconds.
    pub tool_duration_ms: Histogram<f64>,
}

impl Metrics {
    fn build() -> Self {
        let meter = global::meter("orchestrator");
        Self {
            requests_total: meter
                .u64_counter("agent.requests.total")
                .with_description("Total inbound agent requests")
                .build(),
            request_duration_ms: meter
                .f64_histogram("agent.request.duration_ms")
                .with_description("End-to-end agent loop duration in ms")
                .build(),
            tool_calls_total: meter
                .u64_counter("agent.tool_calls.total")
                .with_description("Tool invocations by name and status")
                .build(),
            tool_duration_ms: meter
                .f64_histogram("agent.tool.duration_ms")
                .with_description("Tool execution duration in ms")
                .build(),
        }
    }
}

/// Return the global metrics instruments.
/// `init()` must have been called first.
pub fn metrics() -> Metrics {
    Metrics::build()
}

// ---------------------------------------------------------------------------
// Initialisation
// ---------------------------------------------------------------------------

pub fn init(settings: &Settings) -> anyhow::Result<()> {
    let t = &settings.telemetry;
    let filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new(&t.log_level));

    let local_time = fmt::time::ChronoLocal::new("%Y-%m-%dT%H:%M:%S%.3f%:z".to_string());

    let fmt_layer: Box<dyn Layer<_> + Send + Sync> = if t.log_format == "json" {
        Box::new(fmt::layer().json().with_timer(local_time).with_filter(filter))
    } else {
        Box::new(fmt::layer().pretty().with_timer(local_time).with_filter(EnvFilter::new(&t.log_level)))
    };

    let registry = tracing_subscriber::registry().with(fmt_layer);

    if let Some(endpoint) = &t.otlp_endpoint {
        use opentelemetry::trace::TracerProvider as _;
        use opentelemetry_otlp::WithExportConfig;

        let resource = opentelemetry_sdk::Resource::new(vec![
            KeyValue::new("service.name", t.service_name.clone()),
        ]);

        // --- Traces ---
        let sampler = if t.sampling_rate >= 1.0 {
            Sampler::AlwaysOn
        } else if t.sampling_rate <= 0.0 {
            Sampler::AlwaysOff
        } else {
            Sampler::TraceIdRatioBased(t.sampling_rate)
        };

        let span_exporter = opentelemetry_otlp::SpanExporter::builder()
            .with_tonic()
            .with_endpoint(endpoint)
            .build()?;

        let trace_provider = opentelemetry_sdk::trace::TracerProvider::builder()
            .with_sampler(sampler)
            .with_batch_exporter(span_exporter, Tokio)
            .with_resource(resource.clone())
            .build();

        let tracer = trace_provider.tracer("orchestrator");
        global::set_tracer_provider(trace_provider);

        // --- Metrics ---
        let metric_exporter = opentelemetry_otlp::MetricExporter::builder()
            .with_tonic()
            .with_endpoint(endpoint)
            .build()?;

        let metric_reader = PeriodicReader::builder(metric_exporter, Tokio).build();

        let meter_provider = opentelemetry_sdk::metrics::SdkMeterProvider::builder()
            .with_reader(metric_reader)
            .with_resource(resource)
            .build();

        global::set_meter_provider(meter_provider);

        // Wire traces into tracing-subscriber.
        let otel_layer = tracing_opentelemetry::layer().with_tracer(tracer);
        registry.with(otel_layer).init();
    } else {
        registry.init();
    }

    Ok(())
}
