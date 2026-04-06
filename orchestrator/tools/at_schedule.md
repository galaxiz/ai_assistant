---
name = "at_schedule"
version = "1.0.0"
description = "Schedule a one-time shell command to run at a specific time."
backend = "native"
binary = "at"
timeout_secs = 10

[permissions]
fs_read = true
fs_write = true

[[args]]
name = "time"
type = "string"
required = true
description = "When to run the command. Accepts natural time specs: 'now + 5 minutes', 'noon', 'midnight', '2:30 PM', 'tomorrow', '11pm + 2 days', etc."
positional = true

[[args]]
name = "command"
type = "string"
required = true
description = "The shell command to execute at the scheduled time."
is_stdin = true
---

# at_schedule

Schedules a one-time command to run at `time`. The job is queued and executed once by the system `at` daemon.

Use the `at` tool to list pending jobs and check their job numbers.

Example:
- `time`: `"now + 10 minutes"`
- `command`: `"/usr/local/bin/send_report.sh"`
