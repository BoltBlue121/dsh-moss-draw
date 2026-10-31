import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createDrawingService} from '../src/dispatcher.mjs';
import {registerTools} from '../src/tools.mjs';
import {waitForRun} from '../src/wait.mjs';
import {encodePng,decodePng} from '../src/region-pixels.mjs';

const sha=data=>createHash('sha256').update(data).digest('hex');
const solid=(width,height,color)=>encodePng({width,height,pixels:Buffer.alloc(width*height*4).fill(Buffer.from(color))});

// Real HTTP multipart upload + compiled graph POST + Windows output history +
// artifact download. Only GPU execution is replaced by deterministic pixels.
async function fixture(t,{loseFirstReply=false,holdFirst=false}={}) {
  const workspaceRoot=await mkdtemp(path.join(tmpdir(),'art-regions-http-'));
  const dataRoot=path.join(workspaceRoot,'ledger');await mkdir(dataRoot);
  const uploads=new Map(),posts=[],history={},output=new Map(),serverErrors=[];
  // holdFirst: the worker keeps the first job in queue_running (no history yet)
  // until release(), so a lost-reply child can be observed as live but unfinished.
  let held=null,running=[],offline=false;
  const server=createServer(async(req,res)=>{
    // offline: the host stays silent for every observation (GPU host left the network).
    if(offline&&req.method==='GET'){req.socket.destroy();return;}
    try {
      const url=new URL(req.url,'http://fixture');
      if(req.method==='POST'&&url.pathname==='/upload/image') {
        const parts=[];for await(const part of req)parts.push(part);
        const form=await new Request(url,{method:'POST',headers:req.headers,body:Buffer.concat(parts)}).formData();
        assert.equal(form.get('overwrite'),'false');assert.equal(form.get('type'),'input');
        const file=form.get('image');assert(!uploads.has(file.name),'same child must never upload twice');
        uploads.set(file.name,Buffer.from(await file.arrayBuffer()));
        res.setHeader('content-type','application/json');res.end(JSON.stringify({name:file.name,subfolder:'',type:'input'}));return;
      }
      if(req.method==='POST'&&url.pathname==='/prompt') {
        let text='';for await(const p of req)text+=p;const body=JSON.parse(text),graph=body.prompt,id=body.extra_data.moss_run_id;
        assert(!posts.some(p=>p.id===id),'same child must never POST twice');
        const save=Object.entries(graph).find(([,v])=>v.class_type==='SaveImage'&&v.inputs.filename_prefix===`moss_draw/${id}/native`);
        assert(save,'native output must be bound to this run');
        const node=Object.values(graph).find(v=>v.class_type==='MossImageEdit'),isMoss=!!node;
        const width=isMoss?node.inputs.width:graph['8'].inputs.width,height=isMoss?node.inputs.height:graph['8'].inputs.height;
        let bytes;
        if(isMoss) {
          assert.equal(graph['1'].class_type,'MossImageEditLoader');
          assert(!Object.values(graph).some(v=>String(v.class_type).includes('Style')),'portable package has no style loader node');
          assert.deepEqual(node.inputs.model,['1',0]);
          assert.match(node.inputs.prompt,/^Retain the scene\.\nReference 1 is the scene crop\./);
          const assigned=uploads.get(graph[node.inputs.reference_2[0]].inputs.image);assert(assigned);
          const pixel=decodePng(assigned).pixels.subarray(0,4);bytes=solid(width,height,pixel);
          if(posts.length===1) {
            // The second crop uses the first committed canvas, not the overlay or
            // original base. Its overlapping left border contains reference 1.
            const crop=decodePng(uploads.get(graph[node.inputs.reference_1[0]].inputs.image));
            assert(crop.pixels.includes(201),'next crop should include first region result');
          }
        } else {
          const previous=uploads.get(graph['4'].inputs.image);assert(previous);
          const before=decodePng(previous);assert.deepEqual([...before.pixels.subarray(0,4)],[42,173,66,255]);
          assert.match(graph['6'].inputs.prompt,/边缘/);bytes=solid(width,height,[48,180,72,255]);
        }
        const promptId=`http-fixture-${posts.length+1}`;
        posts.push({id,graph,kind:isMoss?'moss':'qwen'});output.set(`moss_draw/${id}`,bytes);
        const entry={prompt:[posts.length,promptId,graph,{...body.extra_data,client_id:body.client_id},[save[0]]],status:{status_str:'success',completed:true,messages:[]},outputs:{[save[0]]:{images:[{filename:'native_00001_.png',subfolder:`moss_draw\\${id}`,type:'output'}]}}};
        if(holdFirst&&posts.length===1){held=[promptId,entry];running=[entry.prompt];}else history[promptId]=entry;
        if(loseFirstReply&&posts.length===1){req.socket.destroy();return;}
        res.setHeader('content-type','application/json');res.end(JSON.stringify({prompt_id:promptId,number:posts.length,node_errors:{}}));return;
      }
      if(url.pathname==='/history'){res.setHeader('content-type','application/json');res.end(JSON.stringify(history));return;}
      if(url.pathname.startsWith('/history/')){const id=url.pathname.split('/').at(-1);res.setHeader('content-type','application/json');res.end(JSON.stringify(history[id]?{[id]:history[id]}:{}));return;}
      if(url.pathname==='/queue'){res.setHeader('content-type','application/json');res.end(JSON.stringify({queue_running:running,queue_pending:[]}));return;}
      if(url.pathname==='/view'){const data=output.get(url.searchParams.get('subfolder'));assert(data);res.setHeader('content-type','image/png');res.end(data);return;}
      throw Error('Unexpected fixture route '+url.pathname);
    }catch(e){serverErrors.push(e);res.writeHead(500);res.end('fixture error');}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await rm(workspaceRoot,{recursive:true,force:true});});
  const comfyUrl=`http://127.0.0.1:${server.address().port}`;
  const base=solid(512,320,[13,22,35,127]),ref1=solid(256,256,[201,36,51,255]),ref2=solid(256,256,[42,173,66,255]);
  const files=[];for(const [name,data]of [['canvas.png',base],['one.png',ref1],['two.png',ref2]]){const file=path.join(workspaceRoot,name);await writeFile(file,data);files.push(file);}
  const definitions=new Map(),savedFiles=[],images=[];
  const attachments={saveImage:async({data})=>{images.push(Buffer.from(data));const {width,height}=decodePng(data);return {id:sha(data),width,height,mediaType:'image/png'};},saveFile:async({data,name})=>{savedFiles.push({data:Buffer.from(data),name});return {id:sha(data),name};},imageHostPath:ref=>ref.hostPath};
  const exec={agent:{session:{deriveMessages:()=>[{source:{kind:'user'},content:files.map(hostPath=>({type:'image',attachment:{hostPath}}))}]}},signal:new AbortController().signal};
  let service;
  const mount=()=>{service=createDrawingService({dataRoot,comfyUrl,editEngine:'legacy'});registerTools({tools:{register:d=>definitions.set(d.name,d)}},{sdk:{tools:{defineTool:x=>x}},service,readGuide:async()=>({}),config:{workspaceRoot,dataRoot},attachments});return service;};
  const call=(name,args)=>definitions.get(name).execute(args,exec);
  const release=()=>{if(held){history[held[0]]=held[1];held=null;}running=[];};
  return {dataRoot,base,ref1,ref2,files,uploads,posts,serverErrors,savedFiles,images,definitions,exec,mount,call,release,setOffline:value=>{offline=value;}};
}

for(const loseFirstReply of [false,true])test(`two-region HTTP workflow reaches protected delivery, lost first POST reply=${loseFirstReply}`,async t=>{
  const f=await fixture(t,{loseFirstReply});let service=f.mount();
  const regions=[{id:'one',box:[20,20,260,295],reference_index:1,prompt:'Use assigned character one.',style:'none',lora_strength:0,seed:120,context_px:24,feather_px:0},
    {id:'two',box:[240,20,492,295],reference_index:2,prompt:'Use assigned character two.',style:'none',lora_strength:0,seed:121,context_px:24,feather_px:0,qwen_prompt:'仅整理边缘，保留角色设计。'}];
  const p=await f.call('art_generate',{mode:'regions',action:'draft',request_id:'http-regions-v1',prompt:'Retain the scene.',references:f.files,regions});
  assert.equal(p.status,'draft');assert.equal(f.posts.length,0);assert.equal(f.uploads.size,0);
  await f.call('art_view',{run_id:p.run_id,variant:'preview'});assert.equal(f.posts.length,0);assert.equal(f.uploads.size,0);
  await f.call('art_generate',{mode:'regions',action:'execute',plan_id:p.run_id});
  const started=await service.run({run_id:p.run_id});assert.equal(started.status,loseFirstReply?'unknown':'running');assert.equal(f.posts.length,1);
  // Construct new service/tools while preserving disk records: no hidden memory
  // from the first instance is required to resume the original child.
  service=f.mount();
  const done=await waitForRun(service,{run_id:p.run_id},{intervalMs:1,timeoutMs:5000});
  if(f.serverErrors.length)throw f.serverErrors[0];
  assert.equal(done.status,'succeeded',JSON.stringify(done));assert.deepEqual(f.posts.map(x=>x.kind),['moss','moss','qwen']);assert.equal(f.uploads.size,5);
  const raw=await readFile(done.artifact.path),actual=decodePng(raw),base=decodePng(f.base);
  let protectedPixels=0;for(let y=0;y<320;y++)for(let x=0;x<512;x++)if(!regions.some(r=>x>=r.box[0]&&x<r.box[2]&&y>=r.box[1]&&y<r.box[3])){const i=(y*512+x)*4;assert.deepEqual(actual.pixels.subarray(i,i+4),base.pixels.subarray(i,i+4));protectedPixels++;}
  assert(protectedPixels>0);assert.equal(done.protection.outside_changed_pixels,0);
  assert.deepEqual([...actual.pixels.subarray((100*512+80)*4,(100*512+80)*4+4)],[201,36,51,255]);
  assert.deepEqual([...actual.pixels.subarray((100*512+400)*4,(100*512+400)*4+4)],[48,180,72,255]);
  for(const post of f.posts){const c=(await service.context({run_id:post.id})).runs[0];assert.equal(c.pipeline_run_id,p.run_id);}
  assert.deepEqual((await service.context({})).runs.map(r=>r.run_id),[p.run_id]);
  await f.call('art_view',{run_id:p.run_id,variant:'result'});
  await f.call('art_review',{run_id:p.run_id,observations:['Synthetic pixel/transport check only.'],issues:[],next_change:''});
  const receipt=await f.call('art_deliver',{run_id:p.run_id});assert.equal(receipt.sha256,sha(raw));assert.deepEqual(f.savedFiles[0].data,raw);assert.match(receipt.markdown_link,/侧边栏/);assert.equal(f.posts.length,3);
  const projected=f.definitions.get('art_deliver').projectContent(f.exec,{isError:false});assert.deepEqual(projected.map(x=>x.type),['text','file','image']);
  assert.equal((await service.context({run_id:p.run_id})).runs[0].review.observations[0],'Synthetic pixel/transport check only.');
});

// A parent error must describe the child's latest observation. A stale lost-reply
// error on a live child would make a healthy wait look like an offline worker;
// a fresh child NETWORK_UNKNOWN must reach the wait loop so it can stop early.
test('regions parent mirrors its live child: no stale lost-reply error, early stop while the worker is silent',async t=>{
  const f=await fixture(t,{loseFirstReply:true,holdFirst:true});const service=f.mount();
  const regions=[{id:'one',box:[20,20,260,295],reference_index:1,prompt:'Use assigned character one.',style:'none',lora_strength:0,seed:120,context_px:24,feather_px:0},
    {id:'two',box:[240,20,492,295],reference_index:2,prompt:'Use assigned character two.',style:'none',lora_strength:0,seed:121,context_px:24,feather_px:0,qwen_prompt:'仅整理边缘，保留角色设计。'}];
  const p=await f.call('art_generate',{mode:'regions',action:'draft',request_id:'http-regions-stale-error',prompt:'Retain the scene.',references:f.files,regions});
  await f.call('art_view',{run_id:p.run_id,variant:'preview'});
  await f.call('art_generate',{mode:'regions',action:'execute',plan_id:p.run_id});
  const lost=await service.run({run_id:p.run_id});assert.equal(lost.status,'unknown');assert.ok(lost.error,'lost POST reply is reported');
  const live=await service.run({run_id:p.run_id});
  assert.equal(live.status,'running');assert.equal(live.error,undefined,'child was observed running; the old lost-reply error is stale');
  f.setOffline(true);
  const silent=await waitForRun(service,{run_id:p.run_id},{intervalMs:1,timeoutMs:5000,unreachableMs:50});
  assert.equal(silent.worker_unreachable,true);assert.equal(silent.status,'running');assert.equal(silent.error.code,'NETWORK_UNKNOWN');
  assert.equal(f.posts.length,1,'no stage is resubmitted while the worker is silent');
  f.setOffline(false);f.release();
  const done=await waitForRun(service,{run_id:p.run_id},{intervalMs:1,timeoutMs:5000});
  if(f.serverErrors.length)throw f.serverErrors[0];
  assert.equal(done.status,'succeeded',JSON.stringify(done));assert.deepEqual(f.posts.map(x=>x.kind),['moss','moss','qwen']);
});
