import z from '@deepseek-ai/schemastery';
import { loadSdk, resolveConfig } from './src/sdk.mjs';
import { registerPreset } from './src/preset.mjs';

export const name = 'moss-draw';
export const inject = ['agentPresets'];
export const Config = z.object({
  workspaceRoot: z.string().required(),
  dataRoot: z.string(),
  comfyUrl: z.string().required(),
  editEngine: z.string(),
});
export async function apply(ctx, config) {
  let resolved;
  try {
    resolved = resolveConfig(config);
  } catch (error) {
    // A package installed without running install/adapt.mjs keeps the shipped
    // placeholders. Say what to do instead of only the bare config code.
    console.error(`[moss-draw] ${error.message}: this install has no local configuration yet. Run "node install/adapt.mjs --plugin-dir <this package> --workspace-root <abs> --comfy-url <origin>" (see README) and restart DSH; the preset cannot load until then.`);
    throw error;
  }
  await registerPreset(ctx, { sdk: loadSdk(), config: resolved });
}
