#!/usr/bin/env bash
# vendor_deps.sh — populate vendor/ from Cargo.lock using curl + tar.
# Run this from the orchestrator/ directory.
set -euo pipefail

LOCK="Cargo.lock"
VENDOR="vendor"
CARGO_CONFIG=".cargo/config.toml"

if [ ! -f "$LOCK" ]; then
  echo "ERROR: Cargo.lock not found. Run 'cargo generate-lockfile' first." >&2
  exit 1
fi

mkdir -p "$VENDOR"

# Parse name/version for all registry crates from Cargo.lock.
python3 - <<'PYEOF'
import re, sys, os, subprocess, hashlib, json

lock_path = "Cargo.lock"
with open(lock_path) as f:
    lock = f.read()

vendor = "vendor"

# Find all [[package]] blocks
blocks = re.findall(r'\[\[package\]\](.*?)(?=\[\[package\]\]|\Z)', lock, re.DOTALL)

crates = []
for block in blocks:
    name_m    = re.search(r'name\s*=\s*"([^"]+)"', block)
    version_m = re.search(r'version\s*=\s*"([^"]+)"', block)
    source_m  = re.search(r'source\s*=\s*"([^"]+)"', block)
    if name_m and version_m and source_m and 'registry' in source_m.group(1):
        crates.append((name_m.group(1), version_m.group(1)))

print(f"Total registry crates: {len(crates)}", flush=True)

ok = 0
fail = 0
for name, version in crates:
    dest = os.path.join(vendor, f"{name}-{version}")
    checksum_file = os.path.join(dest, ".cargo-checksum.json")
    if os.path.exists(checksum_file):
        ok += 1
        continue  # already vendored

    url = f"https://static.crates.io/crates/{name}/{version}/download"
    crate_file = f"/tmp/{name}-{version}.crate"

    print(f"  Downloading {name} {version} ...", flush=True)
    r = subprocess.run(
        ["curl", "-sL", "--retry", "3", "--retry-delay", "2",
         "-o", crate_file, url],
        capture_output=True
    )
    if r.returncode != 0 or not os.path.exists(crate_file) or os.path.getsize(crate_file) < 100:
        print(f"  FAILED: {name} {version}", flush=True)
        if os.path.exists(crate_file):
            os.unlink(crate_file)
        fail += 1
        continue

    # .crate files are tar.gz
    os.makedirs(dest, exist_ok=True)
    r2 = subprocess.run(
        ["tar", "xzf", crate_file, "--strip-components=1", "-C", dest],
        capture_output=True
    )
    if r2.returncode != 0:
        print(f"  EXTRACT FAILED: {name} {version}: {r2.stderr.decode()}", flush=True)
        fail += 1
        os.unlink(crate_file)
        continue

    # Compute sha256 of the .crate file for .cargo-checksum.json
    sha256 = hashlib.sha256(open(crate_file, "rb").read()).hexdigest()
    checksum = {"files": {}, "package": sha256}
    with open(checksum_file, "w") as f:
        json.dump(checksum, f)

    os.unlink(crate_file)
    ok += 1

print(f"\nDone. Succeeded: {ok}, Failed: {fail}")
PYEOF

# Write .cargo/config.toml to use the vendor directory.
mkdir -p .cargo
cat > "$CARGO_CONFIG" <<'TOML'
[source.crates-io]
replace-with = "vendored-sources"

[source.vendored-sources]
directory = "vendor"
TOML

echo ""
echo ".cargo/config.toml written — cargo will now use vendor/ offline."
echo "Run: cargo check --offline"
