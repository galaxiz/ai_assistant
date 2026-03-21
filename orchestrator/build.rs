/// Build script — compiles `proto/cognition.proto` into Rust via tonic-build.
///
/// Uses `protoc-bin-vendored` so no system `protoc` installation is required.
fn main() -> Result<(), Box<dyn std::error::Error>> {
    // Point tonic-build at the vendored protoc binary.
    let protoc = protoc_bin_vendored::protoc_bin_path().unwrap();
    std::env::set_var("PROTOC", protoc);

    tonic_build::configure()
        .build_client(true)
        .build_server(false) // Orchestrator is a client of the Cognition Engine
        .compile_protos(
            &["../proto/cognition.proto"],
            &["../proto"],
        )?;

    println!("cargo:rerun-if-changed=../proto/cognition.proto");

    Ok(())
}
