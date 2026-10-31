#!/usr/bin/env node
// Write deployment-owned values into the plugin's own cordis.patch.yml.
//
// The portable package ships placeholders only. This tool is deliberately dumb:
// it substitutes three placeholders, validates the values, and refuses to guess
// when the file is already adapted to different values.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PLACEHOLDERS = Object.freeze({
  workspaceRoot: '__MOSS_WORKSPACE_ROOT__',
  comfyUrl: '__MOSS_COMFY_URL__',
  dataRoot: '__MOSS_DATA_ROOT__',
});

function parseArgs(argv) {
  const args = { json: false, dryRun: false, allowMissingWorkspace: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) throw new Error(`Missing value for ${arg}`);
      i += 1;
      return value;
    };
    switch (arg) {
      case '--plugin-dir': args.pluginDir = next(); break;
      case '--workspace-root': args.workspaceRoot = next(); break;
      case '--comfy-url': args.comfyUrl = next(); break;
      case '--data-root': args.dataRoot = next(); break;
      case '--receipt': args.receipt = next(); break;
      case '--allow-missing-workspace': args.allowMissingWorkspace = true; break;
      case '--dry-run': args.dryRun = true; break;
      case '--json': args.json = true; break;
      case '--help':
        console.log('adapt.mjs --plugin-dir <dir> --workspace-root <absolute dir> --comfy-url <http://host:port> [--data-root <absolute dir>] [--receipt <file>] [--allow-missing-workspace] [--dry-run] [--json]');
        process.exit(0);
        break;
      default: throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

export function validateConfig({ workspaceRoot, comfyUrl, dataRoot, allowMissingWorkspace = false }) {
  if (typeof workspaceRoot !== 'string' || !path.isAbsolute(workspaceRoot)) throw new Error('workspaceRoot must be an absolute path (MOSS_CONFIG_WORKSPACE).');
  const resolvedWorkspace = path.resolve(workspaceRoot);
  if (!allowMissingWorkspace && !fs.existsSync(resolvedWorkspace)) throw new Error(`workspaceRoot does not exist: ${resolvedWorkspace}. Create it, or pass --allow-missing-workspace if the drive is mounted later.`);
  let url;
  try { url = new URL(comfyUrl); } catch { throw new Error('comfyUrl is not a URL (MOSS_CONFIG_COMFY_URL).'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('comfyUrl must be a bare http(s) origin such as http://127.0.0.1:8188 (MOSS_CONFIG_COMFY_URL).');
  }
  const resolvedDataRoot = path.resolve(dataRoot ?? path.join(resolvedWorkspace, 'private', 'workspace', 'moss-draw'));
  if (!path.isAbsolute(resolvedDataRoot)) throw new Error('dataRoot must be absolute (MOSS_CONFIG_DATA_ROOT).');
  return Object.freeze({ workspaceRoot: resolvedWorkspace, comfyUrl: url.origin, dataRoot: resolvedDataRoot });
}

// The YAML template already wraps each placeholder in single quotes, so the
// substitution only needs to escape the value itself (YAML doubles quotes).
const yamlValue = value => String(value).replace(/'/g, "''");

export function adapt({ pluginDir, workspaceRoot, comfyUrl, dataRoot, allowMissingWorkspace = false, dryRun = false }) {
  if (!pluginDir) throw new Error('--plugin-dir is required.');
  const root = path.resolve(pluginDir);
  const patchFile = path.join(root, 'cordis.patch.yml');
  const packageFile = path.join(root, 'package.json');
  if (!fs.existsSync(packageFile)) throw new Error(`Not a plugin directory (package.json missing): ${root}`);
  if (!fs.existsSync(patchFile)) throw new Error(`cordis.patch.yml missing: ${patchFile}`);
  const pkg = JSON.parse(fs.readFileSync(packageFile, 'utf8'));
  if (pkg.name !== '@dsh-external/dsh-moss-draw') throw new Error(`Unexpected package name: ${pkg.name}`);
  const config = validateConfig({ workspaceRoot, comfyUrl, dataRoot, allowMissingWorkspace });
  const before = fs.readFileSync(patchFile, 'utf8');
  const replacements = {
    [PLACEHOLDERS.workspaceRoot]: yamlValue(config.workspaceRoot),
    [PLACEHOLDERS.comfyUrl]: yamlValue(config.comfyUrl),
    [PLACEHOLDERS.dataRoot]: yamlValue(config.dataRoot),
  };
  const found = Object.keys(PLACEHOLDERS).filter(key => before.includes(PLACEHOLDERS[key]));
  let after = before;
  for (const [placeholder, value] of Object.entries(replacements)) after = after.split(placeholder).join(value);
  const leftover = Object.values(PLACEHOLDERS).filter(placeholder => after.includes(placeholder));
  if (leftover.length) throw new Error(`Placeholders were not fully substituted: ${leftover.join(', ')}`);
  if (!found.length && !dryRun) {
    throw new Error('cordis.patch.yml has no __MOSS_*__ placeholders; it was already adapted. Re-copy the pristine plugin/ to adapt again.');
  }
  const changed = after !== before;
  if (!dryRun && changed) fs.writeFileSync(patchFile, after);
  const receipt = {
    schema: 1,
    action: 'adapt',
    pluginDir: root,
    packageName: pkg.name,
    packageVersion: pkg.version,
    dryRun,
    changed,
    placeholdersReplaced: found.map(key => PLACEHOLDERS[key]),
    config,
    adaptedAt: new Date().toISOString(),
  };
  return { receipt, config };
}

function main() {
  let args;
  try { args = parseArgs(process.argv.slice(2)); }
  catch (error) { console.error(`adapt: ${error.message}`); process.exit(1); }
  try {
    const { receipt, config } = adapt(args);
    if (args.receipt) {
      fs.mkdirSync(path.dirname(path.resolve(args.receipt)), { recursive: true });
      fs.writeFileSync(path.resolve(args.receipt), `${JSON.stringify(receipt, null, 2)}\n`);
    }
    if (args.json) console.log(JSON.stringify(receipt, null, 2));
    else {
      console.log(`plugin: ${receipt.pluginDir} (${receipt.packageName}@${receipt.packageVersion})`);
      console.log(`workspaceRoot: ${config.workspaceRoot}`);
      console.log(`comfyUrl: ${config.comfyUrl}`);
      console.log(`dataRoot: ${config.dataRoot}`);
      console.log(receipt.dryRun ? 'dry-run: cordis.patch.yml was not modified' : receipt.changed ? 'cordis.patch.yml updated' : 'cordis.patch.yml unchanged');
    }
  } catch (error) {
    console.error(`adapt: ${error.message}`);
    process.exit(1);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
