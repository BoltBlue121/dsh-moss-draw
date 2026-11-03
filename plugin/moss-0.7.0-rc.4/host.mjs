import z from '@deepseek-ai/schemastery';
import { loadSdk, resolveConfig } from './src/sdk.mjs';
import { registerPreset } from './src/preset.mjs';

export const name = 'moss-draw';
export const inject = ['agentPresets'];
export const Config = z.object({
  workspaceRoot: z.string(),
  dataRoot: z.string(),
  comfyUrl: z.string(),
  editEngine: z.string(),
  workflowMode: z.string(),
  analysisPython: z.string(),
  analysisConfig: z.string(),
});
export async function apply(ctx, config) {
  await registerPreset(ctx, { sdk: await loadSdk(), config: resolveConfig(config) });
}
