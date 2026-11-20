/**
 * The source of one test: the whole test file, and the first and last line of the test.
 * Playwright: the test( call. Cypress: the scenario of the .feature file.
 */
import fs from 'node:fs';
import { db } from './db.ts';
import { repoFile, testRepoPath, type Framework, type ProjectConfig } from './projects.ts';

/** Null when the test or its file is unknown. */
export function testSource(p: ProjectConfig, id: string) {
  const t = db.prepare('SELECT id, framework, file, line FROM tests WHERE project_id = ? AND id = ?').get(p.id, id) as any;
  if (!t) return null;
  const framework = t.framework as Framework;
  const repoPath = testRepoPath(p, framework, t.file);
  const full = repoFile(p, repoPath);
  if (!full || !fs.existsSync(full)) return null;
  const source = fs.readFileSync(full, 'utf8');
  const lines = source.split(/\r?\n/);
  const start: number = t.line;
  const end = framework === 'cypress' ? scenarioEnd(lines, start) : callEnd(source, start);
  return { id: t.id as string, framework, file: t.file as string, repoPath, source, start, end };
}

/** After these characters, a "/" starts a regex: /\(/ is text, not an open bracket. */
const REGEX_BEFORE = '(,=:[!&|?{};+-*%<>~^';

/**
 * Index of the "/" that closes the regex that starts at i, or -1 when it does not close on its line
 * (then the "/" is a division). A "/" in a [...] class or after a "\\" does not close it.
 */
function regexClose(source: string, i: number): number {
  let inClass = false;
  for (let k = i + 1; k < source.length; k++) {
    const c = source[k];
    if (c === '\n') return -1;
    if (c === '\\') k++;
    else if (c === '[') inClass = true;
    else if (c === ']') inClass = false;
    else if (c === '/' && !inClass) return k;
  }
  return -1;
}

/**
 * Last line of the call that starts on line start (1-based): the line of the ")" that closes the first "(".
 * Strings, template texts, regex texts and comments do not count. Good enough for a test( call. Unclosed: the last line.
 */
function callEnd(source: string, start: number): number {
  let line = 1;
  let i = 0;
  for (; i < source.length && line < start; i++) if (source[i] === '\n') line++;
  // Stack of open things: "(" "{" "[" in code, "`" for a template text, "${" for code inside a template.
  const stack: string[] = [];
  let opened = false;
  // The last code character that is not a space. After one of these, a "/" starts a regex, not a division.
  let prev = '(';
  for (; i < source.length; i++) {
    const c = source[i];
    const top = stack[stack.length - 1];
    if (c === '\n') line++;
    if (top !== '`' && !/\s/.test(c) && !(c === '/' && (source[i + 1] === '/' || source[i + 1] === '*'))) {
      const was = prev;
      prev = c;
      if (c === '/' && REGEX_BEFORE.includes(was)) {
        const close = regexClose(source, i);
        if (close > 0) {
          i = close;
          prev = '/';
          continue;
        }
      }
    }
    if (top === '`') {
      if (c === '\\') {
        if (source[i + 1] === '\n') line++;
        i++;
      } else if (c === '`') stack.pop();
      else if (c === '$' && source[i + 1] === '{') {
        stack.push('${');
        i++;
      }
      continue;
    }
    if (c === '/' && source[i + 1] === '/') {
      while (i < source.length && source[i] !== '\n') i++;
      i--; // the newline counts on the next step
      continue;
    }
    if (c === '/' && source[i + 1] === '*') {
      const close = source.indexOf('*/', i + 2);
      const stop = close < 0 ? source.length : close + 2;
      for (let k = i; k < stop; k++) if (source[k] === '\n') line++;
      i = stop - 1;
      continue;
    }
    if (c === '"' || c === "'") {
      // A quote that does not close on its line (for example in a regex: /Don't/) is not a string.
      // Then the scan goes on right after it, so the brackets behind it still count.
      const open = i;
      let breaks = 0;
      for (i++; i < source.length && source[i] !== c && source[i] !== '\n'; i++) {
        if (source[i] !== '\\') continue;
        if (source[i + 1] === '\n') breaks++;
        i++;
      }
      if (source[i] === c) line += breaks;
      else i = open;
      continue;
    }
    if (c === '`') stack.push('`');
    else if (c === '(' || c === '[' || c === '{') {
      stack.push(c);
      opened = true;
    } else if (c === ')' || c === ']' || c === '}') {
      stack.pop();
      if (opened && stack.length === 0) return line;
    }
  }
  return line;
}

const GHERKIN_BLOCK = /^(Scenario|Scenario Outline|Scenario Template|Example|Rule|Examples)\s*:/;
const OUTLINE = /^(Scenario Outline|Scenario Template)\s*:/;

/**
 * Last line of the scenario that starts on line start (1-based): the line before the next Scenario,
 * Scenario Outline, Rule or Examples keyword at the same or a lower indent, or the end of the file.
 * An outline keeps its own Examples tables, also at the same indent as the outline.
 * Blank lines, comments and tags at the end belong to the next block, so they are left out.
 */
function scenarioEnd(lines: string[], start: number): number {
  const indent = (s: string) => s.length - s.trimStart().length;
  const own = indent(lines[start - 1] ?? '');
  const outline = OUTLINE.test((lines[start - 1] ?? '').trim());
  let end = lines.length;
  for (let n = start + 1; n <= lines.length; n++) {
    const l = lines[n - 1];
    const t = l.trim();
    if (outline && /^Examples\s*:/.test(t)) continue;
    if (GHERKIN_BLOCK.test(t) && indent(l) <= own) {
      end = n - 1;
      break;
    }
  }
  while (end > start && /^(|#.*|@.*)$/.test(lines[end - 1].trim())) end--;
  return end;
}
