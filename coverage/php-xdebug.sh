#!/usr/bin/env bash
# Runs PHP with Xdebug in coverage mode, for coverage/runnable-lines.php.
# First choice: the tracker's coverage PHP (npm run project -- coverage-php), the same PHP
# version as the test sites. It gets only the Xdebug lines of its ini (no recorder).
# Else: Local WP's PHP. Override that folder with COVERAGE_PHP_DIR.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
C="$ROOT/data/coverage-php/current"
if [ -z "$COVERAGE_PHP_DIR" ] && [ -x "$C/bin/frankenphp" ] && [ -f "$C/xdebug.so" ]; then
  INI="$(mktemp -d)"
  trap 'rm -rf "$INI"' EXIT
  printf 'zend_extension=%s\nxdebug.mode=coverage\nmemory_limit=512M\n' "$C/xdebug.so" > "$INI/xdebug.ini"
  PHP_INI_SCAN_DIR="$INI" PHPRC="$INI" "$C/bin/frankenphp" php-cli "$@"
  exit $?
fi
B="${COVERAGE_PHP_DIR:-$HOME/.config/Local/lightning-services/php-8.2.29+0/bin/linux}"
export LD_LIBRARY_PATH="$B/shared-libs:$B/lib"
exec "$B/bin/php" -n -d zend_extension="$(ls "$B"/lib/php/extensions/*/xdebug.so | head -1)" -d xdebug.mode=coverage -d memory_limit=512M "$@"
