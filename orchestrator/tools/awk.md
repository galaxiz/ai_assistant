---
name = "awk"
version = "1.0.0"
description = "Run an awk program to extract or transform fields in a file."
backend = "native"
binary = "awk"
timeout_secs = 10

[permissions]
fs_read = true

[[args]]
name = "program"
type = "string"
required = true
description = "awk program string, e.g. \"{print $1}\" to print the first field of each line."
positional = true

[[args]]
name = "path"
type = "string"
required = true
description = "File to process."
positional = true
---

# awk

Processes `path` line by line with `program`. Fields are split on whitespace by default. Example: `"{print $2}"` prints the second column of every line.
