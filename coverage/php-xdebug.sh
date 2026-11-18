#!/usr/bin/env bash
# Runs Local WP's PHP with Xdebug in coverage mode. Override with COVERAGE_PHP_DIR.
B="${COVERAGE_PHP_DIR:-$HOME/.config/Local/lightning-services/php-8.2.29+0/bin/linux}"
export LD_LIBRARY_PATH="$B/shared-libs:$B/lib"
exec "$B/bin/php" -n -d zend_extension="$(ls "$B"/lib/php/extensions/*/xdebug.so | head -1)" -d xdebug.mode=coverage -d memory_limit=512M "$@"
