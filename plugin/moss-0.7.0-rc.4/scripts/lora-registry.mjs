#!/usr/bin/env node
// Maintain the LoRA sidecar registry: the trigger word and recommended strength
// that a .safetensors cannot carry. Supply the operator's actual configured data root:
//   node scripts/lora-registry.mjs list --data-root <absolute-directory>
//   node scripts/lora-registry.mjs set example.safetensors --trigger "example" --strength 1 --data-root <absolute-directory>
//   node scripts/lora-registry.mjs remove <file> --data-root <absolute-directory>
//   node scripts/lora-registry.mjs sync --comfy-url http://127.0.0.1:8188 --data-root <absolute-directory>
// MOSS_DRAW_DATA_ROOT is an explicit alternative; never infer it from cwd/install location.
import { parseArgs } from 'node:util';
import path from 'node:path';
import { readLoraRegistry, writeLoraRegistry, mergeLoraCatalog, registryPath } from '../src/lora-registry.mjs';

const DEFAULT_DATA_ROOT = process.env.MOSS_DRAW_DATA_ROOT;

function usage(message) {
  if (message) console.error(message);
  console.error('usage: lora-registry.mjs <list|set|remove|sync> [args] [--data-root DIR]');
  process.exit(message ? 2 : 0);
}

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    'data-root': { type: 'string' },
    trigger: { type: 'string' },
    strength: { type: 'string' },
    note: { type: 'string' },
    kind: { type: 'string' },
    'comfy-url': { type: 'string' },
  },
});
const requestedRoot = values['data-root'] ?? DEFAULT_DATA_ROOT;
if (typeof requestedRoot !== 'string' || !path.isAbsolute(requestedRoot) || /[\0\r\n]/.test(requestedRoot)) usage('An explicit absolute --data-root or MOSS_DRAW_DATA_ROOT is required.');
const dataRoot = path.resolve(requestedRoot);
const [command, target] = positionals;

if (command === 'list') {
  const registry = await readLoraRegistry(dataRoot);
  console.log(JSON.stringify({ file: registry.file, present: registry.present, entries: registry.loras, warnings: registry.warnings }, null, 2));
} else if (command === 'set') {
  if (!target) usage('set needs a LoRA file name');
  const registry = await readLoraRegistry(dataRoot);
  const next = { ...registry.loras };
  const entry = { ...(next[target] ?? {}) };
  if (values.trigger !== undefined) entry.trigger = values.trigger;
  if (values.strength !== undefined) entry.strength = Number(values.strength);
  if (values.note !== undefined) entry.note = values.note;
  if (values.kind !== undefined) entry.kind = values.kind;
  entry.updated_at = new Date().toISOString();
  entry.source = 'cli';
  next[target] = entry;
  const result = await writeLoraRegistry(dataRoot, next);
  console.log(JSON.stringify({ ...result, entry: next[target] }, null, 2));
} else if (command === 'remove') {
  if (!target) usage('remove needs a LoRA file name');
  const registry = await readLoraRegistry(dataRoot);
  if (!registry.loras[target]) usage(`not registered: ${target}`);
  const next = { ...registry.loras };
  delete next[target];
  console.log(JSON.stringify(await writeLoraRegistry(dataRoot, next), null, 2));
} else if (command === 'sync') {
  const url = values['comfy-url'];
  if (!url) usage('sync needs --comfy-url');
  const { createService } = await import('../src/core.mjs');
  const service = createService({ dataRoot, comfyUrl: url });
  const view = await service.context({ lora_catalog: true });
  console.log(JSON.stringify(view, null, 2));
} else {
  usage(command ? `unknown command: ${command}` : undefined);
}
