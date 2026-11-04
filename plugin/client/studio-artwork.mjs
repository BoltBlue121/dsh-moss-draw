// SVG and canvas export share the same final drawing primitives.
export function studioPrimitiveSVG(React,p,i){
  const h=React.createElement;
  if(p.kind==='text'){
    const [x,y,r,b]=p.clip;
    return h('svg',{key:i,x,y,width:r-x,height:b-y,overflow:'hidden',pointerEvents:'none'},p.lines.map((line,j)=>
      h('text',{key:j,x:line.x-x,y:line.y-y,textAnchor:'middle',dominantBaseline:'central',fontSize:p.size,fill:p.color},line.text)));
  }
  const points=p.points.map(v=>v.join(',')).join(' ');
  if(p.kind==='polygon')return h('polygon',{key:i,points,fill:p.fill,stroke:p.stroke,strokeWidth:p.width,strokeLinejoin:'round'});
  if(p.points.length===1)return h('circle',{key:i,cx:p.points[0][0],cy:p.points[0][1],r:p.width/2,fill:p.color});
  return h('polyline',{key:i,points,fill:'none',stroke:p.color,strokeWidth:p.width,strokeLinecap:'round',strokeLinejoin:'round'});
}
export function paintStudioPrimitives(g,primitives){
  for(const p of primitives){
    g.save();
    try{
      if(p.kind==='text'){
        const [x,y,r,b]=p.clip;
        g.beginPath();g.rect(x,y,r-x,b-y);g.clip();g.fillStyle=p.color;g.textAlign='center';g.textBaseline='middle';
        g.font=p.size+'px system-ui,sans-serif';
        for(const line of p.lines)g.fillText(line.text,line.x,line.y);
        continue;
      }
      g.lineWidth=p.width;g.lineJoin='round';g.lineCap='round';g.beginPath();
      const [first,...rest]=p.points;
      if(p.kind==='line'&&!rest.length){g.fillStyle=p.color;g.arc(first[0],first[1],p.width/2,0,2*Math.PI);g.fill();continue;}
      g.moveTo(first[0],first[1]);for(const [x,y] of rest)g.lineTo(x,y);
      if(p.kind==='polygon'){g.closePath();g.fillStyle=p.fill;g.fill();}
      g.strokeStyle=p.kind==='polygon'?p.stroke:p.color;g.stroke();
    }finally{g.restore();}
  }
}
