---
name = "sort"
version = "1.0.0"
description = "Sort lines of a file."
backend = "native"
binary = "sort"
timeout_secs = 10

[permissions]
fs_read = true

[[args]]
name = "flags"
type = "string"
required = false
description = "Optional flags: \"-r\" (reverse), \"-n\" (numeric), \"-u\" (unique), \"-k2\" (sort by field 2)."
positional = true

[[args]]
name = "path"
type = "string"
required = false
description = "File to sort."
positional = true
---

# sort

Sorts lines alphabetically by default. Use `-r` to reverse, `-n` for numeric sort, `-u` to deduplicate, `-k N` to sort by field N.
