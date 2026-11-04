import {studioCameraMoved} from '../src/studio-camera.mjs';
import {projectStudioComposition,hasStudioRig} from '../src/studio-composition.mjs';
import {studioAnnotationPrimitives,studioRigPrimitives,studioProjectedAnnotationLayout} from '../src/studio-annotations.mjs';
import {paintStudioPrimitives} from './studio-artwork.mjs';
import {studioShapeCameraBlocked,STUDIO_SHAPE_CAMERA_MESSAGE} from '../src/studio-shape-render.mjs';
// Local user-selected raster files only. No URL fetching or Host filesystem access.
const MAX_BYTES=32*1024*1024;
const fail=message=>{throw new Error(`STUDIO_REFERENCE: ${message}`);};
const bound=(w,h)=>{if(!Number.isSafeInteger(w)||!Number.isSafeInteger(h)||w<1||h<1||w>4096||h>4096||w*h>16777216)fail('Image dimension limit is 4096 × 4096.');};
const ascii=(b,p,n)=>String.fromCharCode(...b.slice(p,p+n));
export function readStudioImageHeader(input){
 if(!(input instanceof Uint8Array)||input.length<12||input.length>MAX_BYTES)fail('Invalid image bytes/size.');const b=input,v=new DataView(b.buffer,b.byteOffset,b.byteLength);let width,height,mediaType;
 if(b.length>=33&&[137,80,78,71,13,10,26,10].every((x,i)=>b[i]===x)&&ascii(b,12,4)==='IHDR'&&v.getUint32(8)===13){width=v.getUint32(16);height=v.getUint32(20);mediaType='image/png';}
 else if(b[0]===255&&b[1]===216){
  let p=2;while(p+3<b.length&&p<524288){if(b[p++]!==255)fail('Malformed JPEG header.');while(b[p]===255)p++;const marker=b[p++];if(marker===217||marker===218)break;if(marker===216||marker===1||marker>=208&&marker<=215)continue;if(p+2>b.length)break;const length=v.getUint16(p);if(length<2||p+length>b.length)fail('Malformed JPEG segment.');if([192,193,194,195,197,198,199,201,202,203,205,206,207].includes(marker)){if(length<8)fail('Malformed JPEG dimensions.');height=v.getUint16(p+3);width=v.getUint16(p+5);mediaType='image/jpeg';break;}p+=length;}
 }else if(ascii(b,0,4)==='RIFF'&&ascii(b,8,4)==='WEBP'){
  const codec=ascii(b,12,4);mediaType='image/webp';
  if(codec==='VP8X'&&b.length>=30){width=1+b[24]+b[25]*256+b[26]*65536;height=1+b[27]+b[28]*256+b[29]*65536;}
  else if(codec==='VP8L'&&b.length>=25&&b[20]===47){const bits=v.getUint32(21,true);width=(bits&16383)+1;height=((bits>>>14)&16383)+1;}
  else if(codec==='VP8 '&&b.length>=30&&b[23]===157&&b[24]===1&&b[25]===42){width=v.getUint16(26,true)&16383;height=v.getUint16(28,true)&16383;}
 }
 if(!mediaType||width===undefined)fail('Unsupported image format/header. Use PNG, JPEG or WebP.');bound(width,height);return{width,height,mediaType};
}
export function referenceTransform(sourceWidth,sourceHeight,width,height,fit='contain'){
 bound(sourceWidth,sourceHeight);bound(width,height);if(!['contain','cover','stretch'].includes(fit))fail('Invalid image fit.');
 if(fit==='stretch')return{sx:0,sy:0,sw:sourceWidth,sh:sourceHeight,dx:0,dy:0,dw:width,dh:height,scaleX:width/sourceWidth,scaleY:height/sourceHeight,offsetX:0,offsetY:0};
 const scale=(fit==='contain'?Math.min:Math.max)(width/sourceWidth,height/sourceHeight);
 if(fit==='contain'){const dw=sourceWidth*scale,dh=sourceHeight*scale,dx=(width-dw)/2,dy=(height-dh)/2;return{sx:0,sy:0,sw:sourceWidth,sh:sourceHeight,dx,dy,dw,dh,scaleX:scale,scaleY:scale,offsetX:dx,offsetY:dy};}
 const sw=width/scale,sh=height/scale,sx=(sourceWidth-sw)/2,sy=(sourceHeight-sh)/2;return{sx,sy,sw,sh,dx:0,dy:0,dw:width,dh:height,scaleX:scale,scaleY:scale,offsetX:-sx*scale,offsetY:-sy*scale};
}
export function mapReferenceItems(items,sw,sh,width,height,fit='contain'){
 if(!Array.isArray(items)||items.length>128)fail('Invalid reference boxes.');const t=referenceTransform(sw,sh,width,height,fit);
 return items.map(item=>{if(!Array.isArray(item.bbox)||item.bbox.length!==4||item.bbox.some(n=>!Number.isFinite(n)))fail('Invalid bbox.');const b=item.bbox.map((n,i)=>n*(i%2?t.scaleY:t.scaleX)+(i%2?t.offsetY:t.offsetX)),c=b.map((n,i)=>Math.max(0,Math.min(i%2?height:width,n)));
  const visible=c[2]>c[0]&&c[3]>c[1];return{...structuredClone(item),bbox:visible?c:[Math.max(0,Math.min(width-1,c[0])),Math.max(0,Math.min(height-1,c[1])),Math.max(1,Math.min(width,c[0]+1)),Math.max(1,Math.min(height,c[1]+1))],hidden:!!item.hidden||!visible};
 });
}
const canvasBlob=canvas=>typeof canvas.convertToBlob==='function'?canvas.convertToBlob({type:'image/png'}):new Promise((resolve,reject)=>canvas.toBlob(blob=>blob?resolve(blob):reject(Error('PNG encoding failed')),'image/png'));
export async function prepareStudioReference(file,env={}){
 if(!file||!Number.isSafeInteger(file.size)||file.size<12||file.size>MAX_BYTES||typeof file.arrayBuffer!=='function')fail('Choose an image file up to 32 MiB.');
 const bytes=new Uint8Array(await file.arrayBuffer());if(bytes.length!==file.size)fail('File size changed.');const header=readStudioImageHeader(bytes);
 const decode=env.decode??(blob=>globalThis.createImageBitmap(blob)),createCanvas=env.createCanvas??(()=>document.createElement('canvas')),createUrl=env.createUrl??(blob=>URL.createObjectURL(blob));
 let bitmap;try{bitmap=await decode(new Blob([bytes],{type:header.mediaType}));bound(bitmap.width,bitmap.height);const scale=Math.min(1,2048/Math.max(bitmap.width,bitmap.height)),width=Math.max(1,Math.round(bitmap.width*scale)),height=Math.max(1,Math.round(bitmap.height*scale)),canvas=createCanvas();canvas.width=width;canvas.height=height;const g=canvas.getContext('2d');if(!g)fail('Canvas unavailable.');g.fillStyle='#fff';g.fillRect(0,0,width,height);g.drawImage(bitmap,0,0,width,height);const blob=await canvasBlob(canvas);if(blob.size>MAX_BYTES)fail('Prepared image too large.');const sha256=[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(x=>x.toString(16).padStart(2,'0')).join('');const name=String(file.name||'reference').replace(/[\x00-\x1f<>:"/\\|?*]/g,'_').slice(0,150);
  return{url:createUrl(blob),blob,width,height,sourceWidth:bitmap.width,sourceHeight:bitmap.height,name,sha256,mediaType:'image/png'};
 }finally{bitmap?.close?.();}
}
export async function exportStudioAnnotation(reference,layout,{fit='contain',labels=true,selectedOnly=false,selected=[]}={},env={}){
 const createCanvas=env.createCanvas??(()=>document.createElement('canvas')),decode=env.decode??(blob=>createImageBitmap(blob));
 if(reference&&!reference.blob)fail('No local reference image.');
 if(studioShapeCameraBlocked({kind:'layout',schema_version:2,layout}))fail(STUDIO_SHAPE_CAMERA_MESSAGE);
 const projection=studioCameraMoved(layout)||hasStudioRig(layout)?projectStudioComposition(layout):null;
 const displayed=studioProjectedAnnotationLayout(layout,projection),byId=new Map(displayed.items.map(i=>[i.id,i]));
 const items=projection?projection.order.map(id=>byId.get(id)):displayed.items;
 let bitmap;
 try{
  const canvas=createCanvas();canvas.width=layout.width;canvas.height=layout.height;
  const g=canvas.getContext('2d');g.fillStyle='#fff';g.fillRect(0,0,canvas.width,canvas.height);
  if(reference){
    const t=referenceTransform(reference.width,reference.height,layout.width,layout.height,fit);
    bitmap=await decode(reference.blob);g.drawImage(bitmap,t.sx,t.sy,t.sw,t.sh,t.dx,t.dy,t.dw,t.dh);
  }
  const size=Math.max(14,Math.round(Math.max(canvas.width,canvas.height)/60));
  g.font=`600 ${size}px system-ui,sans-serif`;g.textBaseline='top';g.lineWidth=Math.max(2,Math.round(size/7));
  const palette=['#2563eb','#dc2626','#059669','#7c3aed','#b45309'];let index=0;
  for(const item of items){
    if(item.hidden||selectedOnly&&!selected.includes(item.id))continue;
    const primitives=[...studioAnnotationPrimitives(displayed,item),...studioRigPrimitives(projection?.rigs,item.id)];
    if(item.bubble||item.sketch||primitives.length){paintStudioPrimitives(g,primitives);continue;}
    const [x,y,r,b]=item.bbox.map((n,i)=>Math.max(0,Math.min(i%2?canvas.height:canvas.width,n)));
    if(r<=x||b<=y)continue;
    const color=palette[index%palette.length];index++;g.strokeStyle=color;
    if(item.shape){g.beginPath();item.shape.ring.forEach(([px,py],i)=>i?g.lineTo(px,py):g.moveTo(px,py));g.closePath();g.stroke();}
    else g.strokeRect(x,y,r-x,b-y);
    const label=labels?`${index} ${item.name||item.label}`:String(index),tw=Math.min(canvas.width-x,g.measureText(label).width+10),top=Math.max(0,y-size-7);
    g.fillStyle=color;g.fillRect(x,top,tw,size+5);g.fillStyle='#fff';g.fillText(label,x+4,top+2,Math.max(1,tw-8));
  }
  return await canvasBlob(canvas);
 }finally{bitmap?.close?.();}
}
