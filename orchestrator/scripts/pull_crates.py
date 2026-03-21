import re, os, time, urllib.request, urllib.error

lock_path = "/Users/xizhao/projects/ai_agent/orchestrator/Cargo.lock"
with open(lock_path) as f: lock = f.read()

cache = "/Users/xizhao/projects/ai_agent/.cargo_local/registry/cache/index.crates.io-1949cf8c6b5b557f"
os.makedirs(cache, exist_ok=True)

blocks = re.findall(r'\[\[package\]\](.*?)(?=\[\[package\]\]|\Z)', lock, re.DOTALL)
crates = []
for block in blocks:
    name_m, version_m, source_m = re.search(r'name\s*=\s*"([^"]+)"', block), \
        re.search(r'version\s*=\s*"([^"]+)"', block), re.search(r'source\s*=\s*"([^"]+)"', block)
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
    for attempt in range(5):
        try:
            urllib.request.urlretrieve(url, target)
            break
        except urllib.error.URLError as e:
            print(f"Retry {attempt} for {name}-{version}: {e}")
            time.sleep(1)
    else:
        print(f"Failed to download {name}-{version} after 5 attempts")
        if os.path.exists(target): os.unlink(target)
        break # Exit completely to see what broke
    ok += 1

print(f"Done. {ok}/{len(crates)}")
