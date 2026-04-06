---
name = "cron_set"
version = "1.0.0"
description = "Replace the current user's crontab with new content."
backend = "native"
binary = "crontab"
command_args = ["-"]
timeout_secs = 10

[permissions]
fs_read = true
fs_write = true

[[args]]
name = "content"
type = "string"
required = true
description = "Full crontab content to install. Each line is either a comment (#), an environment assignment (KEY=value), or a cron entry in the format: minute hour day month weekday command. Use 'cron' tool first to read the existing crontab before overwriting."
is_stdin = true
---

# cron_set

Replaces the current user's entire crontab with the provided `content`.

**This overwrites all existing cron jobs.** Always read the current crontab with the `cron` tool first, then include existing entries alongside any new ones.

Example content:
```
# Run backup every day at 2am
0 2 * * * /usr/local/bin/backup.sh

# Run cleanup every Sunday at midnight
0 0 * * 0 /usr/local/bin/cleanup.sh
```
