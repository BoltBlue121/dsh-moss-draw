import { mkdir, open, readFile, readdir, rename, unlink, link } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { fault, runId, UUID } from './catalog.mjs';
import { setTimeout as delay } from 'node:timers/promises';

const locks = new Map();
export const hash = bytes => createHash('sha256').update(bytes).digest('hex');

// Shared by every service instance in this process. A permanent exclusive request
// claim additionally prevents a second process from ever submitting the same ID.
function serialize(key, operation, signal) {
  signal?.throwIfAborted();
  const previous = locks.get(key) || Promise.resolve();
  let started = false, abort;
  const result = previous.then(() => { signal?.throwIfAborted(); started = true; return operation(); });
  const tail = result.catch(() => {});
  locks.set(key, tail);
  const settled = result.finally(() => { if (locks.get(key) === tail) locks.delete(key); });
  if (!signal) return settled;
  // Reject promptly while queued, but never release an executing operation's lock.
  const cancelled = new Promise((_, reject) => {
    abort = () => { if (!started) reject(signal.reason); };
    signal.addEventListener('abort', abort, { once: true });
  });
  return Promise.race([settled, cancelled]).finally(() => signal.removeEventListener('abort', abort));
}
export async function atomicWrite(filename, bytes) {
  await mkdir(path.dirname(filename), { recursive: true });
  const temp = `${filename}.${randomUUID()}.tmp`;
  const handle = await open(temp, 'wx');
  try { await handle.writeFile(bytes); await handle.sync(); }
  finally { await handle.close(); }
  try {
    // Windows readers/AV can briefly deny replacement while a shared handle is
    // open. Retry only this already-fsynced rename, never the surrounding work
    // or any HTTP submission, and never unlink the old destination to force it.
    for (let attempt = 0; ; attempt++) {
      try { await rename(temp, filename); break; }
      catch (e) {
        if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(e.code) || attempt >= 7) throw e;
        await delay(Math.min(20 * 2 ** attempt, 200));
      }
    }
  } finally { await unlink(temp).catch(e => { if (e.code !== 'ENOENT') throw e; }); }
}
const encoded = value => JSON.stringify(value, null, 2) + '\n';
async function json(filename, optional = false) {
  try { return JSON.parse(await readFile(filename, 'utf8')); }
  catch (e) {
    if (optional && e.code === 'ENOENT') return null;
    if (e.code === 'ENOENT') throw fault('RUN_NOT_FOUND', 'Run not found.');
    throw fault('STORE_CORRUPT', 'Local record is unreadable; ask maintenance to inspect it.');
  }
}
export function createStore(dataRoot) {
  if (typeof dataRoot !== 'string' || !path.isAbsolute(dataRoot)) throw fault('INVALID_CONFIG', 'dataRoot must be a trusted absolute path.');
  const root = path.resolve(dataRoot);
  const directory = id => path.join(root, 'runs', runId(id));
  const key = process.platform === 'win32' ? root.toLowerCase() : root;
  return {
    root,
    directory,
    locked: (operation, signal) => serialize(key, operation, signal),
    async read(id) {
      const filename = path.join(directory(id), 'run.json');
      let record = await json(filename, true);
      if (!record) {
        // A claim may be the only durable record after a crash before run.json.
        // Never turn that reservation into a fresh submission.
        let claims;
        try { claims = await readdir(path.join(root, 'requests')); }
        catch (e) { if (e.code !== 'ENOENT') throw e; claims = []; }
        for (const name of claims) {
          if (!/^[0-9a-f]{64}\.json$/.test(name)) continue;
          const claim = await json(path.join(root, 'requests', name));
          if (claim.run_id === id) { record = claim; break; }
        }
        if (!record) throw fault('RUN_NOT_FOUND', 'Run not found.');
      }
      if (record.schemaVersion !== 1 || record.run_id !== id || !record.params || typeof record.input_hash !== 'string') throw fault('STORE_CORRUPT', 'Unsupported or corrupt run record.');
      // Observation is read-only: another process may still own submission.
      // Writing this stale snapshot could race its rename or erase a new receipt.
      // Expose unknown conservatively; only explicit run reconciliation persists
      // later state. A recovered claim never grants a new right to POST.
      if (record.status === 'submitting') record = { ...record, status: 'unknown' };
      return record;
    },
    write: record => atomicWrite(path.join(directory(record.run_id), 'run.json'), encoded(record)),
    writeGraph: (id, graph) => atomicWrite(path.join(directory(id), 'graph.json'), encoded(graph)),
    review: id => json(path.join(directory(id), 'review.json'), true),
    writeReview: (id, review) => atomicWrite(path.join(directory(id), 'review.json'), encoded(review)),
    async recent(limit, include = () => true) {
      let entries;
      try { entries = await readdir(path.join(root, 'runs'), { withFileTypes: true }); }
      catch (e) { if (e.code !== 'ENOENT') throw e; entries = []; }
      const records = [];
      for (const entry of entries) {
        if (!entry.isDirectory() || !UUID.test(entry.name)) continue;
        const value = await json(path.join(directory(entry.name), 'run.json'), true);
        if (value) records.push(value);
      }
      // Claim-only crashes must be discoverable even if the caller never got a
      // response containing the UUID. context() then recovers these via read().
      const known = new Set(records.map(r => r.run_id));
      let claims;
      try { claims = await readdir(path.join(root, 'requests')); }
      catch (e) { if (e.code !== 'ENOENT') throw e; claims = []; }
      for (const name of claims) {
        if (!/^[0-9a-f]{64}\.json$/.test(name)) continue;
        const claim = await json(path.join(root, 'requests', name));
        if (!known.has(claim.run_id)) { records.push(claim); known.add(claim.run_id); }
      }
      records.sort((a, b) => b.created_at.localeCompare(a.created_at) || b.run_id.localeCompare(a.run_id));
      return records.filter(include).slice(0, limit).map(r => r.run_id);
    },
    async claim(requestId, proposed) {
      const target = path.join(root, 'requests', `${hash(requestId)}.json`);
      await mkdir(path.dirname(target), { recursive: true });
      const existing = await json(target, true);
      if (existing) return { owner: false, value: existing };
      // Hard-link an already fsynced complete JSON file: no partial claim can be
      // observed, and unlike rename, link never overwrites an existing claim.
      const temp = `${target}.${randomUUID()}.tmp`;
      await atomicWrite(temp, encoded(proposed));
      try {
        await link(temp, target);
        return { owner: true, value: proposed };
      } catch (e) {
        if (e.code === 'EEXIST') return { owner: false, value: await json(target) };
        throw e;
      } finally { await unlink(temp).catch(e => { if (e.code !== 'ENOENT') throw e; }); }
    },
  };
}
