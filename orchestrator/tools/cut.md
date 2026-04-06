---
name = "cut"
version = "1.0.0"
description = "Extract specific fields or character ranges from each line of a file."
backend = "native"
binary = "cut"
timeout_secs = 10

[permissions]
fs_read = true

[[args]]
name = "path"
type = "string"
required = false
description = "File to process."
positional = true

[[args]]
name = "delimiter"
type = "string"
required = false
description = "Field delimiter character, e.g. \":\" or \",\". Used with `fields`."
positional = false

[[args]]
name = "fields"
type = "string"
required = false
description = "Field numbers to extract, e.g. \"1\", \"1,3\", or \"2-4\"."
positional = false

[[args]]
name = "characters"
type = "string"
required = false
description = "Character positions to extract, e.g. \"1-5\" or \"3\"."
positional = false
---

# cut

Extracts columns from each line. Use `delimiter` + `fields` for delimited data (e.g. CSV, `/etc/passwd`), or `characters` for fixed-width columns. Example: delimiter `":"` and fields `"1"` extracts the first colon-separated field.
