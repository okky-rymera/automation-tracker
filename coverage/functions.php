<?php
/**
 * Lists every function and method in a plugin with its line range.
 *
 * Usage: php functions.php <plugin-dir> [comma-separated folder names to skip]
 * The folder list must be the same as the app's file list (coverage/exclude-dirs.json).
 * Output: JSON { "relative/file.php": [ { "name", "class", "start", "end" } ] }
 */

$root  = rtrim( $argv[1], '/' ) . '/';
$out   = array();
$dirs  = isset( $argv[2] ) ? explode( ',', $argv[2] ) : json_decode( file_get_contents( __DIR__ . '/exclude-dirs.json' ), true );
$skip  = '#/(\.[^/]*|' . implode( '|', array_map( fn( $d ) => preg_quote( $d, '#' ), $dirs ) ) . ')/#';
$iter  = new RecursiveIteratorIterator( new RecursiveDirectoryIterator( $root, FilesystemIterator::SKIP_DOTS ) );

foreach ( $iter as $file ) {
	$path = $file->getPathname();
	if ( substr( $path, -4 ) !== '.php' || preg_match( $skip, '/' . substr( $path, strlen( $root ) ) ) ) {
		continue;
	}
	$rel    = substr( $path, strlen( $root ) );
	$tokens = PhpToken::tokenize( file_get_contents( $path ) );
	$funcs  = array();
	$depth  = 0;
	$classes = array();  // open classes: [ name, depth at which the class body opened ]
	$want   = null;      // pending: 'class' or 'function' waiting for its "{"
	$pname  = null;
	$stack  = array();   // open functions: [ name, class, start, depth ]

	$n = count( $tokens );
	for ( $i = 0; $i < $n; $i++ ) {
		$t = $tokens[ $i ];
		if ( $t->is( array( T_CLASS, T_TRAIT, T_INTERFACE, T_ENUM ) ) ) {
			// Skip "::class" and "new class".
			$prev = $i - 1;
			while ( $prev >= 0 && $tokens[ $prev ]->isIgnorable() ) {
				$prev--;
			}
			if ( $prev >= 0 && ( $tokens[ $prev ]->is( T_DOUBLE_COLON ) ) ) {
				continue;
			}
			$j = $i + 1;
			while ( $j < $n && $tokens[ $j ]->isIgnorable() ) {
				$j++;
			}
			$want  = 'class';
			$pname = ( $j < $n && $tokens[ $j ]->is( T_STRING ) ) ? $tokens[ $j ]->text : '{anonymous}';
		} elseif ( $t->is( T_FUNCTION ) ) {
			$j = $i + 1;
			while ( $j < $n && ( $tokens[ $j ]->isIgnorable() || $tokens[ $j ]->text === '&' ) ) {
				$j++;
			}
			$want  = 'function';
			$pname = ( $j < $n && $tokens[ $j ]->is( T_STRING ) ) ? $tokens[ $j ]->text : '{closure}';
			$pline = $t->line;
		} elseif ( $t->text === ';' && 'function' === $want ) {
			$want = null; // abstract or interface method: no body.
		} elseif ( $t->text === '{' || $t->is( array( T_CURLY_OPEN, T_DOLLAR_OPEN_CURLY_BRACES ) ) ) {
			$depth++;
			if ( 'class' === $want && $t->text === '{' ) {
				$classes[] = array( $pname, $depth );
				$want      = null;
			} elseif ( 'function' === $want && $t->text === '{' ) {
				$stack[] = array( $pname, $classes ? end( $classes )[0] : null, $pline, $depth );
				$want    = null;
			}
		} elseif ( $t->text === '}' ) {
			if ( $stack && end( $stack )[3] === $depth ) {
				$f       = array_pop( $stack );
				$funcs[] = array( 'name' => $f[0], 'class' => $f[1], 'start' => $f[2], 'end' => $t->line );
			} elseif ( $classes && end( $classes )[1] === $depth ) {
				array_pop( $classes );
			}
			$depth--;
		}
	}
	$out[ $rel ] = $funcs;
}

echo json_encode( $out );
