#!/usr/bin/env node
import {parseArgs} from 'node:util';
import {readFile} from 'node:fs/promises';
import {resolveAgentConfig} from '../src/sdk.mjs';
import {getConnectionDiagnostics} from '../src/connection-diagnostics.mjs';

try {
  const {values}=parseArgs({options:{config:{type:'string'},workspace:{type:'string'},'comfy-url':{type:'string'},mode:{type:'string',multiple:true},help:{type:'boolean'}}});
  if(values.help){console.log('node scripts/check-connection.mjs --workspace <absolute-directory> [--config <trusted-json>] [--comfy-url <origin>] [--mode moss-t2i|moss-edit|k2-t2i|qwen-edit]\nRead-only GET diagnostics. Does not start ComfyUI, install dependencies, download weights or generate images.');}
  else {
    const config=values.config?JSON.parse(await readFile(values.config,'utf8')):{};
    if(values.workspace!==undefined)config.workspaceRoot=values.workspace;
    if(values['comfy-url']!==undefined)config.comfyUrl=values['comfy-url'];
    const resolved=resolveAgentConfig(config,{});
    const result=await getConnectionDiagnostics(resolved,{...(values.mode?{requiredModes:values.mode}:{})});
    console.log(JSON.stringify(result,null,2));process.exitCode=result.ready?0:2;
  }
}catch(error){console.error(JSON.stringify({error:{code:/^MOSS_[A-Z_]+/.exec(error.message??'')?.[0]??'MOSS_DIAGNOSTIC_INPUT',message:'Provide an explicit absolute workspace and valid trusted configuration. Use --help for read-only diagnostics.'}}));process.exitCode=2;}
