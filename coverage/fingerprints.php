<?php
/**
 * Gives a fingerprint to each function of some PHP files, and to the code outside functions.
 *
 * Usage: php fingerprints.php <root> <relative file> [<relative file> ...]
 * Output: JSON { "file": { "top", "topStatements", "functions": [ { "key", "name", "start", "end", "hash", "statements" } ] } }
 *   A file that does not exist or cannot be read gets null.
 *
 * The fingerprint leaves out comments and white space, so a change to a comment or to the
 * layout does not count as a code change. A closure's key names its outer function and its
 * number in it ("A::g/{closure}#2"), so a new closure in another function does not change it.
 * Two named functions with the same name in one file (declared in two if-branches) get "#2".
 * The names are the same as in report.json from analyze.py: "Class::name" or "name".
 * "top" covers all code outside the functions (class lines, properties, hooks at file level).
 */

$root = rtrim( $argv[1], '/' ) . '/';
$out  = array();

foreach ( array_slice( $argv, 2 ) as $rel ) {
	$src = @file_get_contents( $root . $rel );
	if ( false === $src ) {
		$out[ $rel ] = null;
		continue;
	}
	try {
		$tokens = PhpToken::tokenize( $src, TOKEN_PARSE );
	} catch ( Throwable $e ) {
		$tokens = PhpToken::tokenize( $src ); // a parse error: still split the tokens
	}

	$funcs   = array();
	$classes = array();  // open classes: [ name, depth ]
	$stack   = array();  // open functions: [ name, class, start line, depth, token texts, key, closures in it ]
	$tops    = 0;        // closures outside any function
	$top     = array();  // token texts outside functions
	$depth   = 0;
	$want    = null;
	$pname   = null;
	$pline   = 0;
	$pending = array();  // tokens of a function head ("function name(...)") before its "{"
	$mods    = array();  // "public", "static" and the like, until the next token shows their owner
	$n       = count( $tokens );

	for ( $i = 0; $i < $n; $i++ ) {
		$t = $tokens[ $i ];
		$keep = ! $t->is( array( T_WHITESPACE, T_COMMENT, T_DOC_COMMENT, T_OPEN_TAG, T_CLOSE_TAG ) );

		if ( $t->is( array( T_CLASS, T_TRAIT, T_INTERFACE, T_ENUM ) ) ) {
			$prev = $i - 1;
			while ( $prev >= 0 && $tokens[ $prev ]->isIgnorable() ) {
				$prev--;
			}
			if ( ! ( $prev >= 0 && $tokens[ $prev ]->is( T_DOUBLE_COLON ) ) ) {
				$j = $i + 1;
				while ( $j < $n && $tokens[ $j ]->isIgnorable() ) {
					$j++;
				}
				$want  = 'class';
				$pname = ( $j < $n && $tokens[ $j ]->is( T_STRING ) ) ? $tokens[ $j ]->text : '{anonymous}';
			}
		} elseif ( $t->is( T_FUNCTION ) ) {
			$j = $i + 1;
			while ( $j < $n && ( $tokens[ $j ]->isIgnorable() || '&' === $tokens[ $j ]->text ) ) {
				$j++;
			}
			$want    = 'function';
			$pname   = ( $j < $n && $tokens[ $j ]->is( T_STRING ) ) ? $tokens[ $j ]->text : '{closure}';
			$pline   = $t->line;
			$pending = array();
		} elseif ( ';' === $t->text && 'function' === $want ) {
			$want = null; // abstract or interface method: no body. Its head stays in "top".
			if ( $stack ) {
				end( $stack );
				$stack[ key( $stack ) ][4] = array_merge( $stack[ key( $stack ) ][4], $pending );
			} else {
				$top = array_merge( $top, $pending );
			}
			$pending = array();
		}

		if ( '{' === $t->text || $t->is( array( T_CURLY_OPEN, T_DOLLAR_OPEN_CURLY_BRACES ) ) ) {
			$depth++;
			if ( 'class' === $want && '{' === $t->text ) {
				$classes[] = array( $pname, $depth );
				$want      = null;
			} elseif ( 'function' === $want && '{' === $t->text ) {
				$cls = $classes ? end( $classes )[0] : null;
				if ( '{closure}' === $pname ) {
					// A closure is numbered inside its outer function, so a new closure elsewhere in the
					// file does not change its key: "A::g/{closure}#1". Outside functions: "A::{closure}#1".
					if ( $stack ) {
						$last = array_key_last( $stack );
						$stack[ $last ][6]++;
						$key = $stack[ $last ][5] . '/{closure}#' . $stack[ $last ][6];
					} else {
						$tops++;
						$key = ( $cls ? $cls . '::' : '' ) . '{closure}#' . $tops;
					}
				} else {
					$key = null; // a named function: its key is its name (numbered at the end when it repeats)
				}
				$stack[] = array( $pname, $cls, $pline, $depth, array_merge( $pending, array( '{' ) ), $key ?? ( ( $cls ? $cls . '::' : '' ) . $pname ), 0, null !== $key );
				$want    = null;
				$pending = array();
				continue;
			}
		}

		$closes = false;
		if ( '}' === $t->text ) {
			if ( $stack && end( $stack )[3] === $depth ) {
				$closes = true;
			} elseif ( $classes && end( $classes )[1] === $depth ) {
				array_pop( $classes );
			}
		}

		// Words such as "public static" before "function" belong to that function, so an added
		// method does not change "top". Hold them until the next kept token shows where they go.
		if ( $keep && $t->is( array( T_PUBLIC, T_PROTECTED, T_PRIVATE, T_STATIC, T_ABSTRACT, T_FINAL ) ) && 'function' !== $want ) {
			$mods[] = $t->text;
			continue;
		}
		if ( $keep && $mods ) {
			if ( $t->is( T_FUNCTION ) ) {
				$pending = array_merge( $mods, $pending );
			} elseif ( $stack ) {
				end( $stack );
				$stack[ key( $stack ) ][4] = array_merge( $stack[ key( $stack ) ][4], $mods );
			} else {
				$top = array_merge( $top, $mods );
			}
			$mods = array();
		}

		if ( $keep ) {
			if ( 'function' === $want ) {
				$pending[] = $t->text; // head of a function: belongs to the function
			} elseif ( $stack ) {
				end( $stack );
				$stack[ key( $stack ) ][4][] = $t->text;
			} else {
				$top[] = $t->text;
			}
		}

		if ( $closes ) {
			$f    = array_pop( $stack );
			$name = ( $f[1] ? $f[1] . '::' : '' ) . $f[0];
			$hash = substr( sha1( implode( ' ', $f[4] ) ), 0, 16 );
			// A closure in a function also changes the outer function: add its hash there.
			// A function at the top level does not change "top": an added or removed
			// function is reported by its own key.
			if ( $stack ) {
				end( $stack );
				$stack[ key( $stack ) ][4][] = '{fn:' . $hash . '}';
			}
			$funcs[] = array( 'name' => $name, 'start' => $f[2], 'end' => $t->line, 'hash' => $hash, 'statements' => statements( $f[4] ), 'key' => $f[7] ? $f[5] : null );
		}
		if ( '}' === $t->text ) {
			$depth--;
		}
	}

	// Keys of named functions: the name, plus "#2", "#3" for the next functions with the same
	// name (in line order), for example a function declared in two if-branches. Closures have their key.
	usort( $funcs, fn( $a, $b ) => $a['start'] <=> $b['start'] );
	$seen = array();
	foreach ( $funcs as &$f ) {
		if ( null !== $f['key'] ) {
			continue;
		}
		$seen[ $f['name'] ] = ( $seen[ $f['name'] ] ?? 0 ) + 1;
		$f['key']           = $f['name'] . ( $seen[ $f['name'] ] > 1 ? '#' . $seen[ $f['name'] ] : '' );
	}
	unset( $f );

	$out[ $rel ] = array(
		'top'           => substr( sha1( implode( ' ', $top ) ), 0, 16 ),
		'topStatements' => statements( $top ),
		'functions'     => $funcs,
	);
}

/**
 * Cuts token texts into statements (at ";", "{" and "}") and gives one hash to each.
 * The last character of each item is the end of the statement (";", "{", "}" or "."
 * for the rest). Then a caller can tell added statements (a new constant, a new
 * add_action line) from changed or removed ones, and simple lines from new blocks.
 */
function statements( array $texts ): array {
	$out = array();
	$cur = array();
	foreach ( $texts as $text ) {
		$cur[] = $text;
		if ( ';' === $text || '{' === $text || '}' === $text ) {
			$out[] = substr( sha1( implode( ' ', $cur ) ), 0, 12 ) . $text;
			$cur   = array();
		}
	}
	if ( $cur ) {
		$out[] = substr( sha1( implode( ' ', $cur ) ), 0, 12 ) . '.';
	}
	return $out;
}

echo json_encode( $out );
