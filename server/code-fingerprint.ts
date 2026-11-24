/**
 * Content fingerprints of plugin code: a short hash of the text of one function, of the code outside
 * all functions of a file, or of a whole file. The feature list keeps the fingerprint of each code
 * entry and each decision when the AI or a person sets it. After a sync, an entry whose fingerprint
 * is not the same now is "to check": the AI looks at it again (server/map.ts nextCode).
 *
 * The fingerprint comes from the file text, not from the line numbers of a coverage run. So code that
 * only moved (a line added above it) keeps its fingerprint, also when no new coverage run exists.
 * White space is left out, so a change of indent only is not a change.
 *
 * Names are the coverage names: "Class::method", "function_name", or "Class::{closure}" (all the
 * anonymous functions of the file together, as the coverage report puts them under one name).
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import { repoFile, type ProjectConfig } from './projects.ts';

export interface PhpBlock {
  /** The function name, or "" for an anonymous function. */
  name: string;
  /** The class, trait, interface or enum that holds the function, or "" (none, or an anonymous class). */
  cls: string;
  /** Character offsets: from the "function" keyword to the closing brace (or ";" for an abstract method). */
  start: number;
  end: number;
}

const ID = /[A-Za-z_\x80-￿][A-Za-z0-9_\x80-￿]*/y;

/**
 * The function blocks of a PHP file. A small scanner: it knows PHP and HTML parts, strings, comments
 * and heredocs, so a brace or a quote in them does not count. Nested functions are found too.
 */
export function phpBlocks(src: string): PhpBlock[] {
  const blocks: PhpBlock[] = [];
  const open: { name: string; start: number; depth: number; cls: string }[] = [];
  // The classes (also traits, interfaces, enums) that are open now, with the depth of their "{".
  const classes: { name: string; depth: number }[] = [];
  let pendingClass: string | null = null;
  const cls = () => classes[classes.length - 1]?.name ?? '';
  let depth = 0;
  let php = false;
  let i = 0;
  // A function keyword that waits for its "{" (or ";" when it has no body).
  let pending: { name: string; start: number } | null = null;
  const n = src.length;
  while (i < n) {
    if (!php) {
      const at = src.indexOf('<?', i);
      if (at < 0) break;
      i = src.startsWith('<?php', at) ? at + 5 : src.startsWith('<?=', at) ? at + 3 : at + 2;
      php = true;
      continue;
    }
    const c = src[i];
    if (c === '?' && src[i + 1] === '>') {
      php = false;
      i += 2;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      const e = src.indexOf('*/', i + 2);
      i = e < 0 ? n : e + 2;
      continue;
    }
    if ((c === '/' && src[i + 1] === '/') || (c === '#' && src[i + 1] !== '[')) {
      // A line comment ends at the line end or at "?>".
      while (i < n && src[i] !== '\n' && !(src[i] === '?' && src[i + 1] === '>')) i++;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      i++;
      while (i < n && src[i] !== c) i += src[i] === '\\' ? 2 : 1;
      i++;
      continue;
    }
    if (c === '<' && src.startsWith('<<<', i)) {
      const m = /^<<<[ \t]*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1\r?\n/.exec(src.slice(i, i + 200));
      if (m) {
        const end = new RegExp(`\\n[ \\t]*${m[2]}\\b`, 'g');
        end.lastIndex = i + m[0].length - 1;
        const e = end.exec(src);
        i = e ? e.index + e[0].length : n;
        continue;
      }
    }
    if (c === '{') {
      depth++;
      if (pending) {
        open.push({ ...pending, depth, cls: cls() });
        pending = null;
      } else if (pendingClass !== null) {
        classes.push({ name: pendingClass, depth });
        pendingClass = null;
      }
      i++;
      continue;
    }
    if (c === '}') {
      const top = open[open.length - 1];
      if (top && top.depth === depth) {
        open.pop();
        blocks.push({ name: top.name, cls: top.cls, start: top.start, end: i + 1 });
      }
      if (classes[classes.length - 1]?.depth === depth) classes.pop();
      depth = Math.max(0, depth - 1);
      i++;
      continue;
    }
    if (c === ';' && pending) {
      // An abstract or interface method: no body.
      blocks.push({ name: pending.name, cls: cls(), start: pending.start, end: i + 1 });
      pending = null;
      i++;
      continue;
    }
    if (/[A-Za-z_]/.test(c) && !/[A-Za-z0-9_$\\>:]/.test(src[i - 1] ?? ' ')) {
      ID.lastIndex = i;
      const m = ID.exec(src);
      const word = m ? m[0] : c;
      if (word.toLowerCase() === 'function') {
        let j = i + word.length;
        while (j < n && /\s|&/.test(src[j])) j++;
        ID.lastIndex = j;
        const name = src[j] === '(' ? '' : (ID.exec(src)?.[0] ?? '');
        pending = { name, start: i };
      } else if (/^(class|trait|interface|enum)$/i.test(word)) {
        // "new class(...)" or "new class {": an anonymous class, with no name.
        let j = i + word.length;
        while (j < n && /\s/.test(src[j])) j++;
        ID.lastIndex = j;
        const name = ID.exec(src)?.[0] ?? '';
        pendingClass = /^(extends|implements)$/i.test(name) ? '' : name;
      }
      i += word.length;
      continue;
    }
    i++;
  }
  return blocks.sort((a, b) => a.start - b.start);
}

const hash = (parts: string[]) => crypto.createHash('sha1').update(parts.map((p) => p.replace(/\s+/g, '')).join('\u0000')).digest('hex').slice(0, 16);

/**
 * The fingerprint of one piece of a file's text:
 *  - fn "Class::method" or "name": the blocks with that name (an entry by name holds all of them).
 *  - fn "Class::{closure}": all anonymous functions of the file.
 *  - fn "" and part "loose": the text outside all functions (class lines, properties, template HTML).
 *  - fn "" and part "file": the whole file.
 * Null: the function is not in the text now.
 */
export function fingerprintOf(src: string, fn: string, part: 'loose' | 'file' = 'loose'): string | null {
  if (!fn) {
    if (part === 'file') return hash([src]);
    const blocks = phpBlocks(src);
    const keep: string[] = [];
    let at = 0;
    // Outer blocks only: an inner block is inside an outer one, so it is cut with it.
    for (const b of blocks) {
      if (b.start < at) continue;
      keep.push(src.slice(at, b.start));
      at = b.end;
    }
    keep.push(src.slice(at));
    return hash(keep);
  }
  const at = fn.lastIndexOf('::');
  const short = at < 0 ? fn : fn.slice(at + 2);
  // The class without its namespace ("Ns\\Foo::bar" is in "class Foo"). "" for a function outside classes.
  const owner = at < 0 ? '' : fn.slice(0, at).split('\\').pop()!.toLowerCase();
  const want = short === '{closure}' ? '' : short.toLowerCase();
  const byName = phpBlocks(src).filter((b) => b.name.toLowerCase() === want);
  // The blocks of the same class only, so "A::render" does not change when "B::render" changes. When the
  // class does not match (a name that the scan does not know, for example an anonymous class), all
  // blocks with the name.
  const inClass = byName.filter((b) => b.cls.toLowerCase() === owner);
  const found = inClass.length ? inClass : byName;
  if (!found.length) return null;
  return hash(found.map((b) => src.slice(b.start, b.end)));
}

const fileCache = new Map<string, { mtime: number; src: string }>();

/** The text of a repo file now (any kind: PHP, Vue, CSS), or null when it is gone. Cached by modification time. */
export function repoSource(p: ProjectConfig, file: string): string | null {
  const full = repoFile(p, file);
  if (!full) return null;
  try {
    const mtime = fs.statSync(full).mtimeMs;
    const hit = fileCache.get(full);
    if (hit && hit.mtime === mtime) return hit.src;
    const src = fs.readFileSync(full, 'utf8');
    fileCache.set(full, { mtime, src });
    return src;
  } catch {
    return null;
  }
}

/** The fingerprint of a code entry or decision now. Null: the file or function is gone. */
export function currentFingerprint(p: ProjectConfig, file: string, fn: string, part: 'loose' | 'file'): string | null {
  const src = repoSource(p, file);
  return src === null ? null : fingerprintOf(src, fn, part);
}
