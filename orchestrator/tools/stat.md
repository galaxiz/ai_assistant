---
name = "stat"
version = "1.0.0"
description = "Display file or filesystem metadata (size, permissions, timestamps)."
backend = "native"
binary = "stat"
timeout_secs = 10

[permissions]
fs_read = true

[[args]]
name = "path"
type = "string"
required = true
description = "File or directory to inspect."
positional = true
---

# stat

Shows detailed metadata for a file or directory: size, permissions, owner, and modification/access timestamps.
