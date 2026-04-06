---
name = "cat"
version = "1.0.0"
description = "Print the contents of a file to stdout."
backend = "native"
binary = "cat"
timeout_secs = 10

[permissions]
fs_read = true

[[args]]
name = "path"
type = "string"
required = true
description = "Path of the file to read."
positional = true
---

# cat

Outputs the full contents of a file. For large files, prefer `head` or `tail` to read a portion.
