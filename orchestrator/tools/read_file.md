---
name = "read_file"
version = "0.1.0"
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
description = "Path of the file to read, relative to the sandbox root."

[[args]]
name = "max_bytes"
type = "integer"
required = false
description = "Maximum number of bytes to read. Defaults to 4096."
default = 4096
---

# read_file

Read up to `max_bytes` bytes from a file at `path` within the sandbox.

## Arguments

| Name        | Type    | Required | Default | Description                                    |
|-------------|---------|----------|---------|------------------------------------------------|
| `path`      | string  | yes      | —       | Path of the file to read (sandbox-relative).   |
| `max_bytes` | integer | no       | 4096    | Maximum bytes to return.                       |

## Returns

```json
{"content": "<file contents as UTF-8 string>"}
```

On error the tool exits with a non-zero status and writes a JSON error to stdout:

```json
{"error": "<description>"}
```
