---
name = "uniq"
version = "1.0.0"
description = "Remove or report duplicate adjacent lines in a file."
backend = "native"
binary = "uniq"
timeout_secs = 10

[permissions]
fs_read = true

[[args]]
name = "flags"
type = "string"
required = false
description = "Optional flags: \"-c\" (prefix count), \"-d\" (only duplicates), \"-u\" (only unique)."
positional = true

[[args]]
name = "path"
type = "string"
required = false
description = "File to process. Sort the file first for global deduplication."
positional = true
---

# uniq

Removes consecutive duplicate lines. Pair with `sort` for full deduplication: sort the file first, then pipe through uniq. Use `-c` to show occurrence counts.
