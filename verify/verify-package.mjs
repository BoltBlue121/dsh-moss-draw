#!/usr/bin/env node
// Verify the packed tarball against dist/package-manifest.json and SHA256SUMS.txt.
// If an extracted tree is supplied it is compared file by file, so a tarball that
// silently drops or mutates a runtime file fails here instead of after install.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const kit = path.resolve(path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) throw new Error(`Missing value for ${arg}`);
      i += 1;
      return value;
    };
    switch (arg) {
      case '--kit': args.kit = next(); break;
      case '--tgz': args.tgz = next(); break;
      case '--extract': args.extract = next(); break;
      case '--manifest': args.manifest = next(); break;
      case '--out': args.out = next(); break;
      default: throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}
const args = parseArgs(process.argv.slice(2));
const root = path.resolve(args.kit ?? kit);
const distDir = path.join(root, 'dist');
const manifestFile = path.resolve(args.manifest ?? path.join(distDir, 'package-manifest.json'));
const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
const tgz = path.resolve(args.tgz ?? path.join(distDir, manifest.archive));
const sha = buffer => createHash('sha256').update(buffer).digest('hex');

function walk(dir) {
  const out = [];
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(absolute);
      else if (entry.isFile()) out.push(absolute);
    }
  }
  return out.map(file => path.relative(dir, file).replaceAll('\\', '/')).sort();
}

if (!fs.existsSync(tgz)) throw new Error(`tarball not found: ${tgz}`);
const archiveBytes = fs.readFileSync(tgz);
const report = {
  schema: 1,
  tgz,
  archive: { bytes: archiveBytes.length, sha256: sha(archiveBytes) },
  manifest: { file: manifestFile, package: manifest.package, files: manifest.files.length },
  checks: { archiveBytes: archiveBytes.length === manifest.bytes, archiveSha256: sha(archiveBytes) === manifest.sha256 },
};
const sumsFile = path.join(distDir, 'SHA256SUMS.txt');
if (fs.existsSync(sumsFile)) {
  const [sumsSha] = fs.readFileSync(sumsFile, 'utf8').trim().split(/\s+/);
  report.checks.sha256Sums = sumsSha === report.archive.sha256;
}
if (args.extract) {
  const extractDir = path.resolve(args.extract);
  if (!fs.existsSync(extractDir)) throw new Error(`extracted tree not found: ${extractDir}`);
  const expected = new Map(manifest.files.map(entry => [entry.path.replaceAll('\\', '/'), entry]));
  const actual = walk(extractDir);
  const mismatches = [];
  for (const relative of actual) {
    const entry = expected.get(relative);
    if (!entry) { mismatches.push({ path: relative, issue: 'unexpected-file' }); continue; }
    const content = fs.readFileSync(path.join(extractDir, relative));
    if (content.length !== entry.bytes) mismatches.push({ path: relative, issue: 'bytes', expected: entry.bytes, actual: content.length });
    else if (sha(content) !== entry.sha256) mismatches.push({ path: relative, issue: 'sha256' });
  }
  for (const [relative] of expected) if (!actual.includes(relative)) mismatches.push({ path: relative, issue: 'missing-file' });
  report.extracted = { dir: extractDir, files: actual.length, expected: expected.size };
  report.checks.extractedFiles = actual.length === expected.size && mismatches.length === 0;
  report.mismatches = mismatches.slice(0, 50);
}
report.pass = Object.values(report.checks).every(Boolean) && (report.mismatches?.length ?? 0) === 0;
if (args.out) {
  fs.mkdirSync(path.dirname(path.resolve(args.out)), { recursive: true });
  fs.writeFileSync(path.resolve(args.out), `${JSON.stringify(report, null, 2)}\n`);
}
console.log(JSON.stringify(report, null, 2));
if (!report.pass) process.exit(1);
