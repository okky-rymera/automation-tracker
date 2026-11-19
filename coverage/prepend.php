<?php
/**
 * Per-request PHP coverage collector (trial).
 *
 * PHP loads this file before WordPress on each request, through the
 * auto_prepend_file setting. It records which lines of the tracked plugins
 * (coverage/plugins.json) ran and writes one JSON file per request to
 * coverage-data/raw/ in this tool. The lines are kept by plugin name.
 * Older request files have one plugin, in "files" and "not_run" at the top.
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

/**
 * During a test run of a sync, coverage-data/test-site.json names the port of the test site
 * (server/test-run.ts). All sites of the tracker's echowp home share one PHP server, so record
 * only the requests to that port. Without the file (or when the run that wrote it has
 * stopped), record all requests, as before.
 */
function __atcov_other_site() {
	$mark = @file_get_contents( dirname( __DIR__ ) . '/coverage-data/test-site.json' );
	if ( false === $mark ) {
		return false;
	}
	$m = json_decode( $mark, true );
	if ( ! is_array( $m ) || empty( $m['port'] ) ) {
		return false;
	}
	if ( ! empty( $m['pid'] ) && is_dir( '/proc' ) && ! file_exists( '/proc/' . (int) $m['pid'] ) ) {
		return false; // Left by a run that stopped.
	}
	$host = isset( $_SERVER['HTTP_HOST'] ) ? (string) $_SERVER['HTTP_HOST'] : '';
	if ( preg_match( '/:(\d+)$/', $host, $p ) ) {
		$port = (int) $p[1];
	} elseif ( isset( $_SERVER['SERVER_PORT'] ) ) {
		$port = (int) $_SERVER['SERVER_PORT'];
	} else {
		return false;
	}
	return $port !== (int) $m['port'];
}
if ( __atcov_other_site() ) {
	return;
}

/**
 * The plugins to record: coverage/plugins.json, a list of plugin folder names that the app
 * writes from its projects (npm run project -- coverage-config). For each name, the folder
 * is found in this site's wp-content/plugins. A plugin there is often a link to a copy of
 * the repo, and Xdebug reports the real path, so both the link path and the real path count.
 */
function __atcov_roots() {
	$names = json_decode( (string) @file_get_contents( __DIR__ . '/plugins.json' ), true );
	if ( ! is_array( $names ) || ! $names ) {
		return array();
	}
	// Find wp-content/plugins: go up from the script that runs (index.php, wp-admin/..., wp-json goes
	// through index.php). Then try the web server's site folder. (PHP on the command line, such as
	// WP-CLI, is not recorded: see the check at the top of this file.)
	$plugins = null;
	$starts  = array(
		isset( $_SERVER['SCRIPT_FILENAME'] ) ? dirname( $_SERVER['SCRIPT_FILENAME'] ) : '',
		isset( $_SERVER['DOCUMENT_ROOT'] ) ? rtrim( $_SERVER['DOCUMENT_ROOT'], '/' ) : '',
	);
	foreach ( $starts as $dir ) {
		for ( $i = 0; $i < 4 && $dir && '/' !== $dir && null === $plugins; $i++, $dir = dirname( $dir ) ) {
			if ( is_dir( $dir . '/wp-content/plugins' ) ) {
				$plugins = $dir . '/wp-content/plugins';
			}
		}
	}
	if ( null === $plugins ) {
		return array();
	}
	$roots = array(); // root path => plugin name
	foreach ( $names as $name ) {
		if ( ! is_string( $name ) || '' === $name || false !== strpos( $name, '/' ) || ! is_dir( "$plugins/$name" ) ) {
			continue;
		}
		$roots[ "$plugins/$name/" ] = $name;
		$real                       = realpath( "$plugins/$name" );
		if ( $real ) {
			$roots[ $real . '/' ] = $name;
		}
	}
	return $roots;
}

$__atcov_roots = __atcov_roots();
if ( ! $__atcov_roots ) {
	return; // No tracked plugin on this site.
}

$GLOBALS['__atcov'] = array(
	'start'   => microtime( true ),
	'out_dir' => dirname( __DIR__ ) . '/coverage-data/raw',
	'roots'   => $__atcov_roots,
);

// OPcache serves already-compiled files, and then Xdebug does not report the
// lines that did not run inside functions that ran. Turn it off for this request.
// (opcache.enable can be turned off at runtime, but not on.)
ini_set( 'opcache.enable', '0' );

xdebug_set_filter( XDEBUG_FILTER_CODE_COVERAGE, XDEBUG_PATH_INCLUDE, array_keys( $GLOBALS['__atcov']['roots'] ) );
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

	// Lines by plugin: name => { files: { path => lines that ran }, not_run: { path => runnable lines that did not run } }.
	$plugins = array();
	foreach ( $data as $file => $lines ) {
		$rel  = null;
		$name = null;
		foreach ( $cfg['roots'] as $root => $plugin ) {
			if ( strpos( $file, $root ) === 0 ) {
				$rel  = substr( $file, strlen( $root ) );
				$name = $plugin;
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
			$plugins[ $name ]['files'][ $rel ] = $hit;
		}
		if ( $unused ) {
			$plugins[ $name ]['not_run'][ $rel ] = $unused;
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
		'plugins' => $plugins,
	);

	$name = sprintf( '%.6f-%d.json', $cfg['start'], getmypid() );
	@file_put_contents( $cfg['out_dir'] . '/' . $name, json_encode( $record ) );
}
