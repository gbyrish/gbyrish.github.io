// Halpish AI provider — BlockRun (primary) with Groq and Anthropic fallback.
//
// This is the ONLY module that talks to a model provider. Swapping models means
// changing HALPISH_MODEL; swapping providers means changing this file. Nothing
// else in Halpish knows the gateway URL, the wire format, or the API key.
//
// The key is read from the environment on the server. It is never sent to the
// browser and never appears in a response body.

const BLOCKRUN_URL = 'https://blockrun.ai/api/v1/chat/completions';

export function modelName(){
  return process.env.HALPISH_MODEL || 'nvidia/gpt-oss-120b';
}

function blockrunKey(){
  return process.env.BLOCKRUN_API_KEY || null;
}

// Groq is used as a fallback when BlockRun fails.
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

// Anthropic direct API is used as a secondary fallback.
const ANTHROPIC_KEY = () => process.env.ANTHROPIC_API_KEY;

async function anthropicFallback({ messages, tools, stream, maxTokens, temperature, timeoutMs }){
  const key = ANTHROPIC_KEY();
  if(!key) return null;

  // Convert OpenAI-style messages/tools to Anthropic format.
  const antMessages = messages.map(m => {
    if(m.role === 'user' || m.role === 'system') return { role: m.role, content: m.content };
    if(m.role === 'assistant'){
      const out = { role: 'assistant', content: [] };
      if(m.content) out.content.push({ type: 'text', text: m.content });
      for(const tc of (m.tool_calls || [])){
        let args = tc.function?.arguments || '{}';
        if(typeof args === 'string'){
          try { args = JSON.parse(args); } catch { /* keep as string */ }
        }
        out.content.push({ type: 'tool_use', id: tc.id, name: tc.function?.name, input: args });
      }
      return out;
    }
    if(m.role === 'tool'){
      return { role: 'user', content: [{ type: 'tool_result', tool_use_id: m.tool_call_id, content: m.content }] };
    }
    return { role: 'user', content: m.content };
  });

  const sysMessages = antMessages.filter(m => m.role === 'system');
  const nonSys = antMessages.filter(m => m.role !== 'system');
  const system = sysMessages.map(m => m.content).join('\n\n') || undefined;

  const body = {
    model: modelName(),
    max_tokens: maxTokens,
    temperature,
    stream,
    messages: nonSys,
    ...(system ? { system } : {}),
  };
  if(tools && tools.length){
    body.tools = tools.map(t => ({
      name: t.function.name,
      description: t.function.description || '',
      input_schema: t.function.parameters || { type: 'object', properties: {} },
    }));
    body.tool_choice = { type: 'auto' };
  }

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout ? AbortSignal.timeout(timeoutMs) : undefined,
  });

  if(!res.ok){
    const text = await res.text().catch(() => '');
    throw new ProviderError(`Anthropic ${res.status}: ${text.slice(0, 300)}`, { status: res.status, kind: 'billing' });
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

  const brKey = blockrunKey();
  let lastErr = null;

  // If BlockRun has no key configured, skip straight to Groq fallback.
  if(!brKey){
    const fb = await groqFallback({ messages, tools, stream, maxTokens, temperature, timeoutMs });
    if(fb) return fb;
    throw new ProviderError('No AI provider configured. Set BLOCKRUN_API_KEY or GROQ_API_KEY.', { kind: 'config' });
  }

  for(let attempt = 1; attempt <= attempts; attempt++){
    const timer = AbortSignal.timeout ? AbortSignal.timeout(timeoutMs) : undefined;
    let res;
    try{
      res = await fetch(BLOCKRUN_URL, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${brKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: timer,
      });
    }catch(err){
      lastErr = new ProviderError(err?.name === 'TimeoutError' ? 'Model request timed out.' : `Network error: ${err?.message || err}`,
        { kind: err?.name === 'TimeoutError' ? 'timeout' : 'network', retryable: true });
      if(attempt < attempts){ await sleep(400 * attempt); continue; }
      return await groqFallback({ messages, tools, stream, maxTokens, temperature, timeoutMs }).catch(fbErr => {
        throw lastErr;
      });
    }

    if(res.ok){ return stream ? res : await res.json(); }

    const text = await res.text().catch(() => '');
    const { kind, retryable } = classify(res.status, text);
    lastErr = new ProviderError(`BlockRun ${res.status}: ${text.slice(0, 300)}`, { status: res.status, kind, retryable });

    if(retryable && attempt < attempts){
      const ra = Number(res.headers.get('retry-after'));
      await sleep(Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, 4000) : 2000 * attempt);
      continue;
    }

    // On auth/billing errors, try Groq fallback.
    if(['billing','auth','config'].includes(kind)){
      return await groqFallback({ messages, tools, stream, maxTokens, temperature, timeoutMs }).catch(fbErr => {
        throw lastErr;
      });
    }

    throw lastErr;
  }
  throw lastErr || new ProviderError('Model request failed.', { kind: 'unknown' });
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
