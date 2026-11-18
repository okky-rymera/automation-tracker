<?php
/**
 * Prints the runnable lines of one PHP file without running its code.
 *
 * Usage (needs Xdebug): php -d xdebug.mode=coverage runnable-lines.php <file>
 * Output: JSON list of line numbers, or {"error": "..."}.
 *
 * How: the file source gets a stop check in front of its first statement, on the
 * same line, so line numbers do not move. PHP compiles the whole file, Xdebug
 * marks every runnable line, and the code stops at the return.
 */

// A plain "return;" makes the code after it unreachable, and Xdebug then marks
// it as dead code (-2). This check stops at runtime, but the compiler cannot
// know that, so the lines after it stay runnable (-1).
const STOP = 'if ( ! isset( $__atcov_run ) ) { return; }';

$file = $argv[1];
$src  = file_get_contents( $file );

// "declare" and "namespace" must stay the first statements, so put the stop
// check after them. Find them with the tokenizer (comments may come first).
// strict_types must be the very first statement, which the wrapper breaks. It does
// not change which lines can run, so blank it out (same length, same lines).
$src = preg_replace_callback(
	'/declare\s*\(\s*strict_types\s*=\s*[01]\s*\)\s*;/i',
	function ( $m ) {
		return preg_replace( '/[^\n]/', ' ', $m[0] );
	},
	$src
);

$insert_at = null;
$tokens    = PhpToken::tokenize( $src );
$count     = count( $tokens );
for ( $i = 0; $i < $count; $i++ ) {
	$t = $tokens[ $i ];
	if ( $t->is( array( T_OPEN_TAG, T_WHITESPACE, T_COMMENT, T_DOC_COMMENT ) ) ) {
		continue;
	}
	if ( $t->is( T_DECLARE ) ) {
		// Skip to the end of "declare(...);".
		while ( $i < $count && ';' !== $tokens[ $i ]->text ) {
			$i++;
		}
		$insert_at = $tokens[ $i ]->pos + 1;
		continue;
	}
	if ( $t->is( T_NAMESPACE ) ) {
		$j = $i + 1;
		while ( $j < $count && $tokens[ $j ]->isIgnorable() ) {
			$j++;
		}
		// "namespace\foo()" is a name, not a declaration.
		if ( $j < $count && ( '(' === $tokens[ $j ]->text || $tokens[ $j ]->is( T_NS_SEPARATOR ) ) ) {
			break;
		}
		// "namespace Foo;" or "namespace Foo {": insert after the ";" or "{".
		while ( $j < $count && ';' !== $tokens[ $j ]->text && '{' !== $tokens[ $j ]->text ) {
			$j++;
		}
		if ( $j < $count ) {
			$insert_at = $tokens[ $j ]->pos + 1;
		}
	}
	break;
}

if ( null !== $insert_at ) {
	// The stop check goes on the same line, so line numbers do not move.
	$code = '?>' . substr( $src, 0, $insert_at ) . ' ' . STOP . ' ' . substr( $src, $insert_at );
} else {
	$code = STOP . ' ?>' . $src;
}

xdebug_start_code_coverage( XDEBUG_CC_UNUSED | XDEBUG_CC_DEAD_CODE );
try {
	eval( $code );
} catch ( Throwable $e ) {
	echo json_encode( array( 'error' => $e->getMessage() ) );
	exit( 0 );
}
$cov = xdebug_get_code_coverage();
xdebug_stop_code_coverage();

$lines = array();
foreach ( $cov as $name => $data ) {
	if ( false === strpos( $name, "eval()'d code" ) ) {
		continue;
	}
	foreach ( $data as $line => $count ) {
		// -1 = runnable, not run. Line of the inserted return ran (1); skip it
		// unless the original line also holds code that Xdebug marks again.
		if ( -1 === $count ) {
			$lines[] = $line;
		}
	}
}
sort( $lines );
echo json_encode( array_values( array_unique( $lines ) ) );
