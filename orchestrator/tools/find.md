---
name = "find"
version = "1.0.0"
description = "Recursively list all files and directories under a path."
backend = "native"
binary = "find"
timeout_secs = 15

[permissions]
fs_read = true

[[args]]
name = "path"
type = "string"
required = false
description = "Root directory to search. Defaults to the sandbox root (\".\")"
default = "."
positional = true
---

# find

Lists all files and directories under `path` recursively. To filter by name pattern, pipe the output through `grep`.
