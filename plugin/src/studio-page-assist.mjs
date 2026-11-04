// Read-only layout aids shared by the workbench and document operations.
export const STUDIO_FRAME_TEMPLATES=Object.freeze({
  diagonal:'三格斜切',four:'四格条漫',poster:'海报',blank:'空白',
});

function error(message) {
  throw Object.assign(new TypeError(message),{code:'STUDIO_LAYOUT_ASSIST'});
}

export function studioTemplateFrames(preset,width,height,gutter) {
  if(!Object.hasOwn(STUDIO_FRAME_TEMPLATES,preset))error('Unknown frame template.');
  if(!Number.isFinite(gutter)||gutter<0||gutter>=Math.min(width,height)/4)error('格间距过大，请小于短边的四分之一。');
  const rect=(l,t,r,b)=>[[l,t],[r,t],[r,b],[l,b]];
  if(preset==='blank')return [];
  if(preset==='poster') {
    const margin=Math.min(width,height)*.05;
    return [rect(margin,margin,width-margin,height-margin)];
  }
  const gap=gutter/2;
  if(preset==='four') {
    const top=height/3,bottom=2*height/3,half=width/2;
    return [rect(0,0,width,top-gap),rect(0,top+gap,width,bottom-gap),
      rect(0,bottom+gap,half-gap,height),rect(half+gap,bottom+gap,width,height)];
  }
  const y1=height*.34,y2=height*.66,tilt=Math.min(width,height)*.07;
  const inset=gap*Math.hypot(1,2*tilt/width);
  return [
    [[0,0],[width,0],[width,y1-tilt-inset],[0,y1+tilt-inset]],
    [[0,y1+tilt+inset],[width,y1-tilt+inset],[width,y2+tilt-inset],[0,y2-tilt-inset]],
    [[0,y2-tilt+inset],[width,y2+tilt+inset],[width,height],[0,height]],
  ];
}

const digits='零一二三四五六七八九', units=['','十','百','千'];
function thousands(n) {
  let text='',missing=false;
  for(let i=3;i>=0;i--) {
    const digit=Math.floor(n/10**i)%10;
    if(digit){text+=(missing?'零':'')+digits[digit]+units[i];missing=false;}
    else if(text)missing=true;
  }
  return text;
}
export function studioChineseNumberText(text) {
  return text.replace(/\d+/gu,(raw,offset)=>{
    const left=text[offset-1]??'',right=text[offset+raw.length]??'';
    // Preserve identifiers, decimal/date components, multi-digit codes and phone numbers.
    if(raw.length>8 || /^0\d/u.test(raw) || /[A-Za-z_/:+-]/u.test(left+right) ||
      (left==='.' && /\d/u.test(text[offset-2]??'')) || (right==='.' && /\d/u.test(text[offset+raw.length+1]??'')))return raw;
    const n=Number(raw);
    if(!n)return digits[0];
    const high=Math.floor(n/10000), low=n%10000;
    const value=high?thousands(high)+'万'+(low>0 && low<1000?'零':'')+thousands(low):thousands(low);
    return value.replace(/^一十/u,'十');
  });
}

export function studioPanelRowTarget(items,threshold) {
  if(!Number.isFinite(threshold)||threshold<0||threshold>1024)error('对齐阈值须为 0–1024 像素。');
  const sorted=[...items].sort((a,b)=>a.bbox[0]-b.bbox[0]);
  if(sorted.length<2)error('请选择至少两个并排分镜。');
  const tops=sorted.map(i=>i.bbox[1]);
  if(Math.max(...tops)-Math.min(...tops)>threshold)error('顶边差值超过指定阈值。');
  for(let i=1;i<sorted.length;i++) {
    const prev=sorted[i-1].bbox,next=sorted[i].bbox;
    if(next[0]<prev[2]-Math.min(24,(prev[2]-prev[0])/4,(next[2]-next[0])/4))
      error('选中格有较大横向重叠，无法作为同一排对齐。');
  }
  return sorted[0].bbox[1];
}

export function studioPageSuggestions(doc) {
  const items=doc.layout.items.filter(i=>!i.hidden),panels=items.filter(i=>i.role==='panel').sort((a,b)=>a.bbox[0]-b.bbox[0]);
  const findings=[];
  for(let i=0;i<panels.length;i++) for(let j=i+1;j<panels.length;j++) {
    const a=panels[i],b=panels[j];
    if(a.locked||b.locked||a.bbox[1]===b.bbox[1]||Math.abs(a.bbox[1]-b.bbox[1])>18)continue;
    if(b.bbox[0]<a.bbox[2]-Math.min(24,(a.bbox[2]-a.bbox[0])/4,(b.bbox[2]-b.bbox[0])/4)) continue;
    findings.push({message:`${a.name||a.id} 和 ${b.name||b.id} 顶边相差 ${Math.abs(a.bbox[1]-b.bbox[1])} 像素。`,
      command:{op:'align_row',ids:[a.id,b.id],threshold_px:18}});
    break;
  }
  for(const item of items) {
    const width=item.bbox[2]-item.bbox[0],height=item.bbox[3]-item.bbox[1];
    if(item.label==='character' && width*height<doc.layout.width*doc.layout.height*.08 &&
      /眼睛|嘴唇|手指|手掌|脚踝|\b(?:eyes?|lips?|fingers?|hands?)\b/iu.test(item.caption))
      findings.push({message:`${item.name||item.id} 像是角色局部特写，请核对角色/物体分类。`,target_id:item.id});
    if(item.bubble && [...(item.text??'')].length>15 && width<Math.min(220,doc.layout.width) && !item.locked)
      findings.push({message:`${item.name||item.id} 对白较长，预览是否需要加宽气泡。`,
        command:{op:'widen_bubble',target_id:item.id,min_width_px:Math.min(228,doc.layout.width)}});
    if(item.label==='text'&&item.text&&!item.locked){
      const proposed=studioChineseNumberText(item.text);
      if(proposed!==item.text)findings.push({message:`数字排版：${item.text.slice(0,60)} → ${proposed.slice(0,60)}`,
        command:{op:'format_numbers',target_id:item.id}});
    }
    if(!item.caption.trim() && !item.text?.trim() && !item.sketch)
      findings.push({message:`${item.name||item.id} 尚无描述。可在属性里补写。`,target_id:item.id});
  }
  return findings;
}

export function studioSizeForMegapixels(ratio,mp) {
  if(!Number.isFinite(ratio)||ratio<=0||!Number.isFinite(mp)||mp<=0)error('请输入正的长宽比和像素数。');
  const width=Math.round(Math.sqrt(mp*1000000*ratio)/16)*16;
  const height=Math.round(Math.sqrt(mp*1000000/ratio)/16)*16;
  if(width<16||width>4096||height<16||height>4096)error('该比例与像素数超出 16–4096 的工作台尺寸范围。');
  return [width,height];
}

