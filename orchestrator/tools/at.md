---
name = "at"
version = "1.0.0"
description = "List pending one-time scheduled jobs queued with 'at'."
backend = "native"
binary = "atq"
timeout_secs = 5

[permissions]
fs_read = true
---

# at

Lists pending one-time jobs scheduled via the `at` command. Output shows job number, execution time, queue, and the owning user.

**Note:** Scheduling new jobs requires stdin input and is not supported. To remove a pending job, use `atrm <job_number>` directly on the host.
