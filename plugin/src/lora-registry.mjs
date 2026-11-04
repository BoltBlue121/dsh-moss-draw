import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import path from 'node:path';

// A sidecar registry for facts a .safetensors cannot carry: the trigger phrase,
// a recommended strength and a human note. The worker's ComfyUI tells us which
// files exist; this file tells us how to use them. Keeping the two apart means a
// new LoRA is usable immediately (unregistered, no trigger) instead of invisible,
// and a stale entry is reported instead of silently dropped.
export const REGISTRY_FILE = 'lora-registry.json';
export const REGISTRY_VERSION = 1;
export const MAX_ENTRIES = 500;
const MAX_FILE = 300, MAX_TRIGGER = 500, MAX_NOTE = 300;
const KINDS = Object.freeze(['style', 'character', 'concept', 'edit', 'builtin']);

export function registryPath(dataRoot) {
  if (typeof dataRoot !== 'string' || !dataRoot) throw new Error('LORA_REGISTRY_DATA_ROOT');
  return path.join(dataRoot, REGISTRY_FILE);
}

function str(value, max) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

// A registry entry is deliberately forgiving: a hand-edited file must degrade to
// "no trigger" rather than break every generation.
export function normalizeRegistryEntry(value) {
  const raw = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const strength = Number(raw.strength);
  const note = str(raw.note, MAX_NOTE);
  return {
    trigger: str(raw.trigger, MAX_TRIGGER),
    strength: Number.isFinite(strength) && strength >= 0 && strength <= 2 ? strength : 1,
    ...(note ? { note } : {}),
    ...(KINDS.includes(raw.kind) ? { kind: raw.kind } : {}),
    ...(str(raw.updated_at, 40) ? { updated_at: str(raw.updated_at, 40) } : {}),
    ...(str(raw.source, 120) ? { source: str(raw.source, 120) } : {}),
  };
}

export async function readLoraRegistry(dataRoot) {
  const file = registryPath(dataRoot);
  const empty = { schema_version: REGISTRY_VERSION, loras: {} };
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return { ...empty, file, present: false, warnings: [] };
    return { ...empty, file, present: false, warnings: [{ code: 'LORA_REGISTRY_UNREADABLE' }] };
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ...empty, file, present: true, warnings: [{ code: 'LORA_REGISTRY_INVALID_JSON' }] };
  }
  const source = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  const rows = source.loras && typeof source.loras === 'object' && !Array.isArray(source.loras) ? source.loras : {};
  const loras = {};
  const warnings = [];
  for (const [key, value] of Object.entries(rows).slice(0, MAX_ENTRIES)) {
    const file_ = str(key, MAX_FILE);
    if (!file_) { warnings.push({ code: 'LORA_REGISTRY_EMPTY_FILE' }); continue; }
    loras[file_] = normalizeRegistryEntry(value);
  }
  return { schema_version: REGISTRY_VERSION, loras, file, present: true, warnings };
}

// Live worker list + registry = what an agent can actually choose from.
export function mergeLoraCatalog(files, registry) {
  const entries = [];
  const seen = new Set();
  for (const raw of Array.isArray(files) ? files : []) {
    const file = str(raw, MAX_FILE);
    if (!file || seen.has(file)) continue;
    seen.add(file);
    const known = registry?.loras?.[file];
    entries.push({
      file,
      registered: Boolean(known),
      trigger: known?.trigger ?? '',
      strength: known?.strength ?? 1,
      ...(known?.note ? { note: known.note } : {}),
      ...(known?.kind ? { kind: known.kind } : {}),
    });
  }
  entries.sort((a, b) => a.file.localeCompare(b.file));
  const missing = Object.keys(registry?.loras ?? {})
    .filter(file => !seen.has(file))
    .sort((a, b) => a.localeCompare(b))
    .map(file => ({ file, ...normalizeRegistryEntry(registry.loras[file]) }));
  return {
    entries,
    unregistered: entries.filter(entry => !entry.registered).map(entry => entry.file),
    missing,
  };
}

// Atomic replace, so a crash mid-write cannot leave a half registry behind.
export async function writeLoraRegistry(dataRoot, loras) {
  const file = registryPath(dataRoot);
  const body = { schema_version: REGISTRY_VERSION, loras: {} };
  for (const [key, value] of Object.entries(loras ?? {})) {
    const name = str(key, MAX_FILE);
    if (!name) continue;
    body.loras[name] = normalizeRegistryEntry(value);
  }
  await mkdir(dataRoot, { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(body, null, 2)}\n`, 'utf8');
  await rename(tmp, file);
  return { file, count: Object.keys(body.loras).length };
}
