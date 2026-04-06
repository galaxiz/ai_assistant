---
name = "tr"
version = "1.0.0"
description = "Translate or delete characters read from stdin."
backend = "native"
binary = "tr"
timeout_secs = 10

[[args]]
name = "set1"
type = "string"
required = true
description = "Characters to translate from, e.g. \"a-z\" or \"[:upper:]\"."
positional = true

[[args]]
name = "set2"
type = "string"
required = false
description = "Characters to translate to, e.g. \"A-Z\". Omit when deleting characters."
positional = true
---

# tr

Translates characters from `set1` to `set2`. Reads from stdin only — use a shell pipeline in combination with other tools. Example: `set1 = "a-z"`, `set2 = "A-Z"` uppercases input.

Note: this tool requires stdin input; it produces no output when called standalone.
