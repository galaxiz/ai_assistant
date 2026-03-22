---
name = "git_diff"
version = "0.1.0"
description = "Show unstaged changes in the working tree."
backend = "native"
binary = "git"
command_args = ["diff"]
timeout_secs = 15

[permissions]
fs_read = true

[[args]]
name = "path"
type = "string"
required = false
description = "Limit diff to a specific file or directory."
positional = true
---

# git_diff

Runs `git diff [path]` and returns the output.
