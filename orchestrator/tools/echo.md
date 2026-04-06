---
name = "echo"
version = "1.0.0"
description = "Print a string to stdout."
backend = "native"
binary = "echo"
timeout_secs = 5

[[args]]
name = "text"
type = "string"
required = true
description = "The text to print."
positional = true
---

# echo

Prints `text` to stdout. Useful for producing literal strings in a pipeline or verifying tool output formatting.
