<?php
/**
 * Per-request PHP coverage collector (trial).
 *
 * PHP loads this file before WordPress on each request, through the
 * auto_prepend_file setting. It records which lines of the tracked plugins
 * (coverage/plugins.json) ran and writes one JSON file per request to
 * coverage-data/raw/ in this tool. The lines are kept by plugin name.
 * It records only the lines that ran. coverage/analyze.py counts the lines that
 * can run with coverage/runnable-lines.php.
 * Older request files also have "not_run" (lines that can run but did not), and
 * the oldest have one plugin, in "files" and "not_run" at the top.
 *
 * Requests are matched to tests later by time (start/end below). In a run with
 * more workers, each worker has its own site, so the port also names the worker.
 */

if ( ! function_exists( 'xdebug_start_code_coverage' ) || PHP_SAPI === 'cli' ) {
	return;
}

// Requests can turn coverage off with this header (for example, test setup calls).
if ( isset( $_SERVER['HTTP_X_COVERAGE_SKIP'] ) ) {
	return;
}

/**
 * The port of this request: the port in the Host header, else the server port. null when unknown.
 */
function __atcov_port() {
	$host = isset( $_SERVER['HTTP_HOST'] ) ? (string) $_SERVER['HTTP_HOST'] : '';
	if ( preg_match( '/:(\d+)$/', $host, $p ) ) {
		return (int) $p[1];
	}
	return isset( $_SERVER['SERVER_PORT'] ) ? (int) $_SERVER['SERVER_PORT'] : null;
}

/**
 * During a test run of a sync, coverage-data/test-site.json names the ports of the test sites
 * (server/test-run.ts): one site for each Playwright worker. All sites of the tracker's echowp
 * home share one PHP server, so record only the requests to those ports. Without the file (or
 * when the run that wrote it has stopped), record all requests, as before.
 * Older files have one "port" in place of "ports".
 */
function __atcov_other_site() {
	$mark = @file_get_contents( dirname( __DIR__ ) . '/coverage-data/test-site.json' );
	if ( false === $mark ) {
		return false;
	}
	$m = json_decode( $mark, true );
	if ( ! is_array( $m ) ) {
		return false;
	}
	$ports = isset( $m['ports'] ) && is_array( $m['ports'] ) ? $m['ports'] : ( empty( $m['port'] ) ? array() : array( $m['port'] ) );
	if ( ! $ports ) {
		return false;
	}
	if ( ! empty( $m['pid'] ) && is_dir( '/proc' ) && ! file_exists( '/proc/' . (int) $m['pid'] ) ) {
		return false; // Left by a run that stopped.
	}
	$port = __atcov_port();
	if ( null === $port ) {
		return false;
	}
	return ! in_array( $port, array_map( 'intval', $ports ), true );
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

// Record only the lines that ran, with OPcache on. Do not ask for the lines that
// did not run (XDEBUG_CC_UNUSED): with OPcache on, Xdebug does not report all of them,
// and OPcache off made each request about 2.2 times slower (measured 21 Nov 2026).
// coverage/analyze.py counts the lines that can run without the site.
// The tracker's coverage ini turns off the OPcache optimizer, which can merge or remove lines.
// Other sites (for example a Local WP site) can have the optimizer on: there, turn OPcache off for
// this request, as before. (The value can be hex, such as 0x7FFEBFFF: intval with base 0 reads it.)
if ( 0 !== intval( (string) ini_get( 'opcache.optimization_level' ), 0 ) ) {
	ini_set( 'opcache.enable', '0' );
}
xdebug_set_filter( XDEBUG_FILTER_CODE_COVERAGE, XDEBUG_PATH_INCLUDE, array_keys( $GLOBALS['__atcov']['roots'] ) );
xdebug_start_code_coverage();

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

	// Lines by plugin: name => { files: { path => lines that ran } }.
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
		$hit = array();
		foreach ( $lines as $line => $count ) {
			if ( $count > 0 ) {
				$hit[] = $line;
			}
		}
		if ( $hit ) {
			$plugins[ $name ]['files'][ $rel ] = $hit;
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
		// The site of the request: in a run with more workers, each worker has its own site.
		'port'    => __atcov_port(),
		'test_id' => isset( $_SERVER['HTTP_X_COVERAGE_ID'] ) ? $_SERVER['HTTP_X_COVERAGE_ID'] : null,
		// admin-ajax.php requests name their job in "action" (for example "heartbeat").
		'action'  => isset( $_REQUEST['action'] ) && is_string( $_REQUEST['action'] ) ? $_REQUEST['action'] : null,
		// "baseline" marks plain page loads that test nothing (coverage/baseline.sh).
		'kind'    => isset( $_SERVER['HTTP_X_COVERAGE_KIND'] ) ? $_SERVER['HTTP_X_COVERAGE_KIND'] : null,
		'plugins' => $plugins,
	);

	// All PHP threads of the FrankenPHP server share one process ID, and with more test sites two
	// requests can start in the same microsecond. A random part keeps the names apart. Write to a
	// temp name first, so that a reader never sees half a file.
	$name = sprintf( '%.6f-%d-%s.json', $cfg['start'], getmypid(), bin2hex( random_bytes( 4 ) ) );
	$path = $cfg['out_dir'] . '/' . $name;
	if ( false !== @file_put_contents( $path . '.tmp', json_encode( $record ) ) ) {
		@rename( $path . '.tmp', $path );
	}
}
