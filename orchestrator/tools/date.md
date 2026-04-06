---
name = "date"
version = "1.0.0"
description = "Print the current date and time."
backend = "native"
binary = "date"
timeout_secs = 5

[[args]]
name = "format"
type = "string"
required = false
description = "Output format string starting with '+', e.g. \"+%Y-%m-%d %H:%M:%S\". Omit for the default locale format."
positional = true
---

# date

Prints the current date and time. Pass a `format` string like `"+%Y-%m-%d"` to control the output format.
