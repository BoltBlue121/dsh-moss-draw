import {isShortStudioConsentQuestion} from './studio-consent-presentation.mjs';
// Host-only provenance projection. Never reads a database, transcript, other session or wire view.
// Original request result -> visible original question -> first/latest native human reply.
const KEY = 'moss-draw.consent-authority';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DIGEST = /^[0-9a-f]{64}$/;
const id = value => typeof value === 'string' && value.length > 0 && value.length <= 200;
const positive = value => Number.isSafeInteger(value) && value > 0;
const normalize = text => text.replaceAll('\r\n', '\n');
function historyError() { throw Object.assign(new Error('STUDIO_CONSENT_HISTORY: Native consent provenance is unavailable or invalid.'), { code: 'STUDIO_CONSENT_HISTORY' }); }
function initial(header, inherited = 0) {
  if (!id(header?.id) || !Number.isSafeInteger(inherited) || inherited < 0) historyError();
  return { session_id: header.id, inherited_count: inherited, last_seq: -1, message_id: null, reply_only: false, text_only: false,
    seen_message_ids: [], seen_call_ids: [], pending_calls: {}, pending: null, decisions: {}, retryable_ids: [] };
}
function output(state) { return structuredClone({ session_id: state.session_id, message_id: state.message_id, reply_only: state.reply_only, text_only: state.text_only, decisions: state.decisions }); }
function invalidate(state) {
  const decisions = Object.fromEntries(Object.entries(state.decisions).map(([key, value]) => [key, { ...value, status: 'invalid' }]));
  return { ...state, decisions, pending: null, retryable_ids: [] };
}
function invalidatePending(state) {
  if (!state.pending) return state;
  const key = state.pending.consent_id;
  return { ...state, pending: null, decisions: { ...state.decisions, [key]: { ...state.decisions[key], status: 'invalid' } } };
}
function validQuestion(value, consentId, version) {
  if (typeof value !== 'string' || new TextEncoder().encode(value).length > 65536) return false;
  const text = normalize(value);
  if (version === 2) return isShortStudioConsentQuestion(text);
  // Legacy history remains replayable; the store invalidates legacy pending requests.
  return text.startsWith(`【工作台确认 ${consentId}】\n`) && text.endsWith('\n【确认结束】')
    && text.split('【工作台确认 ').length === 2 && text.split('【确认结束】').length === 2;
}
function visibleText(text) {
  const plain = normalize(text).replace(/^\s*>\s?/gm, '').replace(/\*\*|__|~~/g, '').trim();
  // Code/HTML can quote or hide a question rather than actually ask it.
  if (/[`<>]|\u202a|\u202b|\u202d|\u202e|\u2066|\u2067|\u2068/iu.test(plain)) return null;
  return plain.replace(/^【工作台确认 [^\n]+】\n|\n【确认结束】$/gu, '').trim();
}
const compact = text => text.replace(/\s+/gu, '');
function generationSignals(text) {
  const found = new Set();
  for (const clause of text.split(/[，,。；;\n!?？！]/u)) {
    for(const match of clause.matchAll(/生成|生图|出(?:新)?图|绘制|\b(?:generat(?:e|ing)|draw(?:ing)?|render(?:ing)?)\b/giu)){
      if(/^(?:次数|额度|权限|预算)/u.test(clause.slice(match.index+match[0].length).trim()))continue;
      const before=clause.slice(0,match.index).trim();
      const negative=/(?:不|不会|不要|不能|无需|无须|勿|别|禁止|停止)(?:再|继续|进行)?\s*$|\b(?:not|never|without|don't)\s*$/iu.test(before);
      found.add(negative?'no':'yes');
    }
  }
  return found;
}
function quantity(value) {
  if (/^\d+$/u.test(value)) return Number(value);
  const digit = {零:0,一:1,二:2,两:2,三:3,四:4,五:5,六:6,七:7,八:8,九:9};
  if (value === '十') return 10;
  if (value.includes('十')) { const [a,b] = value.split('十'); return (a ? digit[a] : 1) * 10 + (b ? digit[b] : 0); }
  return digit[value];
}
function generationCounts(text) {
  return [...compact(text).matchAll(/(?:生成|生图|出图)(?:[，,]?(?:最多|用|剩余|可用))*([\d零一二两三四五六七八九十]+)(?:张|次)/gu)].map(m => quantity(m[1]));
}
function allowanceCounts(text) {
  const value=compact(text), counts=[];
  for(const match of value.matchAll(/(?:增加|追加|新开|加)([\d零一二两三四五六七八九十]+)(?:张|次)/gu)){
    if(!/(?:不|别|勿)(?:再)?$/u.test(value.slice(Math.max(0,match.index-3),match.index)))counts.push(quantity(match[1]));
  }
  return counts;
}
function displayed(text, question) {
  const plain = visibleText(text), original = visibleText(question);
  if (!plain || !original || plain.length > 4000) return false;
  const questions = [...plain.matchAll(/[?？]/gu)];
  if (questions.length !== 1) return false;
  const questionText = plain.slice(0, questions[0].index).split(/[。!！;；\n]/u).at(-1).trim();
  const short = questionText.split(/[，,]/u).at(-1).trim();
  const simple = /^(?:(?:你|您)(?:是否)?)?(?:同意|可以|确认|行|好)(?:吗|么)$/u.test(short) || /^(?:是否同意|请确认)$/u.test(short);
  const operation = /^(?:(?:你|您)(?:是否)?同意|是否|要不要|能否|可否|请确认是否)(?:采纳|接受|应用|执行|拒绝|继续生成|生成|出图|交回|恢复|退出).{0,100}?(?:吗|么)?$/u.test(questionText)
    || /^(?:(?:may|shall|can|should)\s+(?:i|we)\s+(?:apply|accept|proceed|resume|generate|draw)|do you\s+(?:agree|approve|confirm)\s+(?:this|the|applying|generating)).{0,100}$/iu.test(questionText);
  if (!simple && !operation) return false;
  const bareQuestion = compact(plain) === compact(short + plain[questions[0].index]);
  if (!bareQuestion && !/(?:采纳|提案|方案|校准|稿件|生成|生图|出图|额度|次数|交回|恢复|退出|apply|proposal|generate|draw|resume)/iu.test(plain)) return false;
  // The receipt remains authoritative, but reject visible contradictions rather
  // than interpreting a natural paraphrase as permission for a wider operation.
  const expected = generationSignals(original), actual = generationSignals(plain);
  if (actual.has('yes') && !expected.has('yes') || actual.has('no') && expected.has('yes') && !expected.has('no')) return false;
  const counts = generationCounts(original), mentioned = generationCounts(plain);
  if (mentioned.length && (!counts.length || mentioned.some(n => !counts.includes(n)))) return false;
  const allowance=allowanceCounts(original), shownAllowance=allowanceCounts(plain);
  if(shownAllowance.some(n=>!allowance.includes(n)) || allowance.length && /(?:额度不变|不(?:增加|追加)|不加次数)/u.test(compact(plain)))return false;
  const backends = original.match(/\b(?:Moss|K2|Qwen)\b/giu) ?? [];
  if (backends.length && (plain.match(/\b(?:Moss|K2|Qwen)\b/giu) ?? []).some(b => !backends.some(x => x.toLowerCase() === b.toLowerCase()))) return false;
  return true;
}
function directDrawingRequest(message) {
  if (message.content.some(part => part?.type !== 'text' || typeof part.text !== 'string')) return false;
  const text = message.content.map(part => part.text).join('\n').trim();
  // In a confirmation context, ambiguity is a reply, not fresh run authority.
  if (/[?？]|(?:是否|能否|可否|先等|取消)|(?:不|别|勿|禁止|无需|不要)(?:再|只|先|继续|立即|马上|\s)*(?:画|绘制|生图|出图|生成|执行)|\b(?:do\s+not|don't|never|no)\s+(?:draw|generate|render|create|make)|\b(?:wait|cancel)\b/iu.test(text)) return false;
  if (/^(?:同意|可以|好|行|确认|不同意|yes\b|ok\b|okay\b|sure\b)/iu.test(text)) return false;
  return /(?:请|帮我|给我|为我|现在|重新|再|用[^，,。\n]{1,30})(?:[^。\n]{0,30}?)(?:画|生成|绘制|出图)(?:[^。\n]{2,})/u.test(text)
    || /^(?:画|生成|绘制)(?:一|两|二|三|\d|幅|张|个|只)[^。\n]{1,}/u.test(text)
    || /\b(?:please\s+)?(?:draw|generate|render|create|make)\s+(?:a|an|one|another|\d+)\s+\S+/iu.test(text);
}
function replyStatus(message, consentId) {
  if (!Array.isArray(message.content) || message.content.length !== 1 || message.content[0]?.type !== 'text'
    || typeof message.content[0].text !== 'string') return 'ambiguous';
  const text = message.content[0].text.trim().replace(/[。.!！]+$/u, '').trim().toLowerCase();
  const match = (words) => words.some(word => text === word || text === `${word} ${consentId}` || text === `${word} ${consentId.slice(0,8)}`);
  if (match(['同意', '可以', '按这个来', '确认', '好', '好的', '行', '没问题', '就按这个来', 'yes', 'ok', 'okay', 'sure', 'confirm'])) return 'approved';
  if (match(['不同意', '不行', '不可以', '取消', '先别执行', 'no', 'cancel'])) return 'rejected';
  return 'ambiguous';
}
function originalMessage(event) {
  if (event.surfaceOp !== 'append' || event.sourceEventSeqs !== undefined) return null;
  const message = event.type === 'user/message' ? event.data : event.data?.message;
  return message && id(message.id) && Array.isArray(message.content) ? message : null;
}
function applyEvent(state, event) {
  if (!Number.isSafeInteger(event?.seq) || event.seq < 0 || event.seq <= state.last_seq) historyError();
  let next = { ...state, last_seq: event.seq };
  if (event.seq < state.inherited_count) return next; // Fork inheritance is not consent in the child Session.
  if (['step/start', 'step/end', 'turn/start', 'turn/end'].includes(event.type)) return { ...next, pending_calls: {} };
  if (event.type === 'user/message') {
    const message = originalMessage(event);
    if (message?.role !== 'user' || message.source?.kind !== 'user') return next;
    if (state.seen_message_ids.includes(message.id)) return { ...invalidate(next), pending_calls: {} };
    const reply = replyStatus(message, state.pending?.consent_id ?? '');
    const displayedPending = state.pending && state.decisions[state.pending.consent_id]?.question_message_id;
    // Without a displayed, unanswered receipt every human message is a new native instruction.
    // While one is displayed, exact yes/no and ambiguous, negative or qualified text stay replies;
    // only a substantive new drawing request leaves the question behind.
    // A bare exact refusal is never fresh run authority, even without a displayed question.
    const replyOnly = displayedPending ? (reply !== 'ambiguous' || !directDrawingRequest(message)) : reply === 'rejected';
    next = { ...next, message_id: message.id, reply_only: replyOnly, text_only: message.content.some(p => p?.type==='text' && /禁止 prepare、execute、生成图片|不得生成图片或调用GPU/u.test(p.text)), seen_message_ids: [...state.seen_message_ids, message.id], pending_calls: {} };
    const pending = state.pending;
    const previous = state.decisions[pending?.consent_id];
    next = invalidate(next);
    // An early yes after an invalid display is not authorization, but need not
    // permanently poison a still-unanswered receipt. Rejection/new scope does.
    if (reply === 'approved' && !previous?.question_message_id) next.retryable_ids = [...state.retryable_ids];
    if (replyOnly && pending && previous && previous.question_message_id) {
      next.decisions[pending.consent_id] = { ...previous, status: replyStatus(message, pending.consent_id), message_id: message.id };
    }
    return next;
  }
  if (event.type === 'tool/call') {
    const call = event.data;
    if (call?.name !== 'art_generate' || !id(call.callId) || !state.message_id
      || event.surfaceOp !== undefined || event.sourceEventSeqs !== undefined) return next;
    if (state.seen_call_ids.includes(call.callId)) {
      const calls = { ...state.pending_calls }; delete calls[call.callId];
      return { ...next, pending_calls: calls };
    }
    let args;
    try { args = typeof call.arguments === 'string' ? JSON.parse(call.arguments) : call.arguments; } catch { return next; }
    const input = args?.workbench;
    if (args?.mode !== 'workbench' || input?.action !== 'studioRequestConsent' || !id(input.page_id)
      || !positive(input.expected_revision) || !id(input.request_key)) return next;
    return { ...next, seen_call_ids: [...state.seen_call_ids, call.callId], pending_calls: { ...state.pending_calls,
      [call.callId]: { message_id: state.message_id, page_id: input.page_id, expected_revision: input.expected_revision, request_key: input.request_key } } };
  }
  if (event.type === 'tool/result') {
    const message = originalMessage(event);
    if (message?.role !== 'tool' || message.source?.kind !== 'tool' || message.source.callId !== message.toolCallId
      || !Object.hasOwn(state.pending_calls, message.toolCallId) || state.seen_message_ids.includes(message.id)) return next;
    const call = state.pending_calls[message.toolCallId], calls = { ...state.pending_calls }; delete calls[message.toolCallId];
    next = { ...next, pending_calls: calls, seen_message_ids: [...state.seen_message_ids, message.id] };
    if (message.isError !== false || call.message_id !== state.message_id || message.content.length !== 1 || message.content[0]?.type !== 'text') return next;
    let receipt;
    try { receipt = JSON.parse(message.content[0].text)?.consent; } catch { return next; }
    if (!receipt || !UUID.test(receipt.consent_id) || !DIGEST.test(receipt.presentation_digest)
      || receipt.page_id !== call.page_id || receipt.expected_revision !== call.expected_revision || receipt.request_key !== call.request_key
      || !['pending', 'presented'].includes(receipt.status) || !validQuestion(receipt.question, receipt.consent_id, receipt.presentation_version)) return next;
    // Only a never-displayed/never-answered failed presentation can recover.
    // A consumed, rejected, displaced or superseded decision is never rearmed.
    if (Object.hasOwn(state.decisions, receipt.consent_id)) {
      const previous = state.decisions[receipt.consent_id];
      if (previous.request_digest !== receipt.presentation_digest) return invalidate(next);
      if (!state.retryable_ids.includes(receipt.consent_id) || previous.message_id || previous.question_message_id) return next;
    }
    next = invalidate(next);
    return { ...next, retryable_ids: [receipt.consent_id], pending: { consent_id: receipt.consent_id, question: receipt.question, request_message_id: call.message_id },
      decisions: { ...next.decisions, [receipt.consent_id]: { status: 'invalid', message_id: null,
        request_digest: receipt.presentation_digest, question_message_id: null } } };
  }
  if (event.type === 'assistant/message') {
    const message = originalMessage(event);
    if (message?.role !== 'assistant' || message.source?.kind !== 'model' || !id(message.source.provider) || !id(message.source.model)) return next;
    if (state.seen_message_ids.includes(message.id)) return invalidatePending(next);
    next = { ...next, seen_message_ids: [...state.seen_message_ids, message.id] };
    if (!state.pending) return next; // Execution explanations cannot revoke an already answered question.
    // Only reasoning and native tool calls are non-user-facing parts. Unknown/new parts fail closed.
    if (message.content.some(part => !part || !['text', 'thinking', 'tool-call'].includes(part.type)
      || part.type === 'text' && typeof part.text !== 'string')) return invalidatePending(next);
    const texts = message.content.filter(part => part.type === 'text').map(part => part.text);
    if (!texts.some(text => text.trim())) return next;
    const pending = state.pending, previous = state.decisions[pending.consent_id];
    // Text parts belong to one visible utterance; explanations and harmless
    // Markdown are not additional consent rounds. Another question still closes it.
    if (previous.question_message_id || !displayed(texts.join('\n'), pending.question)) return invalidatePending(next);
    return { ...next, retryable_ids: [], decisions: { ...state.decisions, [pending.consent_id]: { ...previous, question_message_id: message.id } } };
  }
  return next;
}
function dataObject(value, fields) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) historyError();
  const keys = Reflect.ownKeys(value);
  if (fields && (keys.length !== fields.length || keys.some(key => !fields.includes(key)))) historyError();
  for (const key of keys) { const d = Object.getOwnPropertyDescriptor(value, key); if (typeof key !== 'string' || !d.enumerable || !Object.hasOwn(d, 'value')) historyError(); }
  return value;
}
function idList(value) {
  if (!Array.isArray(value) || Reflect.ownKeys(value).length !== value.length + 1) historyError();
  for (let i = 0; i < value.length; i++) {
    const d = Object.getOwnPropertyDescriptor(value, String(i));
    if (!d || !d.enumerable || !Object.hasOwn(d, 'value') || !id(d.value)) historyError();
  }
  if (new Set(value).size !== value.length) historyError();
}
function parseState(value) {
  dataObject(value, ['session_id', 'inherited_count', 'last_seq', 'message_id', 'reply_only', 'text_only', 'seen_message_ids', 'seen_call_ids', 'pending_calls', 'pending', 'decisions', 'retryable_ids']);
  if (typeof value.reply_only !== 'boolean' || typeof value.text_only !== 'boolean' || !id(value.session_id) || !Number.isSafeInteger(value.inherited_count) || value.inherited_count < 0
    || !Number.isSafeInteger(value.last_seq) || value.last_seq < -1) historyError();
  idList(value.seen_message_ids); idList(value.seen_call_ids);
  if (value.message_id !== null && (!id(value.message_id) || !value.seen_message_ids.includes(value.message_id))) historyError();
  for (const [key, call] of Object.entries(dataObject(value.pending_calls))) {
    dataObject(call, ['message_id', 'page_id', 'expected_revision', 'request_key']);
    if (!value.seen_call_ids.includes(key) || call.message_id !== value.message_id || !id(call.message_id) || !id(call.page_id)
      || !positive(call.expected_revision) || !id(call.request_key)) historyError();
  }
  for (const [key, decision] of Object.entries(dataObject(value.decisions))) {
    dataObject(decision, ['status', 'message_id', 'request_digest', 'question_message_id']);
    if (!UUID.test(key) || !['approved', 'rejected', 'ambiguous', 'invalid'].includes(decision.status) || !DIGEST.test(decision.request_digest)) historyError();
    for (const field of ['message_id', 'question_message_id']) if (decision[field] !== null && (!id(decision[field]) || !value.seen_message_ids.includes(decision[field]))) historyError();
    if (decision.status !== 'invalid' && (!decision.question_message_id || decision.message_id !== value.message_id || !decision.message_id)) historyError();
  }
  if (value.pending !== null) {
    dataObject(value.pending, ['consent_id', 'question', 'request_message_id']);
    const pending = value.pending, decision = value.decisions[pending.consent_id];
    if (!UUID.test(pending.consent_id) || !(isShortStudioConsentQuestion(pending.question) || validQuestion(pending.question, pending.consent_id)) || !decision || decision.status !== 'invalid'
      || decision.message_id !== null || pending.request_message_id !== value.message_id || !id(pending.request_message_id)) historyError();
  }
  idList(value.retryable_ids);
  if (value.retryable_ids.length > 1) historyError();
  for (const key of value.retryable_ids) {
    const decision = value.decisions[key];
    if (!UUID.test(key) || !decision || decision.status !== 'invalid' || decision.message_id !== null || decision.question_message_id !== null) historyError();
  }
  if (Object.values(value.decisions).filter(d => d.status !== 'invalid').length > 1) historyError();
  return structuredClone(value);
}
/** Synthetic/read-only replay. Production always uses the native projection registry below. */
export function studioConsentAuthorityFromEvents(events, { session_id = 'consent-replay', inherited_event_count = 0 } = {}) {
  let state = initial({ id: session_id }, inherited_event_count);
  for (const event of events) state = applyEvent(state, event);
  return output(state);
}
export function registerStudioConsentAuthority(registry) {
  if (typeof registry?.register !== 'function' || typeof registry.stateOf !== 'function') historyError();
  // Rebuild old checkpoints from original events; never reinterpret their consent state.
  registry.register({ key: KEY, stateVersion: 4, stateSchema: { parse: parseState }, init: initial, apply: applyEvent });
  return exec => {
    const session = exec?.agent?.session;
    if (!session || !id(session.id)) historyError();
    const state = registry.stateOf(session, KEY);
    if (!state || state.session_id !== session.id || state.inherited_count !== (session.inheritedEventCount ?? 0)) historyError();
    return output(state);
  };
}
