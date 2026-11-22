// main.ts is mend, the CLI the kit's SPEC.md specifies (version 1): one command-line tool that reads an edit an AI
// model wrote in any of four formats — a unified diff, SEARCH/REPLACE blocks, a V4A patch, or text-editor tool
// calls as JSON — and applies it to a tree of text files, changing every file or none. Node 22, the standard
// library alone; run it as `node main.ts [options] [PATCH]`.
//
// The reading follows SPEC.md section by section: the command line, output and exit codes (sections 1 and 2),
// files, lines and safe paths (section 3), format detection (section 4), line matching at three tiers with
// re-indentation at the loosest one (section 5), then one reader per format (sections 6 to 9) and the
// all-or-nothing order of edits (section 10). Every reader turns its patch into a list of edits against an
// in-memory tree; the tree is written out only when no edit failed.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to
// runner.ts (the last lines below): that hand-over and runner.ts stay as the kit hands them out.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

/** An exit-2 answer: the one line to print. */
class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}

/** One edit's failure: its code and the path the failure concerns. */
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

/** A patch's lines (SPEC.md section 3): split at \n, one trailing \r removed from each, no empty last piece. */
function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

/** A safe path (section 3): relative, no backslash, no empty, dot or dot-dot segment. */
function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Moves a successful edit made, in order, as [old path, new path]; rolled back with a failed edit. */
  readonly moves: Array<[string, string]> = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

/** A file held as its lines, its own line break, and whether it ends with one (section 3). */
interface FileModel {
  lines: string[];
  br: string;
  final: boolean;
}

function splitFile(text: string): FileModel {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  let final = false;
  if (text.endsWith(br)) {
    parts.pop();
    final = true;
  }
  return { lines: parts, br, final };
}

function joinFile(m: FileModel): string {
  if (m.lines.length === 0) return '';
  return m.lines.join(m.br) + (m.final ? m.br : '');
}

/** One line of a replacement: its text, and for a context line the index of the old line it pairs with. */
interface NLine {
  text: string;
  ctx: number;
}

const stripTrail = (s: string): string => s.replace(/[ \t]+$/, '');
const stripBoth = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');

function normAt(s: string, tier: number): string {
  return tier === 0 ? s : tier === 1 ? stripTrail(s) : stripBoth(s);
}

interface Occurrence {
  tier: number;
  positions: number[];
}

/**
 * Where O occurs in `lines` (section 5): the first tier at which it occurs at least once, and every position
 * there. The search starts at `from`; with `eofOnly` only an occurrence ending at the file's last line counts.
 * Null when O occurs at no tier.
 */
function findOcc(lines: string[], O: string[], strict: boolean, from: number, eofOnly: boolean): Occurrence | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const want = O.map((l) => normAt(l, tier));
    const positions: number[] = [];
    for (let i = Math.max(0, from); i + O.length <= lines.length; i += 1) {
      if (eofOnly && i + O.length !== lines.length) continue;
      let ok = true;
      for (let j = 0; j < O.length; j += 1) {
        if (normAt(lines[i + j]!, tier) !== want[j]) {
          ok = false;
          break;
        }
      }
      if (ok) positions.push(i);
    }
    if (positions.length > 0) return { tier, positions };
  }
  return null;
}

/** The first line at or after `from` equal to a single anchor line, at the first tier where one is (section 8). */
function findAnchor(lines: string[], anchor: string, strict: boolean, from: number): number {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const want = normAt(anchor, tier);
    for (let i = Math.max(0, from); i < lines.length; i += 1) {
      if (normAt(lines[i]!, tier) === want) return i;
    }
  }
  return -1;
}

/**
 * The lines a match writes (section 5): a context line is the file's own matched line; at tier 2 every other
 * line is re-indented, the leading spaces and tabs P of O's first line replaced by F, those of the file's first
 * matched line, on a line that is not empty or only whitespace and starts with P.
 */
function renderN(lines: string[], pos: number, O: string[], N: NLine[], tier: number): string[] {
  let F = '';
  let P = '';
  if (tier === 2 && O.length > 0) {
    F = /^[ \t]*/.exec(lines[pos]!)![0];
    P = /^[ \t]*/.exec(O[0]!)![0];
  }
  return N.map((e) => {
    if (e.ctx >= 0) return lines[pos + e.ctx]!;
    if (tier === 2) {
      const t = e.text;
      if (t !== '' && t.trim() !== '' && t.startsWith(P)) return F + t.slice(P.length);
    }
    return e.text;
  });
}

/** Format detection (section 4): the first of the four tests that holds, in the order the section gives. */
function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (section 9) as an edit, or null when it is not a valid one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const existing = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = existing(tree);
      const m = splitFile(before);
      const crlf = m.br === '\r\n';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = existing(tree);
      const m = splitFile(before);
      if (line < 0 || line > m.lines.length) throw new Fail('no-match', p);
      m.lines.splice(line, 0, ...add);
      tree.now.set(p, joinFile(m));
    };
  }
  return null;
}

/** The JSON reader (section 9): one array of edit objects, or JSON Lines with blank lines ignored. */
function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/** One hunk of a unified section: its stated old-line number, its old and new lines, and its `\` line facts. */
interface UHunk {
  a: number;
  O: string[];
  N: NLine[];
  plus: string[];
  /** A `\` line follows the hunk's last context or `+` line: the result then ends without a line break. */
  noNL: boolean;
  /** A `\` line follows the hunk's last `+` line (what a creation reads). */
  plusNoNL: boolean;
}

type BodyEntry = { kind: string; text: string; rawEmpty: boolean; ws: boolean };

/** A hunk from its body lines: context and `-` lines are O, context and `+` lines are N, each in body order. */
function makeHunk(a: number, body: BodyEntry[]): UHunk {
  let lastNew = -1;
  let lastPlus = -1;
  body.forEach((e, idx) => {
    if (e.kind === ' ' || e.kind === '+') lastNew = idx;
    if (e.kind === '+') lastPlus = idx;
  });
  const O: string[] = [];
  const N: NLine[] = [];
  const plus: string[] = [];
  let oi = 0;
  for (const e of body) {
    if (e.kind === ' ') {
      O.push(e.text);
      N.push({ text: e.text, ctx: oi });
      oi += 1;
    } else if (e.kind === '-') {
      O.push(e.text);
      oi += 1;
    } else if (e.kind === '+') {
      N.push({ text: e.text, ctx: -1 });
      plus.push(e.text);
    }
  }
  return {
    a,
    O,
    N,
    plus,
    noNL: lastNew >= 0 && body[lastNew + 1]?.kind === '\\',
    plusNoNL: lastPlus >= 0 && body[lastPlus + 1]?.kind === '\\',
  };
}

interface USec {
  gitOld: string | null;
  gitNew: string | null;
  minusPath: string | null;
  plusPath: string | null;
  renameFrom: string | null;
  renameTo: string | null;
  newFile: boolean;
  delFile: boolean;
  pair: boolean;
  hunks: UHunk[];
}

/** A `---` or `+++` path (section 6): up to the first tab, spaces removed, `/dev/null` kept, a/ or b/ stripped. */
function headerPath(raw: string): string {
  let p = raw.split('\t')[0]!.trim();
  if (p !== '/dev/null' && (p.startsWith('a/') || p.startsWith('b/'))) p = p.slice(2);
  return p;
}

/** The unified reader (section 6): sections and their hunks, as edits. Parse faults throw Exit2. */
function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const secs: USec[] = [];
  let cur: USec | null = null;
  const newSec = (): USec => {
    const s: USec = { gitOld: null, gitNew: null, minusPath: null, plusPath: null, renameFrom: null, renameTo: null, newFile: false, delFile: false, pair: false, hunks: [] };
    secs.push(s);
    return s;
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = /^a\/(.+?) b\/(.+)$/.exec(line.slice(11));
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      cur = newSec();
      cur.gitOld = m[1]!;
      cur.gitNew = m[2]!;
      i += 1;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur === null || cur.hunks.length > 0 || cur.pair) cur = newSec();
      cur.minusPath = headerPath(line.slice(4));
      cur.plusPath = headerPath(lines[i + 1]!.slice(4));
      cur.pair = true;
      i += 2;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const hm = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (!hm) throw new Exit2(`error: parse ${i + 1}`);
      const body: BodyEntry[] = [];
      let j = i + 1;
      while (j < lines.length) {
        const l = lines[j]!;
        if (l.startsWith('diff --git ')) break;
        if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
        if (l === '') body.push({ kind: ' ', text: '', rawEmpty: true, ws: true });
        else if (l[0] === ' ' || l[0] === '-' || l[0] === '+' || l[0] === '\\') body.push({ kind: l[0]!, text: l.slice(1), rawEmpty: false, ws: l.trim() === '' });
        else break;
        j += 1;
      }
      while (body.length > 0 && body[body.length - 1]!.rawEmpty) body.pop();
      cur.hunks.push(makeHunk(Number.parseInt(hm[1]!, 10), body));
      i = j;
      continue;
    }
    if (cur !== null && cur.hunks.length === 0) {
      // The section's header, before its first hunk: names and flags are read, everything else is ignored.
      if (line.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (line.startsWith('rename from ')) cur.renameFrom = line.slice(12);
      else if (line.startsWith('rename to ')) cur.renameTo = line.slice(10);
      else if (line.startsWith('new file mode')) cur.newFile = true;
      else if (line.startsWith('deleted file mode')) cur.delFile = true;
      i += 1;
      continue;
    }
    i += 1; // prose and anything else outside bodies and headers is ignored
  }
  return secs.map((s) => unifiedEdit(s, strict));
}

/** One unified section as one edit (section 6): a creation, a deletion, a move, or a change of one path. */
function unifiedEdit(s: USec, strict: boolean): Edit {
  const oldPath = s.minusPath ?? s.renameFrom ?? s.gitOld ?? '';
  const newPath = s.plusPath ?? s.renameTo ?? s.gitNew ?? '';
  const create = s.newFile || oldPath === '/dev/null';
  const del = s.delFile || newPath === '/dev/null';
  const hunks = s.hunks;
  if (create) {
    const p = newPath;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const ls: string[] = [];
      let noNL = false;
      for (const h of hunks) {
        ls.push(...h.plus);
        if (h.plus.length > 0) noNL = h.plusNoNL;
      }
      tree.now.set(p, ls.length === 0 ? '' : ls.join('\n') + (noNL ? '' : '\n'));
    };
  }
  if (del) {
    const p = oldPath;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
    };
  }
  const move = oldPath !== newPath;
  return (tree) => {
    if (!safe(oldPath)) throw new Fail('unsafe', oldPath);
    if (move && !safe(newPath)) throw new Fail('unsafe', newPath);
    const before = tree.get(oldPath);
    if (before === null) throw new Fail('missing', oldPath);
    if (move && tree.get(newPath) !== null) throw new Fail('exists', newPath);
    const m = splitFile(before);
    let d = 0;
    for (const h of hunks) {
      if (h.O.length === 0) {
        const pos = Math.min(Math.max(h.a + d, 0), m.lines.length);
        const atEnd = pos === m.lines.length;
        m.lines.splice(pos, 0, ...h.N.map((e) => e.text));
        if (atEnd) m.final = !h.noNL;
        d += h.N.length;
      } else {
        const occ = findOcc(m.lines, h.O, strict, 0, false);
        if (occ === null) throw new Fail('no-match', oldPath);
        const target = h.a - 1 + d;
        let pos = occ.positions[0]!;
        let best = Math.abs(pos - target);
        for (const p of occ.positions) {
          const dd = Math.abs(p - target);
          if (dd < best) {
            best = dd;
            pos = p;
          }
        }
        const toEnd = pos + h.O.length === m.lines.length;
        const rendered = renderN(m.lines, pos, h.O, h.N, occ.tier);
        m.lines.splice(pos, h.O.length, ...rendered);
        if (toEnd) m.final = !h.noNL;
        d += h.N.length - h.O.length;
      }
    }
    const out = joinFile(m);
    if (move) {
      tree.now.set(oldPath, null);
      tree.now.set(newPath, out);
      tree.moves.push([oldPath, newPath]);
    } else {
      tree.now.set(oldPath, out);
    }
  };
}

/** The SEARCH/REPLACE reader (section 7): blocks in order, each block one edit. Parse faults throw Exit2. */
function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = 0;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const at = i;
    let eq = -1;
    let gt = -1;
    for (let j = i + 1; j < lines.length; j += 1) {
      const t = lines[j]!.trimEnd();
      if (eq < 0 && t === '>>>>>>> REPLACE') break;
      if (eq < 0 && t === '=======') {
        eq = j;
        continue;
      }
      if (eq >= 0 && t === '>>>>>>> REPLACE') {
        gt = j;
        break;
      }
    }
    if (eq < 0 || gt < 0) throw new Exit2(`error: parse ${at + 1}`);
    let path: string | null = null;
    for (let j = at - 1; j >= prevEnd; j -= 1) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${at + 1}`);
    edits.push(searchReplaceEdit(path, lines.slice(at + 1, eq), lines.slice(eq + 1, gt), strict));
    prevPath = path;
    prevEnd = gt + 1;
    i = gt + 1;
  }
  return edits;
}

/** One SEARCH/REPLACE block as one edit (section 7): empty old lines create the file; otherwise one match. */
function searchReplaceEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : `${newLines.join('\n')}\n`);
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const m = splitFile(before);
    const occ = findOcc(m.lines, oldLines, strict, 0, false);
    if (occ === null) throw new Fail('no-match', path);
    if (occ.positions.length > 1) throw new Fail('ambiguous', path);
    const pos = occ.positions[0]!;
    const rendered = renderN(m.lines, pos, oldLines, newLines.map((t) => ({ text: t, ctx: -1 })), occ.tier);
    m.lines.splice(pos, oldLines.length, ...rendered);
    tree.now.set(path, joinFile(m));
  };
}

/** One V4A chunk: its anchor (null: none), whether `*** End of File` ended it, and its old and new lines. */
interface VChunk {
  anchor: string | null;
  eof: boolean;
  O: string[];
  N: NLine[];
}

interface VSec {
  kind: 'add' | 'del' | 'upd';
  path: string;
  lineNo: number;
  add: Array<{ text: string; rawEmpty: boolean }>;
  moveTo: string | null;
  started: boolean;
  chunks: VChunk[];
  bodies: Array<{ anchor: string | null; eof: boolean; body: BodyEntry[] }>;
}

/** A chunk's old and new lines from its body lines, as a unified hunk's are built. */
function chunkLines(body: BodyEntry[]): { O: string[]; N: NLine[] } {
  const O: string[] = [];
  const N: NLine[] = [];
  let oi = 0;
  for (const e of body) {
    if (e.kind === ' ') {
      O.push(e.text);
      N.push({ text: e.text, ctx: oi });
      oi += 1;
    } else if (e.kind === '-') {
      O.push(e.text);
      oi += 1;
    } else if (e.kind === '+') {
      N.push({ text: e.text, ctx: -1 });
    }
  }
  return { O, N };
}

/** The V4A reader (section 8): sections between `*** Begin Patch` and `*** End Patch`, each one edit. */
function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k -= 1) {
    if (!blank(lines[k])) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const secs: VSec[] = [];
  let cur: VSec | null = null;
  let body: { anchor: string | null; eof: boolean; body: BodyEntry[] } | null = null;
  const closeBody = (): void => {
    if (cur !== null && body !== null) cur.bodies.push(body);
    body = null;
  };
  for (let i = first + 1; i < last; i += 1) {
    const line = lines[i]!;
    const kind = line.startsWith('*** Add File: ') ? 'add' : line.startsWith('*** Delete File: ') ? 'del' : line.startsWith('*** Update File: ') ? 'upd' : null;
    if (kind !== null) {
      closeBody();
      const prefix = kind === 'add' ? '*** Add File: ' : kind === 'del' ? '*** Delete File: ' : '*** Update File: ';
      cur = { kind, path: line.slice(prefix.length).trim(), lineNo: i + 1, add: [], moveTo: null, started: false, chunks: [], bodies: [] };
      secs.push(cur);
      continue;
    }
    if (cur === null) {
      if (blank(line)) continue;
      throw new Exit2(`error: parse ${i + 1}`);
    }
    if (cur.kind === 'add') {
      if (line.startsWith('+')) cur.add.push({ text: line.slice(1), rawEmpty: false });
      else if (line === '') cur.add.push({ text: '', rawEmpty: true });
      else throw new Exit2(`error: parse ${i + 1}`);
      continue;
    }
    if (cur.kind === 'del') {
      if (blank(line)) continue;
      throw new Exit2(`error: parse ${i + 1}`);
    }
    // An Update File section: an optional Move to first, then chunks of body lines.
    if (line.startsWith('*** Move to: ')) {
      if (cur.started || cur.moveTo !== null || body !== null) throw new Exit2(`error: parse ${i + 1}`);
      cur.moveTo = line.slice('*** Move to: '.length).trim();
      cur.started = true;
      continue;
    }
    if (line.trim() === '*** End of File') {
      if (body === null) body = { anchor: null, eof: true, body: [] };
      else body.eof = true;
      closeBody();
      cur.started = true;
      continue;
    }
    if (line.startsWith('@@')) {
      closeBody();
      const anchor = line.slice(2).trim();
      body = { anchor: anchor === '' ? null : anchor, eof: false, body: [] };
      cur.started = true;
      continue;
    }
    if (line === '' || line[0] === ' ' || line[0] === '-' || line[0] === '+') {
      if (body === null) {
        if (cur.bodies.length > 0) throw new Exit2(`error: parse ${i + 1}`);
        body = { anchor: null, eof: false, body: [] };
      }
      body.body.push({ kind: line === '' ? ' ' : line[0]!, text: line === '' ? '' : line.slice(1), rawEmpty: line === '', ws: line.trim() === '' });
      cur.started = true;
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  closeBody();
  const edits: Edit[] = [];
  for (const s of secs) {
    // Blank lines at the end of a section are not part of it.
    while (s.add.length > 0 && s.add[s.add.length - 1]!.rawEmpty) s.add.pop();
    const lastBody = s.bodies[s.bodies.length - 1];
    if (lastBody !== undefined) {
      // A blank line at the section's end — an empty line, or a context line of nothing but whitespace — is
      // not part of the section, so a chunk does not end with one.
      while (lastBody.body.length > 0 && lastBody.body[lastBody.body.length - 1]!.kind === ' ' && lastBody.body[lastBody.body.length - 1]!.ws) lastBody.body.pop();
    }
    s.chunks = s.bodies.map((b) => ({ anchor: b.anchor, eof: b.eof, ...chunkLines(b.body) }));
    if (s.kind === 'upd' && s.chunks.length === 0 && s.moveTo === null) throw new Exit2(`error: parse ${s.lineNo}`);
    edits.push(v4aEdit(s, strict));
  }
  return edits;
}

/** One V4A section as one edit (section 8): an add, a delete, or an update with a cursor over its chunks. */
function v4aEdit(s: VSec, strict: boolean): Edit {
  const p = s.path;
  if (s.kind === 'add') {
    const ls = s.add.map((e) => e.text);
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, ls.length === 0 ? '' : `${ls.join('\n')}\n`);
    };
  }
  if (s.kind === 'del') {
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
    };
  }
  const moveTo = s.moveTo;
  const chunks = s.chunks;
  return (tree) => {
    if (!safe(p)) throw new Fail('unsafe', p);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const m = splitFile(before);
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        const at = findAnchor(m.lines, ch.anchor, strict, cursor);
        if (at < 0) throw new Fail('no-match', p);
        cursor = at + 1;
      }
      if (ch.O.length === 0) {
        const pos = ch.eof ? m.lines.length : Math.min(cursor, m.lines.length);
        m.lines.splice(pos, 0, ...ch.N.map((e) => e.text));
        cursor = pos + ch.N.length;
      } else {
        const occ = findOcc(m.lines, ch.O, strict, cursor, ch.eof);
        if (occ === null) throw new Fail('no-match', p);
        const pos = occ.positions[0]!;
        const rendered = renderN(m.lines, pos, ch.O, ch.N, occ.tier);
        m.lines.splice(pos, ch.O.length, ...rendered);
        cursor = pos + rendered.length;
      }
    }
    const out = joinFile(m);
    if (moveTo !== null) {
      tree.now.set(p, null);
      tree.now.set(moveTo, out);
      tree.moves.push([p, moveTo]);
    } else {
      tree.now.set(p, out);
    }
  };
}

/** The run (sections 1, 2 and 10): read the patch, read its edits, apply them in order, write if none failed. */
function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits = kind === 'json' ? jsonEdits(text, lines) : kind === 'unified' ? unifiedEdits(lines, strict) : kind === 'search-replace' ? searchReplaceEdits(lines, strict) : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  // One line per changed path, in byte order; a move that took a file from a path that is gone to one that is
  // new replaces that pair's D and A lines with one R line, sorted by the new path (section 2).
  const rows: Array<{ key: string; text: string }> = [];
  const paired = new Set<string>();
  const finalOf = (p: string): string | null => (tree.now.has(p) ? tree.now.get(p)! : tree.original(p));
  for (const [from, to] of tree.moves) {
    if (paired.has(from) || paired.has(to)) continue;
    if (tree.original(from) !== null && finalOf(from) === null && tree.original(to) === null && finalOf(to) !== null) {
      rows.push({ key: to, text: `R ${from} -> ${to}` });
      paired.add(from);
      paired.add(to);
    }
  }
  for (const p of tree.now.keys()) {
    if (paired.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((x, y) => Buffer.compare(Buffer.from(x.key), Buffer.from(y.key)));
  if (!check) {
    for (const p of tree.now.keys()) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.text), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
