// Pure browser data API. No rendering, dependencies, or retained caller state.
function append(segments, kind, text) {
  if (!text) return;
  const last = segments[segments.length - 1];
  if (last?.kind === kind) last.text += text;
  else segments.push({ kind, text });
}

function fallback(before, after) {
  // Code points avoid splitting surrogate pairs while preserving exact UTF16 text.
  const a = Array.from(before), b = Array.from(after);
  let start = 0, end = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  while (end < a.length - start && end < b.length - start && a[a.length - end - 1] === b[b.length - end - 1]) end++;
  const segments = [];
  append(segments, 'equal', a.slice(0, start).join(''));
  append(segments, 'delete', a.slice(start, a.length - end).join(''));
  append(segments, 'insert', b.slice(start, b.length - end).join(''));
  append(segments, 'equal', a.slice(a.length - end).join(''));
  return { segments, truncated: true };
}

function tokenize(text, limit, segmenter) {
  const tokens = [];
  // Latin/alphanumeric words remain words; Han characters remain individually
  // matchable without ICU. Everything else (including whitespace) is preserved.
  const iterable = segmenter ? segmenter.segment(text) : text.matchAll(/[\p{Script=Han}]|[\p{L}\p{N}\p{M}_]+|\s+|[^\p{L}\p{N}\p{M}_\s]/gu);
  for (const item of iterable) {
    tokens.push(segmenter ? item.segment : item[0]);
    if (tokens.length > limit) return null;
  }
  return tokens;
}

/**
 * Lossless, coalesced word diff. maxTokens caps combined input tokens;
 * maxWork caps LCS cells before allocation. Exhaustion returns a lossless
 * common-prefix/suffix diff, not a clipped input. Lengths are UTF16 units.
 */
export function wordDiff(before, after, options = {}) {
  if (typeof before !== 'string' || typeof after !== 'string') throw new TypeError('before and after must be strings');
  if (before.length > 12000 || after.length > 12000) throw new RangeError('string length must be <= 12000 UTF16 units');
  if (options === null || typeof options !== 'object' || Array.isArray(options)) throw new TypeError('options must be an object');
  for (const key of Reflect.ownKeys(options)) {
    if (key !== 'maxTokens' && key !== 'maxWork') throw new TypeError(`Unknown option: ${String(key)}`);
  }
  const getLimit = (key, min, max, defaultValue) => {
    const value = Object.hasOwn(options, key) ? options[key] : defaultValue;
    if (!Number.isFinite(value) || !Number.isInteger(value) || value < min || value > max) throw new RangeError(`${key} must be a finite integer in ${min}..${max}`);
    return value;
  };
  const maxTokens = getLimit('maxTokens', 16, 4096, 2048);
  const maxWork = getLimit('maxWork', 64, 1000000, 250000);
  if (before === after) return { segments: before ? [{ kind: 'equal', text: before }] : [], truncated: false };
  if (!before || !after) return { segments: [{ kind: before ? 'delete' : 'insert', text: before || after }], truncated: false };
  const segmenter = typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function' ? new Intl.Segmenter(undefined, { granularity: 'word' }) : null;
  const a = tokenize(before, maxTokens, segmenter);
  if (!a) return fallback(before, after);
  const b = tokenize(after, maxTokens - a.length, segmenter);
  if (!b) return fallback(before, after);
  const rows = a.length + 1, columns = b.length + 1;
  if (rows * columns > maxWork) return fallback(before, after);
  const table = new Uint32Array(rows * columns);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i * columns + j] = a[i] === b[j]
        ? 1 + table[(i + 1) * columns + j + 1]
        : Math.max(table[(i + 1) * columns + j], table[i * columns + j + 1]);
    }
  }
  const segments = [];
  let i = 0, j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { append(segments, 'equal', a[i++]); j++; }
    else if (table[(i + 1) * columns + j] >= table[i * columns + j + 1]) append(segments, 'delete', a[i++]);
    else append(segments, 'insert', b[j++]);
  }
  append(segments, 'delete', a.slice(i).join(''));
  append(segments, 'insert', b.slice(j).join(''));
  return { segments, truncated: false };
}
