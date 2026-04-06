---
name = "which"
version = "1.0.0"
description = "Locate a command binary on PATH."
backend = "native"
binary = "which"
timeout_secs = 5

[[args]]
name = "command"
type = "string"
required = true
description = "The command name to locate, e.g. \"python3\" or \"curl\"."
positional = true
---

# which

Prints the full path of the executable that would be run for `command`. Useful for confirming whether a tool is installed and where it lives.
