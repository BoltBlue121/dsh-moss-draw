// Read only visible messages from the currently bound DSH session window.
// The host re-authorizes the content-addressed attachment against this session.
export async function readStudioSessionImage(session,sessionId){
  const current=()=>session?.getSnapshot?.()?.sessionId===sessionId;
  if(!current()||typeof session.eventSource?.getSnapshot!=='function'||typeof session.readAttachment!=='function')throw Error('STUDIO_SESSION_IMAGE_UNAVAILABLE: 当前会话没有可读的原生附件接口。');
  const entries=session.eventSource.getSnapshot()?.entries;
  if(!Array.isArray(entries))throw Error('STUDIO_SESSION_IMAGE_UNAVAILABLE');
  let ref,eventSeq;
  for(let index=entries.length-1;index>=0&&!ref;index--){
    const event=entries[index]?.event;
    if(!Number.isSafeInteger(event?.seq)||event.seq<0||event.surfaceOp!=='append'||!['user/message','assistant/message','tool/result'].includes(event.type))continue;
    const message=event.type==='user/message'?event.data:event.data?.message;
    if(!Array.isArray(message?.content))continue;
    for(let i=message.content.length-1;i>=0;i--){
      const part=message.content[i],candidate=part?.attachment;
      if(part?.type!=='image'||part.offloaded||!candidate)continue;
      if(!/^sha256:[a-f0-9]{64}$/.test(candidate.attachmentId)||!['image/png','image/jpeg','image/webp'].includes(candidate.mediaType)
        ||!Number.isSafeInteger(candidate.bytes)||candidate.bytes<12||candidate.bytes>32*1024*1024)throw Error('STUDIO_SESSION_IMAGE_INVALID: 最近图片的原生引用、格式或大小不受支持。');
      ref=candidate;eventSeq=event.seq;break;
    }
  }
  if(!ref)throw Error('STUDIO_SESSION_IMAGE_MISSING: 当前会话已载入的消息中没有可读的原生图片。');
  const result=await session.readAttachment(ref.attachmentId);
  if(!current()||!result?.ok)throw Error('STUDIO_SESSION_IMAGE_UNAVAILABLE: 无法读取当前会话的此附件。');
  const {attachment,data}=result.value??{};
  if(attachment?.attachmentId!==ref.attachmentId||attachment.mediaType!==ref.mediaType||!(data instanceof Uint8Array)
    ||data.byteLength!==ref.bytes||attachment.bytes!==ref.bytes)throw Error('STUDIO_SESSION_IMAGE_INVALID');
  return {file:new File([data],ref.name||'session-image',{type:ref.mediaType}),source:{sessionId,eventSeq,attachmentId:ref.attachmentId}};
}
