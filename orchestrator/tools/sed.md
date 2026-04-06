---
name = "sed"
version = "1.0.0"
description = "Apply a sed expression to transform lines in a file."
backend = "native"
binary = "sed"
timeout_secs = 10

[permissions]
fs_read = true

[[args]]
name = "expression"
type = "string"
required = true
description = "sed expression, e.g. \"s/foo/bar/g\" to replace all occurrences."
positional = true

[[args]]
name = "path"
type = "string"
required = true
description = "File to process."
positional = true
---

# sed

Applies a stream-editing expression to each line of `path`. Common use: `"s/old/new/g"` replaces every occurrence of `old` with `new`. Output is written to stdout; the file is not modified.
