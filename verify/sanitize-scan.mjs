#!/usr/bin/env node
// Personal-data / private-asset scanner for the portable kit.
//
// Exit 1 on any hit. Intentional examples such as 127.0.0.1 or localhost are not
// flagged; real Tailscale/private LAN addresses, user drive paths, private LoRA
// names, provider names and story/character names are.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TEXT_EXTENSIONS = new Set(['.mjs', '.js', '.cjs', '.json', '.md', '.css', '.py', '.yml', '.yaml', '.txt', '.ps1', '.ts']);
const SKIP_DIRS = new Set(['.git', 'node_modules', '.verify-work', 'verification', 'dist', '.work']);

// Detection terms are base64-encoded so this scanner never ships the private
// names it looks for; decode them at runtime.
const decodeMarker = value => Buffer.from(value, 'base64').toString('utf8');
const PRIVATE_PROVIDERS = ['b3JjYXJvdXRlcg=='];
const PRIVATE_STYLES = ['a2llZWQ=', 'bW9kYXJl', 'Znltcmll', 'ZGxzczU='];
const PRIVATE_STORY = ['5Y2h6I6y', '6a2U5aWz', '5Zyj5aWz', '5L+u5aWz', '6YWS6aaG6aKE6K6+', '5Y+M5Lq65Lmm5oi/'];

const PATTERNS = Object.freeze([
  { id: 'windows-user-path', regex: /(?:^|[^A-Za-z0-9_])(?:[A-Za-z]:[\\/](?:Users|agent|ComfyUI|Program|dsh|DSH)[^\\/\r\n]*)/g },
  { id: 'posix-user-path', regex: /\/Users\/[A-Za-z0-9._-]+/g },
  { id: 'tailscale-cgnat', regex: /(?:^|[^\d.])100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}(?![\d.])/g },
  { id: 'private-lan-ip', regex: /(?:^|[^\d.])(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})(?![\d.])/g },
  { id: 'personal-provider', regex: new RegExp(PRIVATE_PROVIDERS.map(decodeMarker).join('|'), 'gi') },
  { id: 'private-style-lora', regex: new RegExp(PRIVATE_STYLES.map(decodeMarker).join('|'), 'gi') },
  { id: 'personal-story-name', regex: new RegExp(PRIVATE_STORY.map(decodeMarker).join('|'), 'g') },
  { id: 'credential-material', regex: /(?:api[_-]?key\s*[:=]\s*['"][A-Za-z0-9]{8,}|sk-[A-Za-z0-9]{12,}|bearer\s+[A-Za-z0-9._-]{12,}|BEGIN [A-Z ]*PRIVATE KEY)/gi },
  { id: 'personal-mail-domain', regex: /[A-Za-z0-9._%+-]+@(?:gmail|outlook|qq|163|126|foxmail|hotmail)\./gi },
]);

function parseArgs(argv) {
  const args = { json: true };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) throw new Error(`Missing value for ${arg}`);
      i += 1;
      return value;
    };
    switch (arg) {
      case '--dir': args.dir = next(); break;
      case '--out': args.out = next(); break;
      case '--json': args.json = true; break;
      case '--help':
        console.log('sanitize-scan.mjs --dir <kit>/plugin [--out <file>] [--json]');
        process.exit(0);
        break;
      default: throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const kit = path.resolve(path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
const dir = path.resolve(args.dir ?? path.join(kit, 'plugin'));
if (!fs.existsSync(dir)) {
  console.error(`sanitize-scan: directory not found: ${dir}`);
  process.exit(3);
}

function walk(root) {
  const files = [];
  const stack = [root];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) stack.push(absolute);
      } else if (entry.isFile() && TEXT_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        files.push(absolute);
      }
    }
  }
  return files.sort();
}

const hits = [];
const files = walk(dir);
for (const file of files) {
  const relative = path.relative(dir, file).replaceAll('\\', '/');
  const text = fs.readFileSync(file, 'utf8');
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    for (const pattern of PATTERNS) {
      pattern.regex.lastIndex = 0;
      if (!pattern.regex.test(lines[index])) continue;
      pattern.regex.lastIndex = 0;
      const match = pattern.regex.exec(lines[index]);
      hits.push({
        file: relative,
        line: index + 1,
        pattern: pattern.id,
        match: match ? match[0].trim() : '',
        excerpt: lines[index].trim().slice(0, 200),
      });
    }
  }
}

const report = {
  schema: 1,
  dir,
  scannedFiles: files.length,
  patterns: PATTERNS.map(pattern => pattern.id),
  hits: hits.slice(0, 200),
  hitCount: hits.length,
  pass: hits.length === 0,
};
if (args.out) {
  fs.mkdirSync(path.dirname(path.resolve(args.out)), { recursive: true });
  fs.writeFileSync(path.resolve(args.out), `${JSON.stringify(report, null, 2)}\n`);
}
if (args.json) console.log(JSON.stringify({ pass: report.pass, scannedFiles: files.length, hitCount: hits.length, hits: report.hits.slice(0, 20) }, null, 2));
if (!report.pass) {
  console.error(`sanitize-scan: ${hits.length} hit(s) in ${dir}`);
  process.exit(1);
}
