import test from 'node:test';
import assert from 'node:assert/strict';
import { createComfy } from '../src/comfy.mjs';
import { LIMITS } from '../src/catalog.mjs';

const image = { filename: 'native_00001_.png', subfolder: 'moss_draw/test', type: 'output' };
const ORIGIN = 'http://127.0.0.1:8188';
// Deterministic, distinguishable bytes; content is never validated here, only transport.
function bytes(size) {
  return Buffer.from(Array.from({ length: size }, (_, i) => (i * 31 + 7) & 255));
}
// A 200 whose body delivers `prefix` (via pull, so the bytes are really read)
// and then dies like a dead slow link.
function interrupted(prefix, headers = {}) {
  let delivered = false;
  return new Response(new ReadableStream({
    pull(controller) {
      if (!delivered) { delivered = true; controller.enqueue(prefix); return; }
      controller.error(Object.assign(new Error('connection reset'), { name: 'TimeoutError' }));
    },
  }), { status: 200, headers });
}
function receipt(url, init) {
  return { url: String(url), method: init?.method, headers: new Headers(init?.headers) };
}
function viewOk(full, split, extra = {}) {
  return new Response(full.subarray(split), {
    status: 206,
    headers: {
      'content-type': 'image/png',
      'content-range': `bytes ${split}-${full.length - 1}/${full.length}`,
      'content-length': String(full.length - split),
      ...extra,
    },
  });
}

test('image collection gets a longer bounded download budget than metadata requests', async t => {
  const budgets = [];
  t.mock.method(AbortSignal, 'timeout', ms => { budgets.push(ms); return new AbortController().signal; });
  const c = createComfy(ORIGIN, async url => new Response(url.includes('/view?') ? Buffer.from('image') : JSON.stringify({}), { status: 200 }));
  await c.history('original-prompt');
  await c.image(image);
  assert.equal(budgets[0], 25000);
  assert.equal(budgets[1], 180000);
});

test('an interrupted 200 body resumes the same image with Range/If-Range and stitches one copy', async () => {
  const full = bytes(4096), split = 1536, calls = [];
  const c = createComfy(ORIGIN, async (url, init) => {
    calls.push(receipt(url, init));
    if (calls.length === 1) {
      return interrupted(full.subarray(0, split), {
        'content-type': 'image/png', 'content-length': String(full.length), 'accept-ranges': 'bytes', etag: '"v1"',
      });
    }
    return viewOk(full, split, { etag: '"v1"' });
  });
  const got = await c.image(image);
  assert.deepEqual(Buffer.from(got), full);
  assert.equal(calls.length, 2);
  assert(calls.every(call => call.method === 'GET' && call.url.startsWith(`${ORIGIN}/view?`)));
  assert.equal(calls[0].headers.get('range'), null);
  assert.equal(calls[1].headers.get('range'), `bytes=${split}-${full.length - 1}`);
  assert.equal(calls[1].headers.get('if-range'), '"v1"');
});

test('a resumed download can fall back to Last-Modified as the range validator', async () => {
  const full = bytes(2048), split = 700, stamp = 'Wed, 28 Oct 2026 09:00:00 GMT';
  let calls = 0;
  const c = createComfy(ORIGIN, async () => {
    calls++;
    if (calls === 1) return interrupted(full.subarray(0, split), { 'content-length': String(full.length), 'last-modified': stamp });
    return viewOk(full, split, { etag: '"v1"', 'last-modified': stamp });
  });
  assert.deepEqual(Buffer.from(await c.image(image)), full);
  assert.equal(calls, 2);
});

test('a resume answered with 200 fails closed instead of concatenating a second copy', async () => {
  const full = bytes(2048), split = 512;
  let calls = 0;
  const c = createComfy(ORIGIN, async () => {
    calls++;
    if (calls === 1) return interrupted(full.subarray(0, split), { 'content-length': String(full.length), etag: '"v1"' });
    return new Response(full, { status: 200, headers: { 'content-length': String(full.length), etag: '"v1"' } });
  });
  await assert.rejects(c.image(image), e => e.code === 'NETWORK_UNKNOWN');
  assert.equal(calls, 2, 'a non-partial range reply is never retried or stitched');
});

test('a range reply whose content-range does not continue the received bytes fails closed', async () => {
  const full = bytes(2048), split = 512;
  let calls = 0;
  const c = createComfy(ORIGIN, async () => {
    calls++;
    if (calls === 1) return interrupted(full.subarray(0, split), { 'content-length': String(full.length), etag: '"v1"' });
    return new Response(full.subarray(split), {
      status: 206,
      headers: { 'content-range': `bytes 0-${full.length - split - 1}/${full.length}`, 'content-length': String(full.length - split), etag: '"v1"' },
    });
  });
  await assert.rejects(c.image(image), e => e.code === 'NETWORK_UNKNOWN');
  assert.equal(calls, 2);
});

test('a range reply for a different entity (changed ETag) fails closed', async () => {
  const full = bytes(2048), split = 512;
  let calls = 0;
  const c = createComfy(ORIGIN, async () => {
    calls++;
    if (calls === 1) return interrupted(full.subarray(0, split), { 'content-length': String(full.length), etag: '"v1"' });
    return viewOk(full, split, { etag: '"v2"' });
  });
  await assert.rejects(c.image(image), e => e.code === 'NETWORK_UNKNOWN');
  assert.equal(calls, 2);
});

test('a range reply that changes the fixed total length fails closed', async () => {
  const full = bytes(2048), split = 512;
  let calls = 0;
  const c = createComfy(ORIGIN, async () => {
    calls++;
    if (calls === 1) return interrupted(full.subarray(0, split), { 'content-length': String(full.length), etag: '"v1"' });
    return new Response(full.subarray(split), {
      status: 206,
      headers: { 'content-range': `bytes ${split}-${full.length - 1}/${full.length + 1}`, etag: '"v1"' },
    });
  });
  await assert.rejects(c.image(image), e => e.code === 'NETWORK_UNKNOWN');
  assert.equal(calls, 2);
});

test('an interrupted 200 without both a fixed total length and a validator never guesses a Range resume', async () => {
  for (const headers of [
    {}, // no length, no validator
    { etag: '"v1"' }, // validator but no fixed total length
    { 'content-length': '4096' }, // fixed length but no validator
    { 'content-length': '4096', etag: 'W/"weak"' }, // weak ETag is not a strong validator
  ]) {
    let calls = 0;
    const c = createComfy(ORIGIN, async () => { calls++; return interrupted(bytes(64), headers); });
    await assert.rejects(c.image(image), e => e.code === 'NETWORK_UNKNOWN', JSON.stringify(headers));
    assert.equal(calls, 1, `no blind range retry for ${JSON.stringify(headers)}`);
  }
});

test('caller cancellation during a resumed body stays the exact caller reason', async () => {
  const full = bytes(2048), split = 512, reason = new Error('user cancelled'), controller = new AbortController();
  let calls = 0;
  const c = createComfy(ORIGIN, async () => {
    calls++;
    if (calls === 1) return interrupted(full.subarray(0, split), { 'content-length': String(full.length), etag: '"v1"' });
    return new Response(new ReadableStream({
      start(c) { controller.abort(reason); c.error(reason); },
    }), { status: 206, headers: { 'content-range': `bytes ${split}-${full.length - 1}/${full.length}`, 'content-length': String(full.length - split), etag: '"v1"' } });
  });
  await assert.rejects(c.image(image, controller.signal), e => e === reason);
  assert.equal(calls, 2);
});

test('a resumed body cannot overrun the fixed total length', async () => {
  const full = bytes(2048), split = 512;
  const over = Buffer.concat([full.subarray(split), bytes(64)]);
  let calls = 0;
  const c = createComfy(ORIGIN, async () => {
    calls++;
    if (calls === 1) return interrupted(full.subarray(0, split), { 'content-length': String(full.length), etag: '"v1"' });
    return new Response(over, { status: 206, headers: { 'content-range': `bytes ${split}-${full.length - 1}/${full.length}`, etag: '"v1"' } });
  });
  await assert.rejects(c.image(image), e => e.code === 'NETWORK_UNKNOWN');
  assert.equal(calls, 2);
});

test('a strong ETag cannot downgrade to a date and rejected range bodies are cancelled',async()=>{for(const headers of [{etag:'W/"v1"','last-modified':'Wed, 28 Oct 2026 09:00:00 GMT'},{'last-modified':'Wed, 28 Oct 2026 09:00:00 GMT'}]){let calls=0,cancelled=false;const c=createComfy(ORIGIN,async()=>{if(++calls===1)return interrupted(bytes(64),{'content-length':'128',etag:'"v1"','last-modified':'Wed, 28 Oct 2026 09:00:00 GMT'});return new Response(new ReadableStream({start(c){c.enqueue(bytes(64));c.close();},cancel(){cancelled=true;}}),{status:206,headers:{'content-range':'bytes 64-127/128','content-length':'64',...headers}});});await assert.rejects(c.image(image),e=>e.code==='NETWORK_UNKNOWN');assert.equal(cancelled,true);}});
test('a resumed response must include an exact content length',async()=>{let calls=0;const c=createComfy(ORIGIN,async()=>{if(++calls===1)return interrupted(bytes(64),{'content-length':'128',etag:'"v1"'});return new Response(bytes(64),{status:206,headers:{'content-range':'bytes 64-127/128',etag:'"v1"'}});});await assert.rejects(c.image(image),e=>e.code==='NETWORK_UNKNOWN');});
test('the PNG byte ceiling is enforced without downloads or range retries', async () => {
  let calls = 0;
  const big = createComfy(ORIGIN, async () => { calls++; return new Response('x', { headers: { 'content-length': String(LIMITS.png_bytes + 1) } }); });
  await assert.rejects(big.image(image), e => e.code === 'RESPONSE_TOO_LARGE');
  assert.equal(calls, 1);
});
