---
name = "read_file"
version = "1.0.0"
description = "Read the contents of a file within the sandbox."
wasm = "read_file.wasm"
timeout_secs = 10

[permissions]
fs_read = true
fs_write = false
network = false

[[args]]
name = "path"
type = "string"
required = true
description = "Path of the file to read (relative to the sandbox root)."
---

# read_file

Reads the contents of a file and returns them as a string.

The `path` argument is relative to the agent's sandbox root directory.
Use this tool to inspect files the agent has access to.

## Example

```tool_call
{"tool": "read_file", "call_id": "c1", "args": {"path": "notes.txt"}}
```
