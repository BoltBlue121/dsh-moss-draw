#!/usr/bin/env node
// Reproducible packer for the portable plugin tarball.
//
// The npm `files` whitelist is the single source of truth. Runtime files only:
// tests, docs and dev reports never enter the tarball.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const kit = path.resolve(path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
const pluginDir = path.join(kit, 'plugin');
const distDir = path.join(kit, 'dist');
const stageRoot = path.join(kit, '.work', 'package-stage');
const stagePackage = path.join(stageRoot, 'package');
const pkg = JSON.parse(fs.readFileSync(path.join(pluginDir, 'package.json'), 'utf8'));
const archiveName = `dsh-external-dsh-moss-draw-${pkg.version}.tgz`;
const archivePath = path.join(distDir, archiveName);
const sha = buffer => createHash('sha256').update(buffer).digest('hex');

function walk(root) {
  const out = [];
  const stack = [root];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(absolute);
      else if (entry.isFile()) out.push(absolute);
    }
  }
  return out;
}

function expand(entry) {
  if (entry.includes('*')) {
    const dir = path.dirname(entry);
    const pattern = new RegExp(`^${path.basename(entry).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);
    const base = path.join(pluginDir, dir);
    return fs.readdirSync(base, { withFileTypes: true })
      .filter(item => item.isFile() && pattern.test(item.name))
      .map(item => path.join(dir, item.name));
  }
  const absolute = path.join(pluginDir, entry);
  if (!fs.existsSync(absolute)) throw new Error(`files entry does not exist: ${entry}`);
  if (fs.statSync(absolute).isDirectory()) return walk(absolute).map(file => path.relative(pluginDir, file));
  return [entry];
}

const relativeFiles = new Set(['package.json']);
for (const entry of pkg.files) for (const file of expand(entry)) relativeFiles.add(file);
const files = [...relativeFiles].sort();
if (!files.some(file => file === 'host.mjs')) throw new Error('host.mjs missing from package');

fs.rmSync(stageRoot, { recursive: true, force: true });
for (const relative of files) {
  const target = path.join(stagePackage, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(path.join(pluginDir, relative), target);
}
fs.mkdirSync(distDir, { recursive: true });
fs.rmSync(archivePath, { force: true });
execFileSync('tar', ['-czf', archivePath, '-C', stageRoot, 'package'], { stdio: 'inherit' });
const archiveBytes = fs.readFileSync(archivePath);

const manifestFiles = files.map(relative => {
  const content = fs.readFileSync(path.join(pluginDir, relative));
  return { path: `package/${relative.replaceAll('\\', '/')}`, bytes: content.length, sha256: sha(content) };
});
const manifest = {
  schema: 1,
  package: { name: pkg.name, version: pkg.version },
  archive: archiveName,
  bytes: archiveBytes.length,
  sha256: sha(archiveBytes),
  files: manifestFiles,
  generatedAt: new Date().toISOString(),
  note: 'Runtime whitelist only: tests/docs/dev reports are excluded. Hashes are of the staged source files that were packed.',
};
fs.writeFileSync(path.join(distDir, 'package-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
fs.writeFileSync(path.join(distDir, 'SHA256SUMS.txt'), `${manifest.sha256}  ${archiveName}\n`);
console.log(JSON.stringify({ archive: archivePath, bytes: manifest.bytes, sha256: manifest.sha256, files: manifestFiles.length }, null, 2));
