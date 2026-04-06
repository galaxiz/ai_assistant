---
name = "ls"
version = "1.0.0"
description = "List directory contents."
backend = "native"
binary = "ls"
timeout_secs = 10

[permissions]
fs_read = true

[[args]]
name = "flags"
type = "string"
required = false
description = "Optional flags, e.g. \"-la\" or \"-lh\" for a long listing."
positional = true

[[args]]
name = "path"
type = "string"
required = false
description = "Directory or file to list. Defaults to the sandbox root."
positional = true
---

# ls

Lists files and directories. Use `flags` like `"-la"` for a detailed listing including hidden files, `"-lh"` for human-readable sizes.
