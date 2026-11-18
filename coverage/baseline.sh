#!/usr/bin/env bash
# Plain page loads that test nothing. The code that runs here is "library code"
# (plugin startup that runs on every request). Each request sends the header
# X-Coverage-Kind: baseline, so analyze.py can find it.
#
# Usage: coverage/baseline.sh <site-url> <admin-user> <admin-password>
set -euo pipefail

SITE="${1:?site url}"
USER_NAME="${2:?admin user}"
PASS="${3:?admin password}"
JAR="$(mktemp)"
trap 'rm -f "$JAR"' EXIT
H='X-Coverage-Kind: baseline'

# 1. Home page as a guest.
curl -s -o /dev/null -H "$H" "$SITE/"

# 2. REST API index as a guest.
curl -s -o /dev/null -H "$H" "$SITE/wp-json/"

# 3. Admin dashboard as admin. The login request itself is not baseline.
curl -s -o /dev/null -c "$JAR" -b "wordpress_test_cookie=WP%20Cookie%20check" \
  --data-urlencode "log=$USER_NAME" --data-urlencode "pwd=$PASS" \
  --data "wp-submit=Log+In&testcookie=1" "$SITE/wp-login.php"
curl -s -o /dev/null -b "$JAR" -H "$H" "$SITE/wp-admin/"

echo "Baseline requests done."
