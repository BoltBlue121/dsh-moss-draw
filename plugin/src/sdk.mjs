import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

// Public package resolver only. Package peers admit the exact Host SDK; no copied core.
export function loadSdk(requireSdk = createRequire(import.meta.url)) {
  const get = name => requireSdk(`@deepseek-ai/${name}`);
  const tools = get('dsh-tools'), scope = get('dsh-scope');
  if (typeof tools.defineTool !== 'function' || typeof scope.scopeOf !== 'function') throw new Error('MOSS_SDK_CAPABILITY');
  return { tools, scope, pluginUrl: name => pathToFileURL(requireSdk.resolve(`@deepseek-ai/${name}`)).href };
}
export function resolveConfig(input) {
  if (!input || typeof input.workspaceRoot !== 'string' || !path.isAbsolute(input.workspaceRoot)) throw new Error('MOSS_CONFIG_WORKSPACE');
  const workspaceRoot = path.resolve(input.workspaceRoot);
  const dataRoot = input.dataRoot ?? path.join(workspaceRoot, 'private', 'workspace', 'moss-draw');
  if (typeof dataRoot !== 'string' || !path.isAbsolute(dataRoot)) throw new Error('MOSS_CONFIG_DATA_ROOT');
  let url;
  try { url = new URL(input.comfyUrl); } catch { throw new Error('MOSS_CONFIG_COMFY_URL'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('MOSS_CONFIG_COMFY_URL');
  const editEngine = input.editEngine === undefined ? 'native' : input.editEngine;
  if (!['native','legacy'].includes(editEngine)) throw new Error('MOSS_CONFIG_EDIT_ENGINE');
  return { workspaceRoot, dataRoot: path.resolve(dataRoot), comfyUrl: url.origin, editEngine };
}
