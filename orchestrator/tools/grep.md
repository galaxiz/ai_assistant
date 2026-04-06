---
name = "grep"
version = "1.0.0"
description = "Search for a pattern in files."
backend = "native"
binary = "grep"
timeout_secs = 15

[permissions]
fs_read = true

[[args]]
name = "flags"
type = "string"
required = false
description = "Optional flags, e.g. \"-rn\" (recursive + line numbers), \"-i\" (case-insensitive), \"-l\" (filenames only)."
positional = true

[[args]]
name = "pattern"
type = "string"
required = true
description = "The pattern to search for."
positional = true

[[args]]
name = "path"
type = "string"
required = false
description = "File or directory to search. Omit to search stdin."
positional = true
---

# grep

Searches for `pattern` in `path`. Pass `flags` like `"-rn"` to recurse through directories and show line numbers, or `"-i"` for case-insensitive matching.
