#!/bin/sh
# Stub for sudo, su, doas, pkexec and echowp. A sync job must never ask for a password
# or start echowp sites. server/sync.ts puts this folder first in PATH for each command
# it starts, and makes the links to this file (one for each name) when they are missing.
echo "automation-tracker: $(basename "$0") is blocked in sync jobs" >&2
exit 1
