---
name = "wc"
version = "1.0.0"
description = "Count lines, words, and bytes in a file."
backend = "native"
binary = "wc"
timeout_secs = 10

[permissions]
fs_read = true

[[args]]
name = "flags"
type = "string"
required = false
description = "Optional flags: \"-l\" (lines only), \"-w\" (words only), \"-c\" (bytes only)."
positional = true

[[args]]
name = "path"
type = "string"
required = false
description = "File to count. Omit to read from stdin."
positional = true
---

# wc

Counts lines, words, and bytes in a file. Use `-l` for line count only, `-w` for words, `-c` for bytes.
