#!/usr/bin/env node
// Deployment probe for the portable AI drawing workbench plugin.
//
// This file must run under the official Desktop Electron binary in Node mode,
// because the DSH runtime packages live inside resources/app.asar and a plain
// system Node cannot read that archive. install/install.ps1 sets
// ELECTRON_RUN_AS_NODE=1 and passes this file to "DeepSeek Harness.exe".
//
// Exit codes: 0 supported, 2 unsupported DSH version (unless
// --allow-unverified-version), 1 probe failure.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

export const VERIFIED_DSH_VERSIONS = Object.freeze(['0.2.1-rc.2', '0.2.1-rc.3', '0.2.1-rc.5']);
const SDK_PACKAGES = [
  'cordis', 'schemastery',
  'dsh-tools', 'dsh-scope', 'dsh-persona', 'dsh-agent-preset-registry',
  'dsh-attachment', 'dsh-session', 'dsh-system-prompt', 'dsh-commands',
  'dsh-typert-protocol', 'dsh-typert-registry',
];

function parseArgs(argv) {
  const args = { allowUnverifiedVersion: false, json: false, warnings: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) throw new Error(`Missing value for ${arg}`);
      i += 1;
      return value;
    };
    switch (arg) {
      case '--desktop-dir': args.desktopDir = next(); break;
      case '--dsh-home': args.dshHome = next(); break;
      case '--profile': args.profile = next(); break;
      case '--out': args.out = next(); break;
      case '--allow-unverified-version': args.allowUnverifiedVersion = true; break;
      case '--json': args.json = true; break;
      case '--help':
        console.log('probe.mjs --desktop-dir <dir> [--dsh-home <dir>] [--profile desktop] [--allow-unverified-version] [--json] [--out <file>]');
        process.exit(0);
        break;
      default: throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

function defaultDesktopDir() {
  const localAppData = process.env.LOCALAPPDATA;
  if (localAppData) return path.join(localAppData, 'Programs', 'DeepSeek Harness');
  return undefined;
}

function readJsonFile(file, label) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`${label} is not readable JSON: ${file} (${error.message})`);
  }
}

function requireAsarJson(requireFrom, specifier) {
  try {
    return createRequire(requireFrom)(specifier);
  } catch (error) {
    return { error: error.message };
  }
}

export function probe({ desktopDir, dshHome, profile = 'desktop', allowUnverifiedVersion = false }) {
  const result = {
    schema: 1,
    createdAt: new Date().toISOString(),
    host: { platform: process.platform, arch: process.arch, node: process.version, electron: process.versions.electron ?? null },
    desktopDir,
    dshHome: dshHome ?? null,
    profile,
    verifiedDshVersions: [...VERIFIED_DSH_VERSIONS],
    supported: false,
    checks: {},
    warnings: [],
  };
  if (!desktopDir) throw new Error('Desktop directory is unknown; pass --desktop-dir or set LOCALAPPDATA.');
  result.desktopDir = path.resolve(desktopDir);
  const exe = path.join(result.desktopDir, 'DeepSeek Harness.exe');
  if (!fs.existsSync(exe)) throw new Error(`Desktop executable not found: ${exe}`);
  result.checks.desktopExecutable = exe;

  const asarPackage = path.join(result.desktopDir, 'resources', 'app.asar', 'dsh', 'package.json');
  result.checks.asarPackage = asarPackage;
  const dshPackage = requireAsarJson(asarPackage, './package.json');
  if (dshPackage.error) throw new Error(`Cannot read the DSH package from app.asar (${dshPackage.error}). Run this probe with "DeepSeek Harness.exe" and ELECTRON_RUN_AS_NODE=1, not with system node.`);
  result.dshPackage = { name: dshPackage.name, version: dshPackage.version };
  result.sdk = {};
  for (const name of SDK_PACKAGES) {
    const pkg = requireAsarJson(asarPackage, `@deepseek-ai/${name}/package.json`);
    result.sdk[`@deepseek-ai/${name}`] = pkg.error ? { error: pkg.error } : pkg.version;
  }
  result.checks.sdkResolved = Object.values(result.sdk).every(value => typeof value === 'string');

  const runtimeVersions = path.join(result.desktopDir, 'resources', 'runtime', 'versions.json');
  if (fs.existsSync(runtimeVersions)) {
    try { result.bundledRuntime = readJsonFile(runtimeVersions, 'resources/runtime/versions.json'); }
    catch (error) { result.warnings.push(error.message); }
  }
  const nodeMajor = Number(String(process.versions.node).split('.')[0]);
  result.checks.node24 = nodeMajor === 24;
  if (!result.checks.node24) result.warnings.push(`Node runtime is ${process.version}; the plugin engines require node >=24 <25.`);

  if (dshHome) {
    const home = path.resolve(dshHome);
    result.dshHome = home;
    const profileDir = path.join(home, 'profiles', profile);
    result.checks.profileDir = profileDir;
    result.checks.profileExists = fs.existsSync(path.join(profileDir, 'package.json'));
    if (!result.checks.profileExists) {
      result.warnings.push(`Profile package.json not found: ${path.join(profileDir, 'package.json')}`);
    } else {
      try {
        const profilePackage = readJsonFile(path.join(profileDir, 'package.json'), 'profile package.json');
        const dependency = profilePackage.dependencies?.['@dsh-external/dsh-moss-draw'] ?? null;
        const bundles = profilePackage.dsh?.profile?.bundles ?? [];
        result.profile = {
          name: profile,
          pluginDependency: dependency,
          pluginBundleListed: bundles.includes('@dsh-external/dsh-moss-draw'),
          installedVersion: null,
        };
        const linkedPackage = path.join(profileDir, 'node_modules', '@dsh-external', 'dsh-moss-draw', 'package.json');
        if (fs.existsSync(linkedPackage)) {
          result.profile.installedVersion = readJsonFile(linkedPackage, 'linked plugin package.json').version;
        }
      } catch (error) {
        result.warnings.push(error.message);
      }
    }
  }

  result.supported = VERIFIED_DSH_VERSIONS.includes(dshPackage.version);
  result.decision = result.supported ? 'supported' : allowUnverifiedVersion ? 'unverified-override' : 'refused';
  if (!result.supported && !allowUnverifiedVersion) {
    result.warnings.push(
      `DSH ${dshPackage.version} is outside the verified matrix ${VERIFIED_DSH_VERSIONS.join(' / ')}. ` +
      'Run the cold-load acceptance before claiming compatibility, or pass --allow-unverified-version knowingly.',
    );
  }
  return result;
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`probe: ${error.message}`);
    process.exit(1);
  }
  let result;
  try {
    result = probe({
      desktopDir: args.desktopDir ?? process.env.DSH_DESKTOP_DIR ?? defaultDesktopDir(),
      dshHome: args.dshHome ?? process.env.DSH_HOME,
      profile: args.profile ?? 'desktop',
      allowUnverifiedVersion: args.allowUnverifiedVersion,
    });
  } catch (error) {
    const failure = { schema: 1, ok: false, error: error.message, node: process.version, electron: process.versions.electron ?? null };
    if (args?.out) fs.writeFileSync(args.out, `${JSON.stringify(failure, null, 2)}\n`);
    console.error(`probe: ${error.message}`);
    process.exit(1);
  }
  const text = `${JSON.stringify(result, null, 2)}\n`;
  if (args.out) fs.writeFileSync(args.out, text);
  if (args.json) process.stdout.write(text);
  else {
    console.log(`DSH ${result.dshPackage.version} | node ${result.host.node} | electron ${result.host.electron ?? 'n/a'} | SDK ${result.checks.sdkResolved ? 'resolved' : 'missing'}`);
    console.log(`verified matrix: ${VERIFIED_DSH_VERSIONS.join(' / ')} -> ${result.supported ? 'SUPPORTED' : 'UNVERIFIED'}`);
    console.log(`decision: ${result.decision}`);
    if (result.profile) console.log(`profile ${result.profile.name}: dependency=${result.profile.pluginDependency ?? 'none'} bundle=${result.profile.pluginBundleListed} installed=${result.profile.installedVersion ?? 'none'}`);
    for (const warning of result.warnings) console.log(`warning: ${warning}`);
  }
  process.exit(result.supported || args.allowUnverifiedVersion ? 0 : 2);
}

main();
