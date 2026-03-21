use std::io::{self, Read, Write};

use serde::{Deserialize, Serialize};

#[derive(Deserialize)]
struct Args {
    path: String,
    #[serde(default = "default_max_bytes")]
    max_bytes: usize,
}

fn default_max_bytes() -> usize {
    4096
}

#[derive(Serialize)]
#[serde(untagged)]
enum Output {
    Ok { content: String },
    Err { error: String },
}

fn run() -> Output {
    // Read args JSON from stdin.
    let mut input = String::new();
    if let Err(e) = io::stdin().read_to_string(&mut input) {
        return Output::Err { error: format!("failed to read stdin: {e}") };
    }

    let args: Args = match serde_json::from_str(&input) {
        Ok(a) => a,
        Err(e) => return Output::Err { error: format!("invalid args JSON: {e}") },
    };

    // Open and read the file (WASI fs — path is relative to the preopened dir).
    let file = std::fs::File::open(&args.path);
    let mut file = match file {
        Ok(f) => f,
        Err(e) => return Output::Err { error: format!("cannot open '{}': {e}", args.path) },
    };

    let mut buf = vec![0u8; args.max_bytes];
    let n = match file.read(&mut buf) {
        Ok(n) => n,
        Err(e) => return Output::Err { error: format!("read error: {e}") },
    };
    buf.truncate(n);

    match String::from_utf8(buf) {
        Ok(content) => Output::Ok { content },
        Err(_) => Output::Err { error: "file content is not valid UTF-8".to_string() },
    }
}

fn main() {
    let output = run();
    let json = serde_json::to_string(&output).unwrap_or_else(|_| r#"{"error":"serialisation failed"}"#.to_string());
    io::stdout().write_all(json.as_bytes()).ok();
}
