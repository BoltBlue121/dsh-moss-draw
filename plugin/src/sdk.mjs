import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

// Public package resolver only. No copied SDK or implicit install.
export async function loadSdk(requireSdk) {
  // Host ESM module resolution and raw createRequire are not equivalent realms.
  // Keep configuration/CLI imports pure; resolve SDK only when a plugin applies.
  const [tools,scope]=requireSdk
    ? [requireSdk('@deepseek-ai/dsh-tools'),requireSdk('@deepseek-ai/dsh-scope')]
    : await Promise.all([import('@deepseek-ai/dsh-tools'),import('@deepseek-ai/dsh-scope')]);
  if (typeof tools.defineTool !== 'function' || typeof scope.scopeOf !== 'function') throw new Error('MOSS_SDK_CAPABILITY');
  return { tools, scope, pluginUrl: name => requireSdk ? pathToFileURL(requireSdk.resolve(`@deepseek-ai/${name}`)).href : import.meta.resolve(`@deepseek-ai/${name}`) };
}
function absolute(value, code) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || /[\0\r\n"<>|]/.test(value) || /^[a-z]+:\/\//i.test(value)) throw new Error(code);
  return path.resolve(value);
}
/** Normalize trusted install settings; an absent workspace is resolved per Session later. */
export function resolveConfig(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('MOSS_CONFIG_WORKSPACE');
  const workspaceRoot = input.workspaceRoot === undefined ? undefined : absolute(input.workspaceRoot, 'MOSS_CONFIG_WORKSPACE');
  const dataRoot = input.dataRoot === undefined ? workspaceRoot && path.join(workspaceRoot, 'private', 'workspace', 'moss-draw') : absolute(input.dataRoot, 'MOSS_CONFIG_DATA_ROOT');
  let url;
  try { url = new URL(input.comfyUrl === undefined ? 'http://127.0.0.1:8188' : input.comfyUrl); } catch { throw new Error('MOSS_CONFIG_COMFY_URL'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('MOSS_CONFIG_COMFY_URL');
  const editEngine = input.editEngine === undefined ? 'native' : input.editEngine;
  if (!['native', 'legacy'].includes(editEngine)) throw new Error('MOSS_CONFIG_EDIT_ENGINE');
  const workflowMode = input.workflowMode === undefined ? 'layout' : input.workflowMode;
  if (!['layout', 'compat'].includes(workflowMode)) throw new Error('MOSS_CONFIG_WORKFLOW');
  const analysis = {};
  for (const key of ['analysisPython', 'analysisConfig']) {
    if (input[key] === undefined) continue;
    analysis[key] = checkedAnalysis(input[key]);
  }
  // Preserve the operator's existing descriptor. Never search cwd or package ancestors.
  if (dataRoot && (analysis.analysisPython === undefined || analysis.analysisConfig === undefined)) {
    const descriptor = analysisDescriptor(dataRoot);
    for (const [key, field] of [['analysisPython', 'python'], ['analysisConfig', 'config']]) {
      if (analysis[key] !== undefined || typeof descriptor?.[field] !== 'string') continue;
      try { analysis[key] = checkedAnalysis(descriptor[field]); } catch { /* broken descriptor is nonfatal */ }
    }
  }
  return { ...(workspaceRoot ? { workspaceRoot } : {}), ...(dataRoot ? { dataRoot } : {}), comfyUrl: url.origin, editEngine, workflowMode, ...analysis };
}
/** Uses the public workingDirectory.get(Session) contract, never process.cwd/header guesses. */
export function resolveAgentConfig(input = {}, { session, workingDirectory } = {}) {
  const config = resolveConfig(input);
  if (config.workspaceRoot) return config;
  let workspaceRoot;
  try {
    if (!session || typeof workingDirectory?.get !== 'function') throw new Error();
    workspaceRoot = absolute(workingDirectory.get(session), 'MOSS_CONFIG_WORKSPACE');
  } catch { throw new Error('MOSS_CONFIG_WORKSPACE: configure workspaceRoot or provide the trusted Session workingDirectory service.'); }
  return resolveConfig({ ...config, workspaceRoot });
}
function checkedAnalysis(value) {
  const normalized = absolute(value, 'MOSS_CONFIG_ANALYSIS');
  if (/\s+-\S/.test(value)) throw new Error('MOSS_CONFIG_ANALYSIS');
  return normalized;
}
function analysisDescriptor(dataRoot) {
  try {
    const raw = readFileSync(path.join(dataRoot, 'gbc-runtime.json'), 'utf8');
    if (Buffer.byteLength(raw) > 65536) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch { return null; }
}
