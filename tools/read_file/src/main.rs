use std::io::{self, Read};

fn main() {
    let mut input = String::new();
    io::stdin().read_to_string(&mut input).expect("failed to read stdin");

    let args: serde_json::Value = serde_json::from_str(&input).unwrap_or_default();

    let path = match args.get("path").and_then(|v| v.as_str()) {
        Some(p) => p,
        None => {
            eprintln!("missing required arg: path");
            std::process::exit(1);
        }
    };

    match std::fs::read_to_string(path) {
        Ok(contents) => print!("{}", contents),
        Err(e) => {
            eprintln!("error reading '{}': {}", path, e);
            std::process::exit(1);
        }
    }
}
