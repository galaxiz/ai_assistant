#!/bin/sh
set -e

# Start the at daemon (requires root) so at_schedule jobs are executed.
service atd start

# Drop to the unprivileged orchestrator user for the main process.
exec su -s /bin/sh orchestrator -c "exec $*"
