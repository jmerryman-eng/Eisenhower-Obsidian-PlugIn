// Pure logic for parsing task lines and mutating them in-place. No Obsidian
// API dependencies — runnable under plain Node so it can be exercised by the
// dependency-free test (test/parser.test.ts).
//
// The Obsidian plugin (`main.ts`) imports the constants and functions here;
// the test file imports them directly and runs a fixture-driven check against
// parseTasksFromText, rewriteQuadrantInLine, and rewriteCheckboxInLine.
//
// This module is the SINGLE SOURCE OF TRUTH for parse/mutate logic.

export type TaskStatus = 'pending' | 'in_progress' | 'completed' | 'cancelled';
export type Quadrant = 'q1' | 'q2' | 'q3' | 'q4';

export const STATUS_TO_CHAR: Record<TaskStatus, string> = {
  pending: ' ',
  in_progress: '/',
  completed: 'x',
  cancelled: '-',
};
export const CHAR_TO_STATUS: Record<string, TaskStatus> = {
  ' ': 'pending',
  '/': 'in_progress',
  'x': 'completed',
  'X': 'completed',
  '-': 'cancelled',
};
export const STATUS_CYCLE: Record<TaskStatus, TaskStatus> = {
  pending: 'in_progress',
  in_progress: 'completed',
  completed: 'pending',
  cancelled: 'pending',
};

export const QUADRANTS: Quadrant[] = ['q1', 'q2', 'q3', 'q4'];
export const QUAD_TAG_RE = /^tm\/(q[1-4])$/;
// Match a `#tm/qN` tag in a line (with leading whitespace) so we can strip it
// when reassigning. The negative lookahead prevents matching `#tm/q1foo` etc.
export const QUAD_TAG_INLINE_RE = /\s*#tm\/q[1-4](?![A-Za-z0-9_\/-])/g;
// Same idea for the `#tm/archived` tag — lookahead-only (mobile-safe).
export const ARCHIVED_TAG_INLINE_RE = /\s*#tm\/archived(?![A-Za-z0-9_\/-])/g;

const TASK_LINE_RE = /^(\s*)([-*+])\s+\[([ xX\/\-])\]\s+(.+?)\s*$/;
const HAS_TASK_TAG_RE = /(?:#task(?![A-Za-z0-9_-])|#task\/)/;
const TAG_RE = /#([A-Za-z][A-Za-z0-9_\/-]*)/g;
// Obsidian accepts block IDs with letters/digits/dash/underscore, after any
// run of whitespace. (Reviewer L1: previous regex required exactly one space
// and rejected underscores.)
const BLOCK_ID_RE = /\s+\^([a-zA-Z0-9_-]+)$/;
const BLOCK_ID_TRAILING_RE = /^(.*?)(\s+\^[a-zA-Z0-9_-]+)\s*$/;

export interface Task {
  id: string;
  file: string;
  lineNumber: number;
  text: string;
  status: TaskStatus;
  tags: string[];
  quadrant: Quadrant | null;
  blockId: string | null;
  checkChar: string;
  // Identity fingerprint: the full raw line as parsed. Writers verify
  // lines[task.lineNumber] === task.rawLine before mutating, so a stale
  // line number (from inserts/deletes elsewhere in the file) cannot
  // accidentally rewrite a different task line. (Reviewer H1.)
  rawLine: string;
}

export interface MutationResult {
  line: string | null | undefined;
  conflict: boolean;
}

// ── parseTasksFromText ─────────────────────────────────────────────────────
// Naive OFM-aware: skips frontmatter and fenced code blocks. Inline code
// spans, %%comments%%, wikilink-target #task occurrences, indented code
// blocks — known Phase-2 gaps per the spec, intentionally not handled here.
export function parseTasksFromText(filePath: string, text: string): Task[] {
  const tasks: Task[] = [];
  const lines = text.split('\n');
  let inFrontmatter = false;
  let inCodeFence = false;
  let fenceMarker = '';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    if (i === 0 && trimmed === '---') {
      inFrontmatter = true;
      continue;
    }
    if (inFrontmatter) {
      if (trimmed === '---' || trimmed === '...') inFrontmatter = false;
      continue;
    }

    if (!inCodeFence && /^(```|~~~)/.test(trimmed)) {
      inCodeFence = true;
      fenceMarker = trimmed.startsWith('```') ? '```' : '~~~';
      continue;
    }
    if (inCodeFence) {
      if (trimmed.startsWith(fenceMarker)) {
        inCodeFence = false;
        fenceMarker = '';
      }
      continue;
    }

    const match = line.match(TASK_LINE_RE);
    if (!match) continue;
    const checkChar = match[3];
    const body = match[4];

    if (!HAS_TASK_TAG_RE.test(body)) continue;

    const blockMatch = body.match(BLOCK_ID_RE);
    const blockId = blockMatch ? blockMatch[1] : null;
    const textBody = blockMatch ? body.slice(0, body.length - blockMatch[0].length) : body;

    const status: TaskStatus = CHAR_TO_STATUS[checkChar] || 'pending';

    const tags: string[] = [];
    const tagRe = new RegExp(TAG_RE.source, 'g'); // fresh state per call
    let m: RegExpExecArray | null;
    while ((m = tagRe.exec(textBody)) !== null) tags.push(m[1]);

    // Archive opt-out: lines tagged #tm/archived stay in the markdown but
    // drop out of the matrix and backlog. Bring one back by deleting the
    // tag in Obsidian — the next parse re-includes it.
    if (tags.includes('tm/archived')) continue;

    let quadrant: Quadrant | null = null;
    for (const t of tags) {
      const qm = t.match(QUAD_TAG_RE);
      if (qm) { quadrant = qm[1] as Quadrant; break; }
    }

    const id = blockId ? `b:${blockId}` : `l:${filePath}:${i}`;

    tasks.push({
      id,
      file: filePath,
      lineNumber: i,
      text: textBody.trim(),
      status,
      tags,
      quadrant,
      blockId,
      checkChar,
      rawLine: line,
    });
  }
  return tasks;
}

// ── rewriteQuadrantInLine ──────────────────────────────────────────────────
// Strip any existing #tm/qN tag, then insert the new one (if any) before the
// trailing block ID. Returns { line, conflict }: conflict=true means the
// caller should bail out (line shape changed or content drifted — never write).
//
// `expectedRawLine` is the line content captured at parse time. Identity
// check: if the actual line bytes don't match, a different task is now at
// this index and we MUST NOT mutate it. (Reviewer H1.)
export function rewriteQuadrantInLine(
  line: string | null | undefined,
  expectedRawLine: string,
  quadrant: Quadrant | null,
): MutationResult {
  if (line === undefined || line === null) return { line, conflict: true };
  if (quadrant !== null && !QUADRANTS.includes(quadrant)) return { line, conflict: true };
  if (line !== expectedRawLine) return { line, conflict: true };

  if (!/^\s*[-*+]\s+\[[ xX\/\-]\]\s+/.test(line)) return { line, conflict: true };
  if (!HAS_TASK_TAG_RE.test(line)) return { line, conflict: true };

  let updated = line.replace(QUAD_TAG_INLINE_RE, '');

  if (quadrant !== null) {
    const blockIdMatch = updated.match(BLOCK_ID_TRAILING_RE);
    if (blockIdMatch) {
      updated = blockIdMatch[1].replace(/\s+$/, '') + ' #tm/' + quadrant + blockIdMatch[2];
    } else {
      updated = updated.replace(/\s+$/, '') + ' #tm/' + quadrant;
    }
  }

  return { line: updated, conflict: false };
}

// ── rewriteCheckboxInLine ──────────────────────────────────────────────────
// Replace exactly the checkbox character. Verifies (a) the line content matches
// what we parsed (identity), and (b) the current checkbox char matches what
// we last saw (state). Either mismatch → conflict, do not write. (Reviewer H1.)
export function rewriteCheckboxInLine(
  line: string | null | undefined,
  expectedRawLine: string,
  expectedChar: string,
  newChar: string | undefined,
): MutationResult {
  if (line === undefined || line === null) return { line, conflict: true };
  if (newChar === undefined) return { line, conflict: true };
  if (line !== expectedRawLine) return { line, conflict: true };

  const m = line.match(/^(\s*[-*+]\s+\[)([ xX\/\-])(\].*)$/);
  if (!m) return { line, conflict: true };
  if (m[2] !== expectedChar) return { line, conflict: true };

  return { line: m[1] + newChar + m[3], conflict: false };
}

// ── mutateArchive ──────────────────────────────────────────────────────────
// Strip any quadrant tag and any existing #tm/archived (so re-archiving is
// idempotent), then insert #tm/archived before the trailing block ID (or at
// end of line). The line stays in the markdown; it's the parser's
// `tm/archived` check that drops it from the matrix. Conflict-checked like
// the other mutators: identity must match and the line must still be a
// checkbox before we touch it. (Reviewer H1.)
export function mutateArchive(
  line: string | null | undefined,
  expectedRawLine: string,
): MutationResult {
  if (line === undefined || line === null) return { line, conflict: true };
  if (line !== expectedRawLine) return { line, conflict: true };
  if (!/^\s*[-*+]\s+\[[ xX\/\-]\]\s+/.test(line)) return { line, conflict: true };

  const stripped = line
    .replace(QUAD_TAG_INLINE_RE, '')
    .replace(ARCHIVED_TAG_INLINE_RE, '');

  const m = stripped.match(BLOCK_ID_TRAILING_RE);
  const updated = m
    ? m[1].replace(/\s+$/, '') + ' #tm/archived' + m[2]
    : stripped.replace(/\s+$/, '') + ' #tm/archived';

  return { line: updated, conflict: false };
}
