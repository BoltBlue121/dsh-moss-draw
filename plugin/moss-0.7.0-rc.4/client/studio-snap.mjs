// Independent 2D drag snapping. Caller supplies gesture-start geometry and total pointer delta.
const fail=code=>{throw new Error(code);};
const number=(x,max=1e6)=>typeof x==='number'&&Number.isFinite(x)&&Math.abs(x)<=max;
const clamp=(x,min,max)=>Math.max(min,Math.min(max,x));
export function studioSnapDelta(layout,ids,dx,dy,{zoom=1,disabled=false,tolerancePx=6,axis=null}={}){
 if(!layout||!number(layout.width,16384)||!number(layout.height,16384)||layout.width<=0||layout.height<=0||!Array.isArray(layout.items)||layout.items.length>128||!Array.isArray(ids)||!ids.length||ids.length>128||!ids.every(x=>typeof x==='string')||!number(dx)||!number(dy)||!number(zoom,100)||zoom<=0||!number(tolerancePx,100)||tolerancePx<0||typeof disabled!=='boolean'||![null,'x','y'].includes(axis))fail('STUDIO_SNAP_INPUT');
 const wanted=new Set(ids),seen=new Set();for(const item of layout.items){if(typeof item.id!=='string'||seen.has(item.id)||!Array.isArray(item.bbox)||item.bbox.length!==4||item.bbox.some(n=>!number(n,16384))||item.bbox[2]<=item.bbox[0]||item.bbox[3]<=item.bbox[1])fail('STUDIO_SNAP_INPUT');seen.add(item.id);}
 if([...wanted].some(id=>!seen.has(id)))fail('STUDIO_SNAP_INPUT');const moving=layout.items.filter(i=>wanted.has(i.id));if(moving.some(i=>i.locked))fail('STUDIO_LOCKED');
 const bounds=[Math.min(...moving.map(i=>i.bbox[0])),Math.min(...moving.map(i=>i.bbox[1])),Math.max(...moving.map(i=>i.bbox[2])),Math.max(...moving.map(i=>i.bbox[3]))],others=layout.items.filter(i=>!wanted.has(i.id)&&!i.hidden),tolerance=tolerancePx/zoom;
 if(!Number.isFinite(tolerance))fail('STUDIO_SNAP_INPUT');
 const solve=(dimension,delta)=>{
  if(axis&&(dimension===0?'y':'x')===axis)return{delta:0,guides:[]};
  const limit=dimension===0?layout.width:layout.height,start=bounds[dimension],end=bounds[dimension+2];
  // Oversized groups cannot fit without resizing; leave their rigid movement intact.
  const bounded=end-start<=limit?clamp(delta,-start,limit-end):delta;
  if(disabled)return{delta:bounded,guides:[]};
  const marks=[0,limit/2,limit];for(const other of others){const low=other.bbox[dimension],high=other.bbox[dimension+2];marks.push(low,(low+high)/2,high);}
  const features=[start+bounded,(start+end)/2+bounded,end+bounded];let correction=0,best=Infinity;
  for(const mark of marks)for(const feature of features){const offset=mark-feature,distance=Math.abs(offset);if(distance<=tolerance&&distance<best){if(end-start<=limit&&(start+bounded+offset<-1e-8||end+bounded+offset>limit+1e-8))continue;best=distance;correction=offset;}}
  const guides=best===Infinity?[]:[...new Set(marks.filter(mark=>features.some(value=>Math.abs(mark-value-correction)<1e-6)))].sort((a,b)=>a-b);
  return{delta:bounded+correction,guides};
 };
 const x=solve(0,dx),y=solve(1,dy);return{dx:x.delta,dy:y.delta,guides:{x:x.guides,y:y.guides}};
}
