---
name = "diff"
version = "1.0.0"
description = "Compare two files line by line."
backend = "native"
binary = "diff"
timeout_secs = 10

[permissions]
fs_read = true

[[args]]
name = "flags"
type = "string"
required = false
description = "Optional flags: \"-u\" (unified format), \"-i\" (ignore case), \"-w\" (ignore whitespace)."
positional = true

[[args]]
name = "file1"
type = "string"
required = true
description = "First file to compare."
positional = true

[[args]]
name = "file2"
type = "string"
required = true
description = "Second file to compare."
positional = true
---

# diff

Compares two files and shows the differences. Use `-u` for unified diff format (shows context lines), which is the most readable output.
