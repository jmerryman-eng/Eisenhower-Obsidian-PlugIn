// Dependency-free self-test for src/parser.ts. Run with:
//   node --experimental-strip-types --test test/
// (npm test). Covers task detection (frontmatter / fence skipping, tags,
// block IDs, quadrant extraction) and the two line-mutation helpers
// (rewriteCheckboxInLine, rewriteQuadrantInLine) including the H1 identity
// check that prevents writing through a stale lineNumber.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseTasksFromText,
  rewriteCheckboxInLine,
  rewriteQuadrantInLine,
} from '../src/parser.ts';

test('parseTasksFromText: detects a basic #task line', () => {
  const tasks = parseTasksFromText('a.md', '- [ ] Buy milk #task');
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].text, 'Buy milk #task');
  assert.equal(tasks[0].status, 'pending');
  assert.equal(tasks[0].quadrant, null);
  assert.equal(tasks[0].file, 'a.md');
  assert.equal(tasks[0].lineNumber, 0);
  assert.equal(tasks[0].rawLine, '- [ ] Buy milk #task');
  assert.deepEqual(tasks[0].tags, ['task']);
});

test('parseTasksFromText: detects every status character', () => {
  const text = [
    '- [ ] pending #task',
    '- [/] in progress #task',
    '- [x] done #task',
    '- [-] cancelled #task',
  ].join('\n');
  const tasks = parseTasksFromText('a.md', text);
  assert.deepEqual(tasks.map((t) => t.status), ['pending', 'in_progress', 'completed', 'cancelled']);
});

test('parseTasksFromText: extracts quadrant from #tm/qN tag', () => {
  const text = [
    '- [ ] one #task #tm/q1',
    '- [ ] two #task #tm/q2 ^task-abc',
    '- [ ] three #task',
  ].join('\n');
  const tasks = parseTasksFromText('a.md', text);
  assert.equal(tasks[0].quadrant, 'q1');
  assert.equal(tasks[1].quadrant, 'q2');
  assert.equal(tasks[1].blockId, 'task-abc');
  assert.equal(tasks[2].quadrant, null);
});

test('parseTasksFromText: skips frontmatter', () => {
  const text = [
    '---',
    'tags: [#task]',
    '- [ ] not a task #task',
    '---',
    '- [ ] real task #task',
  ].join('\n');
  const tasks = parseTasksFromText('a.md', text);
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].text, 'real task #task');
});

test('parseTasksFromText: skips fenced code blocks (```)', () => {
  const text = [
    'prose',
    '```',
    '- [ ] code task #task',
    '```',
    '- [ ] real task #task',
  ].join('\n');
  const tasks = parseTasksFromText('a.md', text);
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].text, 'real task #task');
});

test('parseTasksFromText: skips fenced code blocks (~~~)', () => {
  const text = '~~~\n- [ ] code task #task\n~~~\n- [ ] real task #task';
  const tasks = parseTasksFromText('a.md', text);
  assert.equal(tasks.length, 1);
});

test('parseTasksFromText: rejects #tasks (non-whole tag)', () => {
  const tasks = parseTasksFromText('a.md', '- [ ] not detected #tasks');
  assert.equal(tasks.length, 0);
});

test('parseTasksFromText: accepts #task subtag like #task/work', () => {
  const tasks = parseTasksFromText('a.md', '- [ ] work item #task/work');
  assert.equal(tasks.length, 1);
  assert.deepEqual(tasks[0].tags, ['task/work']);
});

test('parseTasksFromText: block ID becomes stable id; line-based id otherwise', () => {
  const tasks = parseTasksFromText('a.md', '- [ ] one #task ^task-aaa\n- [ ] two #task');
  assert.equal(tasks[0].id, 'b:task-aaa');
  assert.equal(tasks[1].id, 'l:a.md:1');
});

test('parseTasksFromText: block ID accepts underscores (reviewer L1)', () => {
  const tasks = parseTasksFromText('a.md', '- [ ] one #task ^my_block_id');
  assert.equal(tasks[0].blockId, 'my_block_id');
});

test('parseTasksFromText: first #tm/qN wins when multiple are present', () => {
  const tasks = parseTasksFromText('a.md', '- [ ] confused #task #tm/q3 #tm/q1');
  assert.equal(tasks[0].quadrant, 'q3');
});

test('parseTasksFromText: ignores list items without checkboxes', () => {
  const tasks = parseTasksFromText('a.md', '- bullet with #task but no checkbox');
  assert.equal(tasks.length, 0);
});

test('parseTasksFromText: handles indented checkbox tasks', () => {
  const tasks = parseTasksFromText('a.md', '  - [ ] nested task #task');
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].rawLine, '  - [ ] nested task #task');
});

test('rewriteCheckboxInLine: toggles pending → completed when state matches', () => {
  const r = rewriteCheckboxInLine('- [ ] x #task', '- [ ] x #task', ' ', 'x');
  assert.equal(r.conflict, false);
  assert.equal(r.line, '- [x] x #task');
});

test('rewriteCheckboxInLine: conflict if line content drifted (H1)', () => {
  // Same line index in the file now contains a different task — even with
  // matching shape and state, identity check must fail.
  const r = rewriteCheckboxInLine('- [ ] OTHER task #task', '- [ ] x #task', ' ', 'x');
  assert.equal(r.conflict, true);
});

test('rewriteCheckboxInLine: conflict if checkbox char drifted', () => {
  const r = rewriteCheckboxInLine('- [/] x #task', '- [ ] x #task', ' ', 'x');
  assert.equal(r.conflict, true);
});

test('rewriteCheckboxInLine: conflict if line is no longer a checkbox', () => {
  const r = rewriteCheckboxInLine('plain text', 'plain text', ' ', 'x');
  assert.equal(r.conflict, true);
});

test('rewriteCheckboxInLine: conflict on null/undefined line', () => {
  assert.equal(rewriteCheckboxInLine(undefined, '- [ ] x #task', ' ', 'x').conflict, true);
  assert.equal(rewriteCheckboxInLine(null, '- [ ] x #task', ' ', 'x').conflict, true);
});

test('rewriteQuadrantInLine: inserts #tm/q1 on a backlog task', () => {
  const line = '- [ ] do thing #task';
  const r = rewriteQuadrantInLine(line, line, 'q1');
  assert.equal(r.conflict, false);
  assert.equal(r.line, '- [ ] do thing #task #tm/q1');
});

test('rewriteQuadrantInLine: inserts before trailing block ID', () => {
  const line = '- [ ] do thing #task ^task-abc';
  const r = rewriteQuadrantInLine(line, line, 'q1');
  assert.equal(r.conflict, false);
  assert.equal(r.line, '- [ ] do thing #task #tm/q1 ^task-abc');
});

test('rewriteQuadrantInLine: replaces existing #tm/qN', () => {
  const line = '- [ ] do thing #task #tm/q2 ^task-abc';
  const r = rewriteQuadrantInLine(line, line, 'q1');
  assert.equal(r.conflict, false);
  assert.equal(r.line, '- [ ] do thing #task #tm/q1 ^task-abc');
});

test('rewriteQuadrantInLine: clears quadrant tag when null', () => {
  const line = '- [ ] do thing #task #tm/q3 ^task-abc';
  const r = rewriteQuadrantInLine(line, line, null);
  assert.equal(r.conflict, false);
  assert.equal(r.line, '- [ ] do thing #task ^task-abc');
});

test('rewriteQuadrantInLine: clears quadrant tag with no block ID', () => {
  const line = '- [ ] do thing #task #tm/q3';
  const r = rewriteQuadrantInLine(line, line, null);
  assert.equal(r.conflict, false);
  assert.equal(r.line, '- [ ] do thing #task');
});

test('rewriteQuadrantInLine: conflict if line content drifted (H1)', () => {
  const r = rewriteQuadrantInLine('- [ ] OTHER #task', '- [ ] do thing #task', 'q1');
  assert.equal(r.conflict, true);
});

test('rewriteQuadrantInLine: conflict if line lost its #task tag', () => {
  const line = '- [ ] no longer a task';
  const r = rewriteQuadrantInLine(line, line, 'q1');
  assert.equal(r.conflict, true);
});

test('rewriteQuadrantInLine: conflict on invalid quadrant', () => {
  const line = '- [ ] x #task';
  // @ts-expect-error — exercising an invalid quadrant value at runtime.
  const r = rewriteQuadrantInLine(line, line, 'q5');
  assert.equal(r.conflict, true);
});

test('rewriteQuadrantInLine: does not consume leading indent when stripping #tm/qN', () => {
  // The QUAD_TAG_INLINE_RE consumes leading whitespace. Make sure the indent
  // before the list marker survives. (Sanity check on reviewer L3.)
  const line = '  - [ ] indented #task #tm/q2';
  const r = rewriteQuadrantInLine(line, line, null);
  assert.equal(r.conflict, false);
  assert.equal(r.line, '  - [ ] indented #task');
});

test('round-trip: parses #tm/qN added by external tool (Claude flow)', () => {
  // External write adds #tm/q1 → re-parse picks it up.
  const before = '- [ ] thing #task';
  const after = rewriteQuadrantInLine(before, before, 'q1').line as string;
  const tasks = parseTasksFromText('a.md', after);
  assert.equal(tasks[0].quadrant, 'q1');
});
