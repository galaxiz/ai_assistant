---
name = "tail"
version = "1.0.0"
description = "Output the last N lines of a file."
backend = "native"
binary = "tail"
timeout_secs = 10

[permissions]
fs_read = true

[[args]]
name = "path"
type = "string"
required = true
description = "File to read."
positional = true

[[args]]
name = "lines"
type = "integer"
required = false
description = "Number of lines to print (default 10)."
default = 10
positional = false
---

# tail

Prints the last `lines` lines of a file. Defaults to 10. Useful for log files.
