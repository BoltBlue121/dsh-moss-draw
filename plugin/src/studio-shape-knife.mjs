/** Exact straight-line boundary graphs. Pure geometry, no document or permission state. */
import {studioRational,studioRatAdd,studioRatSub,studioRatMul,studioRatDiv,studioRatNeg,studioRatCmp,studioRoundHalfEvenSqrt,studioLatticeRing,studioTwiceAreaRational,studioRationalPieceKey,studioRingFromLattice,studioShapePieceKey,quantizeStudioPolygon} from './studio-shape-exact.mjs';

export const STUDIO_SHAPE_KNIFE_ERROR_CODES=Object.freeze(['STUDIO_SHAPE_KNIFE_INTERNAL']);
const INTERNAL=STUDIO_SHAPE_KNIFE_ERROR_CODES[0],INVALID='STUDIO_INVALID_INPUT',RANGE='STUDIO_SHAPE_RANGE',BUDGET='STUDIO_SHAPE_BUDGET';
const R=studioRational,add=studioRatAdd,sub=studioRatSub,mul=studioRatMul,cmp=studioRatCmp;
const ZERO=R(0n),COORD=1n<<24n,COEFFICIENT=1n<<25n,CONSTANT=1n<<50n;
const abs=n=>n<0n?-n:n,sign=n=>n<0n?-1:n>0n?1:0;
function fail(code,reason,path='knife',details){
  const error=Object.assign(new TypeError(`Studio shape knife: ${reason}`),details);error.code=code;error.reason=reason;error.path=path;throw error;
}
function budget(value,limit,reason,path){if(value>limit)fail(BUDGET,reason,path);}
function own(value,key,path){
  const d=Object.getOwnPropertyDescriptor(value,key);
  if(!d||!d.enumerable||!Object.hasOwn(d,'value'))fail(INVALID,'structure',path);
  return d.value;
}
function record(value,allowed,required,path){
  if(value===null||typeof value!=='object'||Array.isArray(value)||![null,Object.prototype].includes(Object.getPrototypeOf(value)))fail(INVALID,'structure',path);
  const result=Object.create(null);
  for(const key of Reflect.ownKeys(value)){
    if(typeof key!=='string'||!allowed.includes(key))fail(INVALID,'structure',path);
    result[key]=own(value,key,path);
  }
  for(const key of required)if(!Object.hasOwn(result,key))fail(INVALID,'structure',path);
  return result;
}
function lengthOf(value,path){
  if(!Array.isArray(value))fail(INVALID,'structure',path);
  const d=Object.getOwnPropertyDescriptor(value,'length');
  if(!d||!Object.hasOwn(d,'value')||!Number.isSafeInteger(d.value)||d.value<0)fail(INVALID,'structure',path);
  return d.value;
}
function dense(value,low,high,path,reason='point_budget'){
  const count=lengthOf(value,path);budget(count,high,reason,path);
  if(count<low||Reflect.ownKeys(value).length!==count+1)fail(INVALID,'structure',path);
  return Array.from({length:count},(_,i)=>own(value,String(i),path));
}
function bridgeInput(action,path){
  try{return action();}catch(error){
    if(error&&typeof error.code==='string'){
      if(error.reason===undefined)error.reason='structure';
      if(error.path===undefined)error.path=path;
    }
    throw error;
  }
}
function gcd(a,b){a=abs(a);b=abs(b);while(b){const next=a%b;a=b;b=next;}return a;}
function latticePoint(value,path){
  if(lengthOf(value,path)!==2)fail(INVALID,'structure',path);
  return dense(value,2,2,path).map(v=>{
    if(typeof v!=='bigint')fail(INVALID,'line_type',path);
    if(v<-COORD||v>COORD)fail(RANGE,'coordinate_range',path);
    return v;
  });
}
export function studioKnifeLineFromLattice(first,last){
  const p=latticePoint(first,'line.p'),q=latticePoint(last,'line.q');
  let a=q[1]-p[1],b=p[0]-q[0];if(a===0n&&b===0n)fail(INVALID,'line_point_equal','line');
  let c=a*p[0]+b*p[1];const d=gcd(a,b);a/=d;b/=d;c/=d;
  if(a<0n||a===0n&&b<0n){a=-a;b=-b;c=-c;}
  return Object.freeze({a,b,c});
}
function readLine(value){
  const p=record(value,['a','b','c'],['a','b','c'],'line');
  for(const key of ['a','b','c'])if(typeof p[key]!=='bigint')fail(INVALID,'line_type',`line.${key}`);
  if(p.a<-COEFFICIENT||p.a>COEFFICIENT||p.b<-COEFFICIENT||p.b>COEFFICIENT||p.c<-CONSTANT||p.c>CONSTANT)fail(RANGE,'line_range','line');
  if(p.a===0n&&p.b===0n)fail(INVALID,'line_zero','line');
  if(gcd(p.a,p.b)!==1n)fail(INVALID,'line_not_primitive','line');
  if(p.a<0n||p.a===0n&&p.b<0n)fail(INVALID,'line_sign','line');
  return Object.freeze({a:p.a,b:p.b,c:p.c});
}
function context(value){
  const op=record(value,['ring','line','gutter'],['ring','line'],'knife'),normal=readLine(op.line);
  const ring=dense(op.ring,3,128,'ring');
  const source=bridgeInput(()=>studioLatticeRing(ring,'ring'),'ring');
  const g=Object.hasOwn(op,'gutter')?op.gutter:ZERO;
  try{cmp(g,ZERO);}catch(error){if(error.code===INVALID&&error.reason==='brand')fail(INVALID,'gutter_type','gutter');throw error;}
  if(cmp(g,ZERO)<0||cmp(g,R(1048576n))>0)fail(RANGE,'gutter_range','gutter');
  const N=normal.a*normal.a+normal.b*normal.b,K=studioRoundHalfEvenSqrt(studioRatDiv(g,R(2n)),N);
  return {source,normal,gutter:{g,N,K,width2:R(4n*K*K,N),collapsed:g.n>0n&&K===0n}};
}
const pointKey=p=>`${p[0].n}/${p[0].d},${p[1].n}/${p[1].d}`;
const pointCmp=(a,b)=>cmp(a[0],b[0])||cmp(a[1],b[1]);
const delta=(a,b)=>[sub(a[0],b[0]),sub(a[1],b[1])];
const dot=(a,b)=>add(mul(a[0],b[0]),mul(a[1],b[1]));
const cross=(a,b)=>sub(mul(a[0],b[1]),mul(a[1],b[0]));
function canonical(points){
  let first=0;for(let i=1;i<points.length;i++)if(pointCmp(points[i],points[first])<0)first=i;
  return [...points.slice(first),...points.slice(0,first)];
}
function clockwiseKey(reverseIncoming,outgoing){return [dot(reverseIncoming,outgoing),studioRatNeg(cross(reverseIncoming,outgoing))];}
function polarCmp(a,b){
  // The directed boundary graph has no reversed edge pair, so a zero-angle U-turn cannot occur.
  const half=p=>p[1].n>0n||p[1].n===0n&&p[0].n>=0n?0:1;
  const ha=half(a),hb=half(b);if(ha!==hb)return ha-hb;
  return -sign(cross(a,b).n);
}
function clipSide(original,normal,boundary,side,reversed,totals){
  const nodes=[],keys=new Set(),edges=[],edgeKeys=new Set(),cutKeys=new Set(),collinear=[];
  const sideSign=side==='lo'?-1n:1n;
  const f=original.map(([x,y])=>normal.a*x+normal.b*y-boundary);
  function addNode(p,value){
    budget(nodes.length+1,256,'node_budget',side);
    const key=pointKey(p);if(keys.has(key))fail(INTERNAL,'face_walk',side);keys.add(key);
    nodes.push({p,f:value,h:0,out:[],incoming:[]});
  }
  for(let i=0;i<original.length;i++){
    const j=(i+1)%original.length,p=original[i],q=original[j];addNode(p.map(x=>R(x)),f[i]);
    if(f[i]<0n&&f[j]>0n||f[i]>0n&&f[j]<0n){
      const t=R(-f[i],f[j]-f[i]);
      addNode([add(R(p[0]),mul(R(q[0]-p[0]),t)),add(R(p[1]),mul(R(q[1]-p[1]),t))],0n);
    }
  }
  function addEdge(from,to,isCut=false){
    budget(edges.length+1,512,'edge_budget',side);
    const key=`${from}>${to}`;
    if(from===to||edgeKeys.has(key))fail(INTERNAL,'face_walk',side);
    edgeKeys.add(key);if(isCut)cutKeys.add(key);
    const id=edges.length;edges.push({from,to});nodes[from].out.push(id);nodes[to].incoming.push(id);
    if(nodes[from].out.length>2||nodes[to].incoming.length>2)fail(INTERNAL,'face_walk',side);
  }
  for(let i=0;i<nodes.length;i++){
    const j=(i+1)%nodes.length,a=nodes[i].f*sideSign,b=nodes[j].f*sideSign;
    if(a===0n&&b===0n){collinear.push([i,j]);continue;}
    if(a>=0n&&b>=0n&&(a>0n||b>0n)){
      addEdge(i,j);if(a===0n)nodes[i].h++;if(b===0n)nodes[j].h++;
    }
  }
  const along=p=>add(mul(R(-normal.b),p[0]),mul(R(normal.a),p[1]));
  const on=nodes.map((node,id)=>({node,id,u:node.f===0n?along(node.p):null})).filter(x=>x.u!==null).sort((a,b)=>cmp(a.u,b.u));
  let inside=false;
  for(let i=0;i<on.length;i++){
    if(on[i].node.h%2===1)inside=!inside;
    if(i+1<on.length){
      if(cmp(on[i].u,on[i+1].u)===0)fail(INTERNAL,'face_walk',side);
      if(inside){
        if(side==='lo')addEdge(on[i].id,on[i+1].id,true);
        else addEdge(on[i+1].id,on[i].id,true);
      }
    }
  }
  if(inside)fail(INTERNAL,'sweep_unbalanced',side);
  for(const [from,to] of collinear){
    const direction=cmp(along(nodes[to].p),along(nodes[from].p));
    const belongs=side==='lo'?direction>0:direction<0;
    if(cutKeys.has(`${from}>${to}`)!==belongs||cutKeys.has(`${to}>${from}`))fail(INTERNAL,'collinear_mismatch',side);
  }
  for(const node of nodes){
    if(node.out.length!==node.incoming.length||node.f!==0n&&node.out.length>1)fail(INTERNAL,'face_walk',side);
  }
  const next=[],predecessors=new Array(edges.length).fill(0);
  for(let id=0;id<edges.length;id++){
    const edge=edges[id],at=nodes[edge.to],outs=at.out;
    if(outs.length===0)fail(INTERNAL,'face_walk',side);
    let chosen=outs[0];
    if(outs.length===2){
      const reverse=delta(nodes[edge.from].p,at.p);
      const ka=clockwiseKey(reverse,delta(nodes[edges[outs[0]].to].p,at.p));
      const kb=clockwiseKey(reverse,delta(nodes[edges[outs[1]].to].p,at.p));
      const order=polarCmp(ka,kb);if(order===0)fail(INTERNAL,'face_walk',side);
      if(order>0)chosen=outs[1];
    }
    next[id]=chosen;if(++predecessors[chosen]>1)fail(INTERNAL,'face_walk',side);
  }
  if(predecessors.some(n=>n!==1))fail(INTERNAL,'face_walk',side);
  const visited=new Set(),pieces=[];
  for(let start=0;start<edges.length;start++){
    if(visited.has(start))continue;
    const cycle=[],seen=new Set();let current=start;
    do{
      if(visited.has(current))fail(INTERNAL,'face_walk',side);
      const vertex=edges[current].from;if(seen.has(vertex))fail(INTERNAL,'face_walk',side);
      budget(cycle.length+1,256,'point_budget',side);
      visited.add(current);seen.add(vertex);cycle.push(nodes[vertex].p);current=next[current];
    }while(current!==start);
    if(cycle.length<3)fail(INTERNAL,'face_walk',side);
    const positiveArea=studioTwiceAreaRational(cycle);if(positiveArea.n<=0n)fail(INTERNAL,'face_walk',side);
    budget(totals.pieces+1,256,'piece_budget','pieces');budget(totals.points+cycle.length,1024,'total_point_budget','pieces');
    totals.pieces++;totals.points+=cycle.length;
    const points=canonical(reversed?[...cycle].reverse():cycle).map(p=>[p[0],p[1]]);
    pieces.push({side,points,rational_key:studioRationalPieceKey(points),twice_area_exact:reversed?studioRatNeg(positiveArea):positiveArea});
  }
  return pieces;
}
function rawFromContext({source,normal,gutter}){
  const reversed=source.twice_area<0n;
  const original=reversed?[...source.points].reverse():[...source.points],totals={pieces:0,points:0};
  const pieces=[...clipSide(original,normal,normal.c-gutter.K,'lo',reversed,totals),...clipSide(original,normal,normal.c+gutter.K,'hi',reversed,totals)];
  pieces.sort((a,b)=>{
    if(a.side!==b.side)return a.side==='lo'?-1:1;
    return pointCmp(a.points[0],b.points[0])||(a.rational_key<b.rational_key?-1:a.rational_key>b.rational_key?1:0);
  });
  const sourceArea=R(abs(source.twice_area));let kept=ZERO;
  for(const piece of pieces)kept=add(kept,piece.twice_area_exact.n<0n?studioRatNeg(piece.twice_area_exact):piece.twice_area_exact);
  const removed=sub(sourceArea,kept);
  if(removed.n<0n||gutter.K===0n&&removed.n!==0n)fail(INTERNAL,'area_mismatch','areas');
  return {status:'RAW',applied:false,pieces,gutter,areas:{source:sourceArea,kept_exact:kept,removed_exact:removed}};
}
export function studioKnifeRationalPieces(op){return rawFromContext(context(op));}

const minInt=(a,b)=>a<b?a:b,maxInt=(a,b)=>a>b?a:b;
const intDelta=(a,b)=>[a[0]-b[0],a[1]-b[1]];
const intCross=(a,b)=>a[0]*b[1]-a[1]*b[0];
function latticeArea(points){
  let result=0n;for(let i=0;i<points.length;i++)result+=intCross(points[i],points[(i+1)%points.length]);return result;
}
function latticeBounds(points){
  let [left,top]=points[0],right=left,bottom=top;
  for(const [x,y] of points){left=minInt(left,x);right=maxInt(right,x);top=minInt(top,y);bottom=maxInt(bottom,y);}
  return [left,top,right,bottom];
}
function readOverlapRings(value){
  const rings=dense(value,1,256,'rings','piece_budget');let total=0;
  for(let i=0;i<rings.length;i++){
    const path=`rings[${i}]`,count=lengthOf(rings[i],path);budget(count,128,'point_budget',path);
    if(count<3)fail(INVALID,'structure',path);total+=count;budget(total,1024,'total_point_budget','rings');
  }
  return rings.map((ring,i)=>{
    const px=bridgeInput(()=>studioRingFromLattice(ring,`rings[${i}]`),`rings[${i}]`);
    const points=px.map(p=>p.map(v=>BigInt(v*1024)));
    return {points,bounds:latticeBounds(points),winding:sign(latticeArea(points))};
  });
}
function onIntSegment(a,b,p){
  return intCross(intDelta(b,a),intDelta(p,a))===0n&&p[0]>=minInt(a[0],b[0])&&p[0]<=maxInt(a[0],b[0])&&p[1]>=minInt(a[1],b[1])&&p[1]<=maxInt(a[1],b[1]);
}
function classifyRationalPoint(point,points){
  const D=point[0].d/gcd(point[0].d,point[1].d)*point[1].d;
  const x=point[0].n*(D/point[0].d),y=point[1].n*(D/point[1].d);let inside=false;
  for(let i=0;i<points.length;i++){
    const a=points[i],b=points[(i+1)%points.length],v=intDelta(b,a);
    const ax=a[0]*D,ay=a[1]*D,bx=b[0]*D,by=b[1]*D;
    const orientation=v[0]*(y-ay)-v[1]*(x-ax);
    if(orientation===0n&&x>=minInt(ax,bx)&&x<=maxInt(ax,bx)&&y>=minInt(ay,by)&&y<=maxInt(ay,by))return {kind:'boundary',edge:i};
    if((ay>y)!==(by>y)&&sign(orientation)*sign(v[1])>0)inside=!inside;
  }
  return {kind:inside?'inside':'outside'};
}
function scanEdges(source,target,tick){
  for(let i=0;i<source.points.length;i++){
    tick();
    const a=source.points[i],b=source.points[(i+1)%source.points.length],v=intDelta(b,a);
    const parameters=new Map([['0/1',ZERO],['1/1',R(1n)]]);
    const addParameter=t=>parameters.set(`${t.n}/${t.d}`,t);
    for(let j=0;j<target.points.length;j++){
      const c=target.points[j],d=target.points[(j+1)%target.points.length],w=intDelta(d,c),offset=intDelta(c,a);
      let denominator=intCross(v,w);
      if(denominator!==0n){
        let tn=intCross(offset,w),un=intCross(offset,v);
        if(denominator<0n){denominator=-denominator;tn=-tn;un=-un;}
        if(tn>=0n&&tn<=denominator&&un>=0n&&un<=denominator){tick();addParameter(R(tn,denominator));}
      }else if(intCross(offset,v)===0n){
        for(const endpoint of [c,d])if(onIntSegment(a,b,endpoint)){
          tick();const axis=v[0]!==0n?0:1;addParameter(R(endpoint[axis]-a[axis],v[axis]));
        }
      }
    }
    const sorted=[...parameters.values()].sort(cmp);
    for(let k=0;k+1<sorted.length;k++){
      tick();const t0=sorted[k],t1=sorted[k+1],t=R(t0.n*t1.d+t1.n*t0.d,2n*t0.d*t1.d);
      const middle=[R(a[0]*t.d+v[0]*t.n,t.d),R(a[1]*t.d+v[1]*t.n,t.d)];
      const position=classifyRationalPoint(middle,target.points);
      if(position.kind==='inside')return middle;
      if(position.kind==='boundary'){
        const c=target.points[position.edge],d=target.points[(position.edge+1)%target.points.length],w=intDelta(d,c);
        if(intCross(v,w)===0n&&source.winding*target.winding*sign(v[0]*w[0]+v[1]*w[1])>0)return middle;
      }
    }
  }
  return null;
}
export function studioLatticePiecesOverlap(value){
  const rings=readOverlapRings(value);let events=0;
  const tick=()=>{if(++events>65536)fail(BUDGET,'overlap_event_budget','overlap',{events,limit:65536});};
  for(let i=0;i<rings.length;i++)for(let j=i+1;j<rings.length;j++){
    const a=rings[i],b=rings[j],x=a.bounds,y=b.bounds;
    if(minInt(x[2],y[2])<=maxInt(x[0],y[0])||minInt(x[3],y[3])<=maxInt(x[1],y[1]))continue;
    const witness=scanEdges(a,b,tick)||scanEdges(b,a,tick);
    if(witness)return {overlap:true,pair:[i,j],witness,events};
  }
  return {overlap:false,events};
}
function canonicalLattice(points){
  let first=0;
  for(let i=1;i<points.length;i++)if(points[i][0]<points[first][0]||points[i][0]===points[first][0]&&points[i][1]<points[first][1])first=i;
  return [...points.slice(first),...points.slice(0,first)].map(p=>[p[0],p[1]]);
}
function axisRectangle(points){
  if(points.length!==4||new Set(points.map(p=>p[0])).size!==2||new Set(points.map(p=>p[1])).size!==2)return false;
  return points.every((p,i)=>{const q=points[(i+1)%4];return (p[0]===q[0])!==(p[1]===q[1]);});
}
function finalPiece(side,rationalKey,lattice,exactArea,gridArea,merged,shift){
  return {side,rational_key:rationalKey,grid_key:studioShapePieceKey(lattice),ring:lattice.map(p=>p.map(v=>Number(v)/1024)),lattice,
    twice_area_exact:exactArea,twice_area_grid:gridArea,merged_vertices:merged,max_component_shift:shift,axis_rect_lattice:axisRectangle(lattice)};
}
export function studioKnifeSplit(op){
  const ctx=context(op),raw=rawFromContext(ctx),raw_piece_count=raw.pieces.length,raw_removed_exact=raw.areas.removed_exact;
  if(raw_piece_count<2){
    const lattice=ctx.source.points.map(p=>[p[0],p[1]]),exactArea=R(ctx.source.twice_area);
    const whole=finalPiece('whole',studioRationalPieceKey(lattice.map(p=>p.map(v=>R(v)))),lattice,exactArea,ctx.source.twice_area,[],ZERO);
    return {status:'NO_SPLIT',applied:false,pieces:[whole],gutter:raw.gutter,areas:{source:raw.areas.source,kept_exact:raw.areas.source,removed_exact:ZERO,kept_grid:abs(ctx.source.twice_area),grid_delta:ZERO},raw_piece_count,raw_removed_exact};
  }
  const pieces=[];let total=0,keptGrid=0n;
  for(let i=0;i<raw.pieces.length;i++){
    const piece=raw.pieces[i],path=`pieces[${i}].ring`;
    try{
      const q=quantizeStudioPolygon(piece.points,{path}),lattice=canonicalLattice(q.lattice);
      total+=lattice.length;budget(total,1024,'total_point_budget','pieces');keptGrid+=abs(q.twice_area_grid);
      pieces.push(finalPiece(piece.side,piece.rational_key,lattice,q.twice_area_exact,q.twice_area_grid,q.merged_vertices,q.max_component_shift));
    }catch(error){
      if(error&&typeof error.code==='string'){error.path=path;error.piece_index=i;error.piece_key=piece.rational_key;}
      throw error;
    }
  }
  const overlap=studioLatticePiecesOverlap(pieces.map(p=>p.lattice));
  if(overlap.overlap)fail('STUDIO_SHAPE_QUANTIZE_INVALID','piece_overlap','pieces',{pair:overlap.pair,witness:overlap.witness});
  return {status:'SPLIT',applied:true,pieces,gutter:raw.gutter,areas:{...raw.areas,kept_grid:keptGrid,grid_delta:sub(R(keptGrid),raw.areas.kept_exact)},raw_piece_count,raw_removed_exact};
}
