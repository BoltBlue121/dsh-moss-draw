/** Pure generated 2D operations. No document ownership, identity or persistence. */
import {studioRational,studioRatAdd,studioRatSub,studioRatMul,studioRatDiv,studioRatNeg,studioRatCmp,studioRoundHalfEven,studioLatticeRing,quantizeStudioPolygon} from './studio-shape-exact.mjs';

export const STUDIO_SHAPE_OPS_ERROR_CODES=Object.freeze(['STUDIO_SHAPE_RAW_INVALID','STUDIO_SHAPE_CONSTRAINT']);
const [RAW,CONSTRAINT]=STUDIO_SHAPE_OPS_ERROR_CODES;
const INVALID='STUDIO_INVALID_INPUT',RANGE='STUDIO_SHAPE_RANGE',BUDGET='STUDIO_SHAPE_BUDGET';
const R=studioRational,add=studioRatAdd,sub=studioRatSub,mul=studioRatMul;
const GRID=1024,LIMIT=16777216n;
const min=(a,b)=>a<b?a:b,max=(a,b)=>a>b?a:b;

function fail(code,reason,path='ring'){
  const error=new TypeError(`Studio shape operation: ${reason}`);
  error.code=code;error.path=path;error.reason=reason;throw error;
}
function pathValue(value){
  if(typeof value!=='string'||!value.length||value.length>160||/[\x00-\x1f\x7f-\x9f]/.test(value))fail(INVALID,'path','path');
  return value;
}
function own(value,key,path){
  const d=Object.getOwnPropertyDescriptor(value,key);
  if(!d||!d.enumerable||!Object.hasOwn(d,'value'))fail(INVALID,'structure',path);
  return d.value;
}
function record(value,allowed,required,path){
  if(value===null||typeof value!=='object'||Array.isArray(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value)))fail(INVALID,'structure',path);
  const copy=Object.create(null);
  for(const key of Reflect.ownKeys(value)){
    if(typeof key!=='string'||!allowed.includes(key))fail(INVALID,'unknown_field',path);
    copy[key]=own(value,key,path);
  }
  for(const key of required)if(!Object.hasOwn(copy,key))fail(INVALID,'structure',path);
  return copy;
}
function options(value,extra=[]){
  const result=record(value,['path',...extra],[],'options');
  result.path=pathValue(Object.hasOwn(result,'path')?result.path:'ring');
  return result;
}
function arrayLength(value,path){
  if(!Array.isArray(value))fail(INVALID,'structure',path);
  const d=Object.getOwnPropertyDescriptor(value,'length');
  if(!d||!Object.hasOwn(d,'value')||!Number.isSafeInteger(d.value)||d.value<0)fail(INVALID,'structure',path);
  return d.value;
}
function dense(value,low,high,path){
  const length=arrayLength(value,path);
  if(length>high)fail(BUDGET,'point_budget',path);
  if(length<low||Reflect.ownKeys(value).length!==length+1)fail(INVALID,'structure',path);
  const result=[];for(let i=0;i<length;i++)result.push(own(value,String(i),path));
  return result;
}
function fixed(value,count,path){
  if(arrayLength(value,path)!==count)fail(INVALID,'structure',path);
  return dense(value,count,count,path);
}
function finite(value,path){
  if(typeof value!=='number')fail(INVALID,'type',path);
  if(!Number.isFinite(value))fail(INVALID,'unsupported_number',path);
  return value;
}
function binary(value,unitShift){
  const view=new DataView(new ArrayBuffer(8));view.setFloat64(0,value,false);
  const bits=view.getBigUint64(0,false),negative=(bits>>63n)!==0n;
  const exponent=Number((bits>>52n)&2047n),fraction=bits&((1n<<52n)-1n);
  const mantissa=exponent?fraction+(1n<<52n):fraction;
  const power=(exponent?exponent-1075:-1074)+unitShift,n=negative?-mantissa:mantissa;
  return power>=0?R(n<<BigInt(power)):R(n,1n<<BigInt(-power));
}
function coordinate(value,path,bound=16384,reason='coordinate_range'){
  finite(value,path);if(Math.abs(value)>bound)fail(RANGE,reason,path);
  return binary(value,10);
}
export function studioGridRationalFromPx(value){return coordinate(value,'coordinate');}
export function studioGridRationalFromDeltaPx(value){return coordinate(value,'delta',32768,'delta_range');}
function point(value,path){return fixed(value,2,path).map(x=>coordinate(x,path));}
function inputPoints(value,path){return dense(value,3,128,path).map(p=>point(p,path));}
function rationalPoints(lattice){return lattice.map(p=>p.map(x=>R(x)));}

// All generated raw coordinates have power-of-two denominators.
function commonPoints(points,path){
  let denominator=1n;
  for(const p of points)for(const r of p)if(r.d>denominator)denominator=r.d;
  if(denominator>=(1n<<4096n))fail(BUDGET,'bit_budget',path);
  return points.map(p=>p.map(r=>r.n*(denominator/r.d)));
}
const same=(a,b)=>a[0]===b[0]&&a[1]===b[1];
const cross=(a,b,c)=>(b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]);
function onSegment(a,b,p){
  return cross(a,b,p)===0n&&p[0]>=min(a[0],b[0])&&p[0]<=max(a[0],b[0])&&p[1]>=min(a[1],b[1])&&p[1]<=max(a[1],b[1]);
}
function meet(a,b,c,d){
  if(max(a[0],b[0])<min(c[0],d[0])||max(c[0],d[0])<min(a[0],b[0])||max(a[1],b[1])<min(c[1],d[1])||max(c[1],d[1])<min(a[1],b[1]))return false;
  const u=cross(a,b,c),v=cross(a,b,d),s=cross(c,d,a),t=cross(c,d,b);
  if(u===0n&&onSegment(a,b,c)||v===0n&&onSegment(a,b,d)||s===0n&&onSegment(c,d,a)||t===0n&&onSegment(c,d,b))return true;
  return (u>0n&&v<0n||u<0n&&v>0n)&&(s>0n&&t<0n||s<0n&&t>0n);
}
function rawSimple(points,path){
  const p=commonPoints(points,path),n=p.length;
  if(same(p[0],p[n-1]))fail(RAW,'closing_duplicate',path);
  for(let i=1;i<n;i++)if(same(p[i-1],p[i]))fail(RAW,'duplicate_vertex',path);
  for(let i=0;i<n;i++){
    const a=p[(i+n-1)%n],b=p[i],c=p[(i+1)%n];
    if(cross(a,b,c)===0n&&(b[0]-a[0])*(c[0]-b[0])+(b[1]-a[1])*(c[1]-b[1])<0n)fail(RAW,'reversal',path);
  }
  for(let i=0;i<n;i++)for(let j=i+1;j<n;j++){
    if(j===i+1||i===0&&j===n-1)continue;
    if(meet(p[i],p[(i+1)%n],p[j],p[(j+1)%n]))fail(RAW,'edge_contact',path);
  }
  let area=0n;
  for(let i=0;i<n;i++)area+=p[i][0]*p[(i+1)%n][1]-p[(i+1)%n][0]*p[i][1];
  if(area===0n)fail(RAW,'zero_area',path);
  return p;
}
function convexQuad(points){
  if(points.length!==4)return false;
  let positive;
  for(let i=0;i<4;i++){
    const turn=cross(points[i],points[(i+1)%4],points[(i+2)%4]);
    if(turn===0n)return false;
    if(i===0)positive=turn>0n;else if((turn>0n)!==positive)return false;
  }
  return true;
}
function requireQuad(points,path,reason='quad_not_convex'){
  if(!convexQuad(points))fail(CONSTRAINT,reason,path);
}
function rejectMerge(points,path){
  const rounded=points.map(p=>p.map(r=>studioRoundHalfEven(r)));
  for(let i=0;i<rounded.length;i++)if(same(rounded[i],rounded[(i+1)%rounded.length]))fail(CONSTRAINT,'vertex_merge',path);
}
function bboxOf(points){
  let [left,top]=points[0],right=left,bottom=top;
  for(const [x,y] of points){left=min(left,x);top=min(top,y);right=max(right,x);bottom=max(bottom,y);}
  return [left,top,right,bottom].map(x=>Number(x)/GRID);
}
function finish(points,op,path,inputCount,extra={},quad=false,noMerge=false){
  if(noMerge)rejectMerge(points,path);
  let q;
  try{q=quantizeStudioPolygon(points,{path});}
  catch(error){
    if(quad&&['STUDIO_SHAPE_QUANTIZE_DEGENERATE','STUDIO_SHAPE_QUANTIZE_INVALID'].includes(error.code))fail(CONSTRAINT,'quad_quantize',path);
    throw error;
  }
  if(quad)requireQuad(q.lattice,path,'quad_quantize');
  return {ring:q.ring,bbox:bboxOf(q.lattice),lattice:q.lattice,report:{
    report_version:1,op,grid:'1/1024',rounding:'half-even',input_vertices:inputCount,output_vertices:q.ring.length,
    twice_area_exact:q.twice_area_exact,twice_area_grid:q.twice_area_grid,max_component_shift:q.max_component_shift,
    merged_vertices:q.merged_vertices,...extra,
  }};
}
export function createStudioPolygon(value,opt={}){
  const {path}=options(opt),points=inputPoints(value,path);rawSimple(points,path);
  return finish(points,'create_polygon',path,points.length);
}
export function createStudioQuad(value,opt={}){
  const {path}=options(opt),count=arrayLength(value,path);
  if(count>128)fail(BUDGET,'point_budget',path);
  if(count!==4)fail(CONSTRAINT,'quad_not_convex',path);
  const points=inputPoints(value,path);requireQuad(rawSimple(points,path),path);
  return finish(points,'create_quad',path,4,{},true,true);
}
export function moveStudioShapeVertex(origin,index,toPx,opt={}){
  const settings=options(opt,['constraint']),{path}=settings;
  if(!Object.hasOwn(settings,'constraint'))fail(INVALID,'missing_constraint',path);
  if(!['none','quad'].includes(settings.constraint))fail(INVALID,'constraint_value',path);
  const lattice=studioLatticeRing(origin,path).points,quad=settings.constraint==='quad';
  if(quad)requireQuad(lattice,path);
  if(!Number.isSafeInteger(index))fail(INVALID,'unsupported_number',path);
  if(index<0||index>=lattice.length)fail(RANGE,'index_range',path);
  const points=rationalPoints(lattice);points[index]=point(toPx,path);
  const raw=rawSimple(points,path);if(quad)requireQuad(raw,path);
  return finish(points,'move_vertex',path,lattice.length,{vertex_index:index,constraint:settings.constraint},quad,true);
}
export function translateStudioShape(origin,delta,opt={}){
  const {path}=options(opt),lattice=studioLatticeRing(origin,path).points;
  const requested=fixed(delta,2,path).map(x=>coordinate(x,path,32768,'delta_range'));
  const applied=requested.map(x=>studioRoundHalfEven(x));
  const points=lattice.map(([x,y])=>[R(x+applied[0]),R(y+applied[1])]);
  return finish(points,'translate',path,lattice.length,{
    requested_delta:requested,applied_delta:applied,delta_shift:applied.map((x,i)=>sub(R(x),requested[i])),
  });
}
export function scaleStudioShape(origin,parameters,opt={}){
  const {path}=options(opt),lattice=studioLatticeRing(origin,path).points;
  const args=record(parameters,['pivot','scale'],['pivot','scale'],path),pivot=point(args.pivot,path);
  const values=fixed(args.scale,2,path).map(x=>{
    finite(x,path);if(Math.abs(x)<2**-16||Math.abs(x)>2**16)fail(RANGE,'scale_range',path);return x;
  });
  const factors=values.map(x=>binary(x,0));
  const points=lattice.map(p=>p.map((x,i)=>add(pivot[i],mul(sub(R(x),pivot[i]),factors[i]))));
  return finish(points,'scale',path,lattice.length,{pivot,scale:factors,mirrored:(values[0]<0)!==(values[1]<0)});
}
export function rotateStudioShape(origin,parameters,opt={}){
  const {path}=options(opt),lattice=studioLatticeRing(origin,path).points;
  const args=record(parameters,['pivot','quarter_turns','radians'],['pivot'],path);
  const hasQuarter=Object.hasOwn(args,'quarter_turns'),hasRadians=Object.hasOwn(args,'radians');
  if(hasQuarter===hasRadians)fail(INVALID,'structure',path);
  const pivot=point(args.pivot,path);
  if(hasQuarter){
    if(!Number.isSafeInteger(args.quarter_turns))fail(INVALID,'unsupported_number',path);
    const turns=((args.quarter_turns%4)+4)%4,appliedPivot=pivot.map(x=>studioRoundHalfEven(x));
    const points=lattice.map(p=>{
      const x=p[0]-appliedPivot[0],y=p[1]-appliedPivot[1];
      if(turns===1)return [appliedPivot[0] - y, appliedPivot[1] + x];
      if(turns===2)return [appliedPivot[0]-x,appliedPivot[1]-y];
      if(turns===3)return [appliedPivot[0]+y,appliedPivot[1]-x];
      return [p[0],p[1]];
    });
    return finish(rationalPoints(points),'rotate',path,lattice.length,{
      method:'quarter_exact',quarter_turns:turns,requested_pivot:pivot,applied_pivot:appliedPivot,
      pivot_shift:appliedPivot.map((x,i)=>sub(R(x),pivot[i])),
    });
  }
  const angle=finite(args.radians,path);if(Math.abs(angle)>64)fail(RANGE,'angle_range',path);
  const cosine=Math.cos(angle),sine=Math.sin(angle),c=binary(cosine,0),s=binary(sine,0);
  const points=lattice.map(p=>{
    const x=sub(R(p[0]),pivot[0]),y=sub(R(p[1]),pivot[1]);
    return [add(pivot[0],sub(mul(c,x),mul(s,y))),add(pivot[1],add(mul(s,x),mul(c,y)))];
  });
  return finish(points,'rotate',path,lattice.length,{method:'trig_approx',radians:binary(angle,0),pivot,cos_approx:cosine,sin_approx:sine});
}
export function alignStudioRectToGrid(value,opt={}){
  const settings=options(opt,['step']),{path}=settings,step=Object.hasOwn(settings,'step')?settings.step:1n;
  if(typeof step!=='bigint')fail(INVALID,'type',path);
  if(step<1n||step>1048576n)fail(RANGE,'step_range',path);
  const original=fixed(value,4,path),requested=original.map(x=>coordinate(x,path));
  if(original[0]>=original[2]||original[1]>=original[3])fail(INVALID,'bbox_order',path);
  const applied=requested.map(r=>studioRoundHalfEven(studioRatDiv(r,R(step)))*step);
  if(applied.some(x=>x<-LIMIT||x>LIMIT))fail(RANGE,'coordinate_range',path);
  if(applied[0]>=applied[2]||applied[1]>=applied[3])fail('STUDIO_SHAPE_QUANTIZE_DEGENERATE','zero_area',path);
  let shift=R(0n);
  for(let i=0;i<4;i++){
    let d=sub(R(applied[i]),requested[i]);if(d.n<0n)d=studioRatNeg(d);
    if(studioRatCmp(d,shift)>0)shift=d;
  }
  const bbox=applied.map(x=>Number(x)/GRID);
  return {bbox,report:{report_version:1,op:'align_rect',grid:'1/1024',rounding:'half-even',step,
    changed:original.some((x,i)=>x!==bbox[i]),requested,applied,max_component_shift:shift}};
}

function sameRationalPoint(a,b){
  return a[0].n===b[0].n&&a[0].d===b[0].d&&a[1].n===b[1].n&&a[1].d===b[1].d;
}
function lassoArea(points){
  let result=0n;
  for(let i=0;i<points.length;i++)result+=points[i][0]*points[(i+1)%points.length][1]-points[(i+1)%points.length][0]*points[i][1];
  return result;
}
function distanceSquared(a,b){return (a[0]-b[0])**2n+(a[1]-b[1])**2n;}
function lassoDistanceNumerator(p,a,b,lengthSquared){
  const dot=(p[0]-a[0])*(b[0]-a[0])+(p[1]-a[1])*(b[1]-a[1]);
  if(dot<=0n)return distanceSquared(p,a)*lengthSquared;
  if(dot>=lengthSquared)return distanceSquared(p,b)*lengthSquared;
  return cross(a,b,p)**2n;
}
export function createStudioLasso(samples,opt={}){
  const settings=options(opt,['tolerance_px']),{path}=settings;
  if(!Object.hasOwn(settings,'tolerance_px'))fail(INVALID,'missing_tolerance',path);
  const value=finite(settings.tolerance_px,path);
  if(value<0||value>1024)fail(RANGE,'tolerance_range',path);
  const tolerance=coordinate(value,path),raw=dense(samples,3,1024,path).map(p=>point(p,path));
  const cleaned=[],sampleIds=[],duplicates=[];
  for(let i=0;i<raw.length;i++){
    if(cleaned.length&&sameRationalPoint(cleaned[cleaned.length-1],raw[i]))duplicates.push(i);
    else{cleaned.push(raw[i]);sampleIds.push(i);}
  }
  if(cleaned.length>1&&sameRationalPoint(cleaned[0],cleaned[cleaned.length-1])){
    cleaned.pop();duplicates.push(sampleIds.pop());
  }
  duplicates.sort((a,b)=>a-b);
  if(cleaned.length<3)fail(RAW,'zero_area',path);
  const scaled=rawSimple(cleaned,path);
  let denominator=1n;
  for(const p of cleaned)for(const r of p)if(r.d>denominator)denominator=r.d;
  const denominatorSquared=denominator*denominator,rawArea=lassoArea(scaled);
  const toleranceNumeratorSquared=tolerance.n*tolerance.n*denominatorSquared;
  const toleranceDenominatorSquared=tolerance.d*tolerance.d;
  let anchor=1,farthest=distanceSquared(scaled[0],scaled[1]);
  for(let i=2;i<scaled.length;i++){
    const distance=distanceSquared(scaled[0],scaled[i]);
    if(distance>farthest){farthest=distance;anchor=i;}
  }
  const keep=new Set([0,anchor]);let errorNumerator=0n,errorDenominator=1n;
  const chains=[Array.from({length:anchor+1},(_,i)=>i),[...Array.from({length:scaled.length-anchor},(_,i)=>i+anchor),0]];
  for(const chain of chains){
    const stack=[[0,chain.length-1]];
    while(stack.length){
      const [lo,hi]=stack.pop();if(hi-lo<2)continue;
      const a=scaled[chain[lo]],b=scaled[chain[hi]],lengthSquared=distanceSquared(a,b);
      if(lengthSquared===0n)fail(RAW,'simplify_invalid',path);
      let best=-1,bestNum=0n;
      // Interior chain indices increase in original sample order; strict > keeps the earliest tie.
      for(let k=lo+1;k<hi;k++){
        const distance=lassoDistanceNumerator(scaled[chain[k]],a,b,lengthSquared);
        if(distance>bestNum){bestNum=distance;best=k;}
      }
      if(bestNum*toleranceDenominatorSquared>toleranceNumeratorSquared*lengthSquared){
        keep.add(chain[best]);if(keep.size>128)fail(BUDGET,'simplify_budget',path);
        stack.push([best,hi],[lo,best]);
      }else{
        // Only accepted terminal chains contribute to the final simplification error.
        const errorDen=lengthSquared*denominatorSquared;
        if(bestNum*errorDenominator>errorNumerator*errorDen){errorNumerator=bestNum;errorDenominator=errorDen;}
      }
    }
  }
  const retained=[...keep].sort((a,b)=>a-b);
  if(retained.length<3)fail(RAW,'simplify_invalid',path);
  const simplified=retained.map(i=>cleaned[i]);
  try{rawSimple(simplified,path);}catch(error){if(error.code===RAW)fail(RAW,'simplify_invalid',path);throw error;}
  const keptArea=lassoArea(retained.map(i=>scaled[i]));
  if((rawArea<0n)!==(keptArea<0n))fail(RAW,'simplify_invalid',path);
  const keptIds=retained.map(i=>sampleIds[i]);
  const result=finish(simplified,'create_lasso',path,raw.length,{
    tolerance,duplicate_sample_indices:duplicates,kept_sample_indices:keptIds,rdp_removed_count:cleaned.length-retained.length,
    raw_twice_area:R(rawArea,denominatorSquared),rdp_max_distance_sq:R(errorNumerator,errorDenominator),
  });
  result.report.merged_sample_indices=result.report.merged_vertices.map(i=>keptIds[i]);
  return result;
}
