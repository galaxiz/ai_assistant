---
name = "du"
version = "1.0.0"
description = "Estimate disk usage of files and directories."
backend = "native"
binary = "du"
timeout_secs = 15

[permissions]
fs_read = true

[[args]]
name = "flags"
type = "string"
required = false
description = "Optional flags: \"-sh\" (summary, human-readable), \"-h\" (human-readable sizes), \"-a\" (all files)."
positional = true

[[args]]
name = "path"
type = "string"
required = false
description = "File or directory to measure. Defaults to the sandbox root."
positional = true
---

# du

Reports disk usage. Use `-sh` for a single human-readable summary of a directory, or `-h` to show sizes of all subdirectories.
