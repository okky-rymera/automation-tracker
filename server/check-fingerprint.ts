/**
 * Checks the code fingerprints (server/code-fingerprint.ts) on small PHP texts, then (with a project ID)
 * that each function of the project's coverage run is found by name in its file.
 *
 *   npm run -s check-fingerprint [<project>]
 *
 * Exit code 1 when a check fails.
 */
import { fingerprintOf, phpBlocks, repoSource } from './code-fingerprint.ts';

const a = [
  '<?php',
  "if ( ! defined( 'ABSPATH' ) ) { exit; }",
  'class A {',
  '  public function foo( $x ) {',
  '    $s = "a } b"; // } brace',
  "    return function () { return '{'; };",
  '  }',
  '  abstract function bar();',
  '  function baz() { /* } */ return <<<EOT',
  '}}}',
  'EOT;',
  '  }',
  '}',
  "?><p>Don't { stop</p><?php function tail() { return 1; }",
].join('\n');
const moved = a.replace('class A {', '\n\n// a new comment line\nclass A {');
const edited = a.replace('return 1;', 'return 2;');

let failed = 0;
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${what}`);
  if (!ok) failed++;
};
const names = phpBlocks(a).map((b) => b.name || '(anonymous)');
check(names.join(',') === 'foo,(anonymous),bar,baz,tail', `finds the functions, not braces in strings, comments, heredocs or HTML (${names.join(', ')})`);
check(fingerprintOf(a, 'A::foo') === fingerprintOf(moved, 'A::foo'), 'a function that only moved keeps its fingerprint');
check(fingerprintOf(a, 'tail') !== fingerprintOf(edited, 'tail'), 'an edited function gets a new fingerprint');
check(fingerprintOf(a, 'A::foo') === fingerprintOf(edited, 'A::foo'), 'an edit of one function does not change another');
check(fingerprintOf(a, '') === fingerprintOf(edited, ''), 'an edit in a function does not change the code outside functions');
check(fingerprintOf(a, '') !== fingerprintOf(moved, ''), 'an edit outside functions changes the code outside functions');
check(fingerprintOf(a, '', 'file') !== fingerprintOf(edited, '', 'file'), 'any edit changes the whole-file fingerprint');
check(fingerprintOf(a, 'A::{closure}') !== null, 'finds the closures of a class');
check(fingerprintOf(a, 'A::nope') === null, 'a missing function has no fingerprint');
check(fingerprintOf(a.replace('    return', '\t\treturn'), 'A::foo') === fingerprintOf(a, 'A::foo'), 'a change of indent only is not a change');

// Two classes with a method of the same name: an edit of one does not change the other.
const two = ['<?php', 'class A { function render() { return 1; } }', 'class B { function render() { return 2; } }', 'function render() { return 3; }'].join('\n');
const twoEdited = two.replace('return 2;', 'return 22;');
check(fingerprintOf(two, 'A::render') === fingerprintOf(twoEdited, 'A::render'), 'an edit of B::render does not change A::render');
check(fingerprintOf(two, 'B::render') !== fingerprintOf(twoEdited, 'B::render'), 'an edit of B::render changes B::render');
check(fingerprintOf(two, 'render') === fingerprintOf(twoEdited, 'render'), 'an edit of B::render does not change the function render()');
check(fingerprintOf(two, 'Ns\\A::render') === fingerprintOf(two, 'A::render'), 'a class name with a namespace finds the class');

// The automatic guard lines (coverage.ts autoLibraryLines): the guard only, never real code after it.
const { autoLibraryLines } = await import('./coverage.ts');
const guard = (lines: string[]) => autoLibraryLines(lines, lines.map((_, i) => i + 1).filter((n) => lines[n - 1] !== '<?php'), []).join(',');
check(guard(['<?php', "if ( ! defined( 'ABSPATH' ) )", '    exit;', '', "require_once 'x.php';"]) === '2,3,4', 'a guard with exit on the next line stops at exit (lines 2, 3 and the blank line 4)');
check(guard(['<?php', "if ( ! defined( 'ABSPATH' ) ) {", '    exit; // Exit if accessed directly', '}', "require_once 'x.php';"]) === '2,3,4', 'a guard with braces takes its closing brace, not the next code');
check(guard(['<?php', "defined( 'ABSPATH' ) || exit;", "require_once 'x.php';"]) === '2', 'the "|| exit" form is one line');
check(guard(['<?php', "if ( defined( 'ABSPATH' ) ) {", "    require_once 'x.php';", '}']) === '', 'a positive check that wraps real code is not a guard');
check(guard(['<?php', "if ( ! defined( 'ABSPATH' ) ) {", "    require_once 'x.php';", '    exit;', '}']) === '', 'real code before the exit: not a guard');

const projectId = process.argv[2];
if (projectId) {
  const { getProject } = await import('./projects.ts');
  const { loadCoverage, resolveView } = await import('./coverage.ts');
  const p = getProject(projectId);
  const view = p && resolveView(p, 'both');
  const cov = p && view ? loadCoverage(p, view) : null;
  if (!p || !cov) {
    console.log(`FAIL project ${projectId}: unknown, or no coverage run`);
    failed++;
  } else {
    const miss: string[] = [];
    let total = 0;
    for (const [file, fns] of cov.functionsByFile) {
      const src = repoSource(p, file);
      if (!src) continue;
      for (const f of fns) {
        total++;
        if (fingerprintOf(src, f.function) === null) miss.push(`${file} ${f.function}`);
      }
    }
    check(!miss.length, `${projectId}: ${total - miss.length} of ${total} coverage functions found by name${miss.length ? `. Not found: ${miss.slice(0, 10).join('; ')}` : ''}`);
  }
}
process.exit(failed ? 1 : 0);
