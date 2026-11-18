<?php
/**
 * Per-request PHP coverage collector (trial).
 *
 * PHP loads this file before WordPress on each request, through the
 * auto_prepend_file setting. It records which lines of the plugin ran
 * and writes one JSON file per request to coverage-data/raw/.
 *
 * Requests are matched to tests later by time (start/end below), so
 * the test run must use one worker.
 */

if ( ! function_exists( 'xdebug_start_code_coverage' ) || PHP_SAPI === 'cli' ) {
	return;
}

// Requests can turn coverage off with this header (for example, test setup calls).
if ( isset( $_SERVER['HTTP_X_COVERAGE_SKIP'] ) ) {
	return;
}

$GLOBALS['__atcov'] = array(
	'start'   => microtime( true ),
	'out_dir' => '/home/chili/Works/Projects/automation-tracker/coverage-data/raw',
	// The plugin is a symlink in the site, so match both the real path and the link path.
	'roots'   => array(
		'/home/chili/Works/wp-plugins/woocommerce-wholesale-prices/',
		'/home/chili/Local Sites/automation-tracker/app/public/wp-content/plugins/woocommerce-wholesale-prices/',
	),
);

// OPcache serves already-compiled files, and then Xdebug does not report the
// lines that did not run inside functions that ran. Turn it off for this request.
// (opcache.enable can be turned off at runtime, but not on.)
ini_set( 'opcache.enable', '0' );

xdebug_set_filter( XDEBUG_FILTER_CODE_COVERAGE, XDEBUG_PATH_INCLUDE, $GLOBALS['__atcov']['roots'] );
// XDEBUG_CC_UNUSED also reports lines that can run but did not (value -1).
// That gives the total of runnable lines, so coverage can be counted per line.
xdebug_start_code_coverage( XDEBUG_CC_UNUSED | XDEBUG_CC_DEAD_CODE );

// WordPress registers its own shutdown work after this file runs. Shutdown
// functions run in order, so register the writer from inside a shutdown
// function. That puts it last, after the WordPress "shutdown" hook.
register_shutdown_function(
	function () {
		register_shutdown_function( '__atcov_write' );
	}
);

function __atcov_write() {
	$cfg  = $GLOBALS['__atcov'];
	$data = xdebug_get_code_coverage();
	xdebug_stop_code_coverage();

	$files   = array();
	$not_run = array(); // Runnable lines that did not run in this request.
	foreach ( $data as $file => $lines ) {
		$rel = null;
		foreach ( $cfg['roots'] as $root ) {
			if ( strpos( $file, $root ) === 0 ) {
				$rel = substr( $file, strlen( $root ) );
				break;
			}
		}
		if ( null === $rel || strpos( $rel, 'vendor/' ) === 0 || strpos( $rel, 'node_modules/' ) === 0 ) {
			continue;
		}
		$hit    = array();
		$unused = array();
		foreach ( $lines as $line => $count ) {
			if ( $count > 0 ) {
				$hit[] = $line;
			} elseif ( -1 === $count ) {
				$unused[] = $line;
			}
		}
		if ( $hit ) {
			$files[ $rel ] = $hit;
		}
		if ( $unused ) {
			$not_run[ $rel ] = $unused;
		}
	}

	if ( ! is_dir( $cfg['out_dir'] ) ) {
		@mkdir( $cfg['out_dir'], 0775, true );
	}

	$record = array(
		'start'   => $cfg['start'],
		'end'     => microtime( true ),
		'method'  => isset( $_SERVER['REQUEST_METHOD'] ) ? $_SERVER['REQUEST_METHOD'] : '',
		'uri'     => isset( $_SERVER['REQUEST_URI'] ) ? $_SERVER['REQUEST_URI'] : '',
		'test_id' => isset( $_SERVER['HTTP_X_COVERAGE_ID'] ) ? $_SERVER['HTTP_X_COVERAGE_ID'] : null,
		// admin-ajax.php requests name their job in "action" (for example "heartbeat").
		'action'  => isset( $_REQUEST['action'] ) && is_string( $_REQUEST['action'] ) ? $_REQUEST['action'] : null,
		// "baseline" marks plain page loads that test nothing (coverage/baseline.sh).
		'kind'    => isset( $_SERVER['HTTP_X_COVERAGE_KIND'] ) ? $_SERVER['HTTP_X_COVERAGE_KIND'] : null,
		'files'   => $files,
		'not_run' => $not_run,
	);

	$name = sprintf( '%.6f-%d.json', $cfg['start'], getmypid() );
	@file_put_contents( $cfg['out_dir'] . '/' . $name, json_encode( $record ) );
}
