import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Deliberately tiny fixed-module packer: no package install, runtime transpiler,
// eval, or duplicate React/SDK. Only the explicit dependency-free ESM allowlist.
const root=new URL('../',import.meta.url);
const files=['src/workbench-query-contract.mjs','src/workbench-camera.mjs','src/studio-camera.mjs','src/studio-shared.mjs','src/studio-scene.mjs','src/studio-domain.mjs','src/studio-body.mjs','client/studio-layout.mjs','client/studio-director-ops.mjs','client/studio-preferences.mjs','client/model.mjs','client/view.mjs','client/studio-reference.mjs','client/studio-consent.mjs','client/studio-model.mjs','client/studio-observer-view.mjs','client/studio-camera-view.mjs','client/studio-scene-panel.mjs','client/studio-series-view.mjs','client/studio-reference-view.mjs','client/studio-preview.mjs','client/studio-archive-view.mjs','client/studio-diff.mjs','client/studio-diff-view.mjs','client/studio-proposal.mjs','client/studio-snap.mjs','client/studio-task-view.mjs','client/studio-view.mjs','client/session-models.mjs','client/workspace-view.mjs','client/studio-navigation.mjs','client/entry.mjs'];
const known=new Set(files),chunks=[];
for(const file of files){
 let source=await fs.readFile(new URL(file,root),'utf8');
 source=source.replace(/^import\s+\{([^}]+)\}\s+from\s+['"]([^'"]+)['"];?\s*$/gm,(_all,names,spec)=>{
  const target=path.posix.normalize(path.posix.join(path.posix.dirname(file),spec));
  if(!known.has(target))throw Error(`Unapproved client import ${target}`);
  return `const {${names}}=modules[${JSON.stringify(target)}];`;
 });
 if(/^\s*import\s/m.test(source))throw Error(`Unsupported import in ${file}`);
 const exports=[...source.matchAll(/^export\s+(?:async\s+)?(?:function|const|let|class)\s+([A-Za-z_$][\w$]*)/gm)].map(match=>match[1]);
 if(!exports.length)throw Error(`No explicit exports in ${file}`);
 source=source.replace(/^export\s+/gm,'');
 if(/^\s*export\s/m.test(source))throw Error(`Unsupported export in ${file}`);
 chunks.push(`modules[${JSON.stringify(file)}]=(()=>{\n${source}\nreturn {${exports.join(',')}};\n})();`);
}
const css=(await Promise.all(['client/style.css','client/studio.css','client/studio-director.css','client/workspace.css'].map(file=>fs.readFile(new URL(file,root),'utf8')))).join('\n');
const code=`/* Generated from original AI drawing workbench sources. Do not edit. */\nwindow.__ModuleLoader__.load({id:"@dsh-external/dsh-moss-draw",factory:(require)=>{\nconst React=require('react');const modules=Object.create(null);\n${chunks.join('\n')}\nconst entry=modules['client/entry.mjs'];return {inject:entry.inject,apply(ctx){\nif(typeof document!=='undefined')ctx.effect(()=>{const tag=document.createElement('style');tag.dataset.plugin='@dsh-external/dsh-moss-draw';tag.textContent=${JSON.stringify(css)};document.head.appendChild(tag);return ()=>tag.remove();},'art-workbench: style');\nreturn entry.apply(ctx,React);}};\n}});\n`;
await fs.mkdir(new URL('client/lib/',root),{recursive:true});
await fs.writeFile(new URL('client/lib/client.js',root),code);
await fs.writeFile(new URL('client/lib/style.css',root),css);
console.log(`Built ${fileURLToPath(new URL('client/lib/client.js',root))}: ${Buffer.byteLength(code)} bytes, shared React only.`);
