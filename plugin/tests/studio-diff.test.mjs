import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const url = new URL('../client/studio-diff.mjs', import.meta.url);
let api;
try { api = await import(url); } catch (error) { if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error; }
const diff = (...args) => { assert.equal(typeof api?.wordDiff, 'function', 'wordDiff must be exported'); return api.wordDiff(...args); };
function check(before, after, options, fn = diff) {
  const result = fn(before, after, options);
  assert.deepEqual(Object.keys(result).sort(), ['segments', 'truncated']);
  assert.equal(typeof result.truncated, 'boolean');
  let previous;
  for (const segment of result.segments) {
    assert.deepEqual(Object.keys(segment).sort(), ['kind', 'text']);
    assert.ok(['equal', 'delete', 'insert'].includes(segment.kind));
    assert.equal(typeof segment.text, 'string');
    assert.notEqual(segment.text, '');
    assert.notEqual(segment.kind, previous);
    previous = segment.kind;
  }
  assert.equal(result.segments.filter(s => s.kind !== 'insert').map(s => s.text).join(''), before);
  assert.equal(result.segments.filter(s => s.kind !== 'delete').map(s => s.text).join(''), after);
  return result;
}
for (const [name, before, after] of [
  ['empty', '', ''], ['identical', '同 text 😀', '同 text 😀'],
  ['add', '', 'hello'], ['delete', 'hello', ''],
  ['English', 'the red cat sleeps', 'the blue cat sleeps'],
  ['Chinese', '春天的花开了', '春天的花落了'], ['emoji', 'a😀🚀b', 'a😃🚀b'],
  ['combining', 'Cafe\u0301 noir', 'Cafe\u0300 noir'], ['CRLF', 'a\r\nb\r\n', 'a\r\nc\n'],
  ['whitespace', ' a\t b  \n', '  a b\t\n'], ['punctuation', 'a,b! <tag>', 'a;b? <tag>'],
]) test(name, () => { assert.equal(check(before, after).truncated, false); });
test('word matching preserves shared interior words', () => {
  const result = check('red cat and dog old', 'blue cat and dog new');
  assert.ok(result.segments.some(s => s.kind === 'equal' && s.text.includes('cat and dog')));
});
test('only fixed named public export', () => { diff('', ''); assert.deepEqual(Object.keys(api), ['wordDiff']); });
test('token budget fallback preserves both full strings and common ends', () => {
  const result = check('prefix ' + '甲 '.repeat(100) + ' suffix', 'prefix ' + '乙 '.repeat(100) + ' suffix', { maxTokens: 16 });
  assert.equal(result.truncated, true);
  assert.equal(result.segments[0].kind, 'equal');
  assert.equal(result.segments.at(-1).kind, 'equal');
});
test('work budget fallback reconstructs both strings', () => {
  assert.equal(check('a '.repeat(40), 'b '.repeat(40), { maxWork: 64 }).truncated, true);
});
test('limits include 12000 UTF16 code units', () => { check('😀'.repeat(6000), 'x'.repeat(12000)); });
test('reject nonstrings and oversized strings explicitly', () => {
  for (const value of [null, undefined, 1, {}, ['x'], new String('x')]) {
    assert.throws(() => diff(value, ''), /string/i); assert.throws(() => diff('', value), /string/i);
  }
  assert.throws(() => diff('x'.repeat(12001), ''), /12000|length/i);
  assert.throws(() => diff('', 'x'.repeat(12001)), /12000|length/i);
});
test('strict option validation', () => {
  for (const options of [null, [], 'x', 1, { unknown: 1 }, { [Symbol('x')]: 1 }]) assert.throws(() => diff('', '', options));
  for (const [key, min, max] of [['maxTokens', 16, 4096], ['maxWork', 64, 1000000]]) {
    for (const value of [NaN, Infinity, -Infinity, 1.5, min - 1, max + 1, '64', null, undefined]) assert.throws(() => diff('', '', { [key]: value }));
    for (const value of [min, max]) check('a', 'b', { [key]: value });
  }
});
test('does not mutate options or retain mutable result state', () => {
  const options = Object.freeze({ maxTokens: 100, maxWork: 1000 });
  const first = check('one', 'two', options); first.segments[0].text = 'corrupt';
  check('one', 'two', options); assert.deepEqual(options, { maxTokens: 100, maxWork: 1000 });
});
test('pure browser ESM works without Intl.Segmenter and distinguishes Chinese characters', async () => {
  const source = await readFile(url, 'utf8');
  assert.doesNotMatch(source, /\bimport\s|\brequire\s*\(/);
  const context = vm.createContext({ Intl: {}, Uint32Array });
  const fallback = vm.runInContext(source.replace('export function wordDiff', 'function wordDiff') + '\nwordDiff;', context);
  const result = check('甲乙丙', '甲丁丙', {}, (...args) => JSON.parse(JSON.stringify(fallback(...args))));
  assert.deepEqual(result.segments, [{ kind: 'equal', text: '甲' }, { kind: 'delete', text: '乙' }, { kind: 'insert', text: '丁' }, { kind: 'equal', text: '丙' }]);
});
test('deterministic reconstruction across varied small inputs and fallback budgets', () => {
  let seed = 12345;
  const random = () => (seed = (seed * 1664525 + 1013904223) >>> 0);
  const chars = ['a', '中', '😀', '\r', '\n', ' ', '\t', '\u0301', '<'];
  for (let i = 0; i < 150; i++) {
    const make = () => Array.from({ length: random() % 35 }, () => chars[random() % chars.length]).join('');
    const before = make(), after = make(); check(before, after); check(before, after, { maxTokens: 16, maxWork: 64 });
  }
});
