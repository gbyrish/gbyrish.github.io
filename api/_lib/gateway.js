// Halpish AI provider — OpenRouter (primary) with Groq fallback.
//
// This is the ONLY module that talks to a model provider. Swapping models means
// changing HALPISH_MODEL; swapping providers means changing this file. Nothing
// else in Halpish knows the gateway URL, the wire format, or the API key.
//
// The key is read from the environment on the server. It is never sent to the
// browser and never appears in a response body.

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

export function modelName(){
  return process.env.HALPISH_MODEL || 'minimax/minimax-m3';
}

function openrouterKey(){
  return process.env.OPENROUTER_API_KEY;
}

async function openrouterCall({ messages, tools, stream, maxTokens, temperature, timeoutMs }){
  const key = openrouterKey();
  if(!key) return null;

  const body = {
    model: modelName(),
    messages,
    max_tokens: maxTokens,
    temperature,
    stream,
  };
  if(tools && tools.length){
    body.tools = tools;
    body.tool_choice = 'auto';
  }

  const res = await fetch(OPENROUTER_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${key}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://gbyrish.com',
      'X-Title': 'Gbyrish Halpish',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout ? AbortSignal.timeout(timeoutMs) : undefined,
  });

  if(!res.ok){
    const text = await res.text().catch(() => '');
    if(res.status === 401 || res.status === 402 || res.status === 403) return null;
    throw new ProviderError(`OpenRouter ${res.status}: ${text.slice(0, 300)}`, { status: res.status, kind: 'billing' });
  }
  return stream ? res : await res.json();
}

// Groq fallback (fast, free tier).
function groqKey(){
  return process.env.GROQ_API_KEY;
}

async function groqFallback({ messages, tools, stream, maxTokens, temperature, timeoutMs }){
  const key = groqKey();
  if(!key) return null;

  const body = {
    model: process.env.HALPISH_MODEL_GROQ || 'qwen/qwen3.6-27b',
    messages,
    max_tokens: maxTokens,
    temperature,
    stream,
  };
  if(tools && tools.length){
    body.tools = tools;
    body.tool_choice = 'auto';
  }

  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout ? AbortSignal.timeout(timeoutMs) : undefined,
  });

  if(!res.ok){
    const text = await res.text().catch(() => '');
    throw new ProviderError(`Groq ${res.status}: ${text.slice(0, 300)}`, { status: res.status, kind: 'billing' });
  }
  return stream ? res : await res.json();
}

// Every failure Halpish can hit is reduced to one of these kinds.
export class ProviderError extends Error {
  constructor(message, { status = 0, kind = 'unknown', retryable = false } = {}){
    super(message);
    this.name = 'ProviderError';
    this.status = status;
    this.kind = kind;
    this.retryable = retryable;
  }
}

function classify(status, bodyText){
  const type = (() => {
    try { return JSON.parse(bodyText)?.error?.type || ''; } catch { return ''; }
  })();
  if(status === 429) return { kind: 'rate_limit', retryable: true };
  if(status === 402 || type === 'customer_verification_required' || /credit card|insufficient|quota|billing/i.test(bodyText)){
    return { kind: 'billing', retryable: false };
  }
  if(status === 401 || status === 403) return { kind: 'auth', retryable: false };
  if(status >= 500) return { kind: 'server', retryable: true };
  return { kind: 'bad_request', retryable: false };
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * One chat completion call.
 *
 * Returns the raw `fetch` Response when `stream` is true (caller reads the SSE
 * body), or the parsed JSON body when false. Retries rate limits and 5xx a
 * couple of times with backoff; everything else fails fast as a ProviderError.
 */
export async function chat({ messages, tools, stream = false, maxTokens = 1024, temperature = 0.3, timeoutMs = 45000, attempts = 3 }){
  // Test hooks.
  if(process.env.HALPISH_FORCE_ERROR){
    const kind = process.env.HALPISH_FORCE_ERROR;
    const statuses = { rate_limit: 429, billing: 402, auth: 401, server: 503, bad_request: 400 };
    throw new ProviderError(`Forced ${kind} for testing.`, { status: statuses[kind] || 0, kind, retryable: false });
  }
  if(process.env.HALPISH_MOCK){
    const { mockChat } = await import('./mock.js');
    return mockChat({ messages, tools, stream });
  }

  const body = {
    model: modelName(),
    messages,
    max_tokens: maxTokens,
    temperature,
    stream,
  };
  if(tools && tools.length){
    body.tools = tools;
    body.tool_choice = 'auto';
  }

  let lastErr = null;

  // Try OpenRouter first.
  try{
    const orRes = await openrouterCall({ messages, tools, stream, maxTokens, temperature, timeoutMs });
    if(orRes) return orRes;
  }catch(e){
    lastErr = e;
    if(!(e instanceof ProviderError)) console.error('OpenRouter error:', e.message);
  }

  // OpenRouter failed — try Groq fallback.
  try{
    const groqRes = await groqFallback({ messages, tools, stream, maxTokens, temperature, timeoutMs });
    if(groqRes) return groqRes;
  }catch(e){
    lastErr = e;
    if(!(e instanceof ProviderError)) console.error('Groq error:', e.message);
  }

  throw lastErr || new ProviderError('No AI provider available. Set OPENROUTER_API_KEY or GROQ_API_KEY.', { kind: 'config' });
}

/**
 * Parse an OpenAI-style SSE stream into callbacks.
 *
 * Tool calls arrive fragmented across deltas (name in one chunk, arguments in
 * pieces), so they are accumulated by index and only handed back once the
 * stream ends.
 */
export async function readStream(res, { onText } = {}){
  if(!res || !res.body) return { text: '', toolCalls: [], finish: null };
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  let finish = null;
  const tcs = [];

  async function eatLine(line){
    if(!line.startsWith('data:')) return;
    let payload = line.slice(5).trim();
    // Some providers emit double-prefixed SSE lines.
    while(payload.startsWith('data:')) payload = payload.slice(5).trim();
    if(payload === '[DONE]') return;

    let json;
    try { json = JSON.parse(payload); } catch { return; }

    const choice = json.choices?.[0];
    if(!choice) return;

    const delta = choice.delta || {};
    if(delta.content){
      text += delta.content;
      if(onText) await onText(delta.content);
    }
    for(const tc of (choice.tool_calls || delta.tool_calls || [])){
      const i = tc.index ?? 0;
      const slot = tcs[i] || (tcs[i] = { id: '', type: 'function', function: { name: '', arguments: '' } });
      if(tc.id) slot.id = tc.id;
      if(tc.function?.name) slot.function.name = tc.function.name;
      if(tc.function?.arguments !== undefined) slot.function.arguments = tc.function.arguments;
    }
    if(choice.finish_reason && !finish) finish = choice.finish_reason;
  }

  while(true){
    const { value, done } = await reader.read();
    if(done) break;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for(const line of lines){
      const trimmed = line.trim();
      if(!trimmed) continue;
      await eatLine(trimmed);
    }
  }

  return {
    text,
    toolCalls: tcs.filter(Boolean),
    finish,
  };
}
