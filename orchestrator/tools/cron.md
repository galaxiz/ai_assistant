---
name = "cron"
version = "1.0.0"
description = "List the current user's scheduled cron jobs."
backend = "native"
binary = "crontab"
command_args = ["-l"]
timeout_secs = 5

[permissions]
fs_read = true
---

# cron

Lists the current user's crontab entries. Each line shows a schedule expression followed by the command to run.

**Note:** Adding or removing cron jobs is not supported — this tool is read-only.
