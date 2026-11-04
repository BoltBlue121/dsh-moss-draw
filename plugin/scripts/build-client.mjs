import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Deliberately tiny fixed-module packer: no package install, runtime transpiler,
// eval, or duplicate React/SDK. Only the explicit dependency-free ESM allowlist.
const root=new URL('../',import.meta.url);
const files=['src/catalog.mjs','src/workbench-query-contract.mjs','src/workbench-camera.mjs','src/studio-geometry.mjs','src/studio-doc-version.mjs','src/studio-camera.mjs','src/studio-rig.mjs','src/studio-composition.mjs','src/studio-annotations.mjs','src/studio-shape-render.mjs','src/studio-restore-contract.mjs','src/studio-shared.mjs','src/studio-scene.mjs','src/studio-domain.mjs','src/studio-body.mjs','src/studio-shape-exact.mjs','src/studio-shape-ops.mjs','src/studio-layout-ops.mjs','src/studio-shape-knife.mjs','src/studio-page-assist.mjs','src/studio-panel-ops.mjs','src/studio-annotation-ops.mjs','src/studio-edit.mjs','src/studio-exchange.mjs','client/studio-layout.mjs','client/studio-director-ops.mjs','client/studio-preferences.mjs','client/studio-session-image.mjs','client/model.mjs','client/view.mjs','client/studio-artwork.mjs','client/studio-reference.mjs','client/studio-consent.mjs','client/studio-model.mjs','client/studio-observer-view.mjs','client/studio-rig-view.mjs','client/studio-camera-view.mjs','client/studio-scene-panel.mjs','client/studio-series-view.mjs','client/studio-exchange-view.mjs','client/studio-reference-view.mjs','client/studio-preview.mjs','client/studio-archive-view.mjs','client/studio-diff.mjs','client/studio-diff-view.mjs','client/studio-proposal.mjs','client/studio-snap.mjs','client/studio-task-view.mjs','client/studio-annotation-view.mjs','client/studio-panel-view.mjs','client/studio-view.mjs','client/session-models.mjs','client/workspace-view.mjs','client/studio-navigation.mjs','client/entry.mjs'];
const loaded=new Set(),chunks=[];
for(const file of files){
 let source=await fs.readFile(new URL(file,root),'utf8');
 const exports=[];
 source=source.replace(/^(import|export)[ \t]+\{([\w$,\s]+)\}[ \t]+from[ \t]+(['"])(\.\.?\/[^'"\r\n]+)\3;?[ \t]*\r?$/gm,(_all,kind,names,_quote,spec)=>{
  const target=path.posix.normalize(path.posix.join(path.posix.dirname(file),spec));
  if(!loaded.has(target))throw Error(`Missing or unordered client dependency ${target} in ${file}`);
  if(kind==='export'&&/[\r\n]/.test(names))throw Error(`Unsupported multiline re-export in ${file}`);
  const bindings=names.trim().replace(/,$/,'').split(',').map(name=>name.trim());
  if(!bindings.every(name=>/^[A-Za-z_$][\w$]*$/.test(name)))throw Error(`Unsupported binding in ${file}`);
  if(kind==='export')exports.push(...bindings);
  return `const {${names}}=modules[${JSON.stringify(target)}];`;
 });
 if(/^\s*import\s/m.test(source))throw Error(`Unsupported import in ${file}`);
 source=source.replace(/^export[ \t]+((?:async[ \t]+)?(?:function|const|let|class)[ \t]+([A-Za-z_$][\w$]*))/gm,(_all,declaration,name)=>{
  exports.push(name);
  return declaration;
 });
 if(!exports.length)throw Error(`No explicit exports in ${file}`);
 if(/^\s*export\s/m.test(source))throw Error(`Unsupported export in ${file}`);
 chunks.push(`modules[${JSON.stringify(file)}]=(()=>{\n${source}\nreturn {${exports.join(',')}};\n})();`);
 loaded.add(file);
}
const css=(await Promise.all(['client/style.css','client/studio.css','client/studio-director.css','client/workspace.css'].map(file=>fs.readFile(new URL(file,root),'utf8')))).join('\n');
const code=`/* Generated from original AI drawing workbench sources. Do not edit. */\nwindow.__ModuleLoader__.load({id:"@dsh-external/dsh-moss-draw",factory:(require)=>{\nconst React=require('react');const modules=Object.create(null);\n${chunks.join('\n')}\nconst entry=modules['client/entry.mjs'];return {inject:entry.inject,apply(ctx){\nif(typeof document!=='undefined')ctx.effect(()=>{const tag=document.createElement('style');tag.dataset.plugin='@dsh-external/dsh-moss-draw';tag.textContent=${JSON.stringify(css)};document.head.appendChild(tag);return ()=>tag.remove();},'art-workbench: style');\nreturn entry.apply(ctx,React);}};\n}});\n`;
await fs.mkdir(new URL('client/lib/',root),{recursive:true});
await fs.writeFile(new URL('client/lib/client.js',root),code);
await fs.writeFile(new URL('client/lib/style.css',root),css);
console.log(`Built ${fileURLToPath(new URL('client/lib/client.js',root))}: ${Buffer.byteLength(code)} bytes, shared React only.`);
