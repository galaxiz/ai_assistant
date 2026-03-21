#!/usr/bin/env bash
LOCK="/Users/xizhao/projects/ai_agent/orchestrator/Cargo.lock"
CACHE="/Users/xizhao/projects/ai_agent/.cargo_local/registry/cache/index.crates.io-1949cf8c6b5b557f"

mkdir -p "$CACHE"

python3 - <<'PYEOF'
import re, os, subprocess

with open("/Users/xizhao/projects/ai_agent/orchestrator/Cargo.lock") as f:
    lock = f.read()

cache = "/Users/xizhao/projects/ai_agent/.cargo_local/registry/cache/index.crates.io-1949cf8c6b5b557f"
blocks = re.findall(r'\[\[package\]\](.*?)(?=\[\[package\]\]|\Z)', lock, re.DOTALL)

crates = []
for block in blocks:
    name_m    = re.search(r'name\s*=\s*"([^"]+)"', block)
    version_m = re.search(r'version\s*=\s*"([^"]+)"', block)
    source_m  = re.search(r'source\s*=\s*"([^"]+)"', block)
    if name_m and version_m and source_m and 'registry' in source_m.group(1):
        crates.append((name_m.group(1), version_m.group(1)))

print(f"To download: {len(crates)}", flush=True)

ok = 0
for name, version in crates:
    target = os.path.join(cache, f"{name}-{version}.crate")
    if os.path.exists(target) and os.path.getsize(target) > 100:
        ok += 1
        continue
    url = f"https://static.crates.io/crates/{name}/{version}/download"
    r = subprocess.run(["curl", "-sL", "-o", target, url], capture_output=True)
    if r.returncode != 0:
        print(f"err: {r.stderr.decode()}")
        break
    ok += 1
print(f"Done. {ok}/{len(crates)}")
PYEOF
