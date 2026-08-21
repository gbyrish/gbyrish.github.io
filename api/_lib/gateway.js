// Halpish AI provider — Ollama Cloud (primary) with Groq fallback.
//
// This is the ONLY module that talks to a model provider. Swapping models means
// changing HALPISH_MODEL; swapping providers means changing this file. Nothing
// else in Halpish knows the gateway URL, the wire format, or the API key.
//
// The key is read from the environment on the server. It is never sent to the
// browser and never appears in a response body.

const OLLAMA_URL = 'https://api.ollama.com/api/chat';

export function modelName(){
  return process.env.HALPISH_MODEL || 'minimax-m3';
}

function ollamaKey(){
  return process.env.OLLAMA_API_KEY;
}

// Convert OpenAI-style messages to Ollama-native format.
// Ollama expects tool messages with role "tool" and content as a JSON array
// of { name, content } objects, plus role "assistant" messages with tool_calls
// should have tool_call_id matching the tool message.
function toOllamaMessages(messages){
  return messages.map(m => {
    if(m.role === 'tool'){
      // Ollama wants tool results as a JSON array string in content
      // with the tool name embedded, or as a structured format.
      // The working format: role "tool", content = raw result string
      return { role: 'tool', content: String(m.content || '') };
    }
    if(m.tool_calls){
      // assistant message with tool_calls
      const out = { role: 'assistant' };
      if(m.content) out.content = m.content;
      // Ollama accepts OpenAI-style tool_calls
      out.tool_calls = m.tool_calls.map(tc => ({
        id: tc.id,
        type: 'function',
        function: tc.function,
      }));
      return out;
    }
    return { role: m.role, content: m.content };
  });
}

// Normalize Ollama tool_call arguments — they may already be parsed or a string.
function normalizeToolCalls(tcs){
  if(!tcs) return [];
  return tcs.map(tc => {
    const fn = tc.function || {};
    let args = fn.arguments;
    if(typeof args === 'string'){
      try { args = JSON.parse(args); } catch { args = {}; }
    }
    return {
      id: tc.id || `call_${Math.random().toString(36).slice(2, 10)}`,
      type: 'function',
      function: { name: fn.name || '', arguments: args },
    };
  });
}

async function ollamaCall({ messages, tools, stream, maxTokens, temperature, timeoutMs }){
  const key = ollamaKey();
  if(!key) return null;

  const body = {
    model: modelName(),
    messages: toOllamaMessages(messages),
    options: {
      num_predict: maxTokens,
      temperature,
    },
  };
  if(tools && tools.length){
    body.tools = tools;
  }
  // Ollama doesn't support stream with tools — always do non-streaming
  if(tools && tools.length) body.stream = false;
  else body.stream = !!stream;

  const res = await fetch(OLLAMA_URL, {
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
    if(res.status === 401 || res.status === 402 || res.status === 403) return null;
    throw new ProviderError(`Ollama ${res.status}: ${text.slice(0, 300)}`, { status: res.status, kind: 'billing' });
  }

  if(!stream || (tools && tools.length)){
    // Non-streaming: return parsed JSON in OpenAI-compatible shape
    const data = await res.json();
    const msg = data.message || {};
    return {
      choices: [{
        message: {
          role: msg.role || 'assistant',
          content: msg.content || null,
          tool_calls: normalizeToolCalls(msg.tool_calls),
        },
        finish_reason: data.done_reason || (msg.tool_calls ? 'tool_calls' : 'stop'),
      }],
      usage: { prompt_tokens: data.prompt_eval_count || 0, completion_tokens: data.eval_count || 0, total_tokens: (data.prompt_eval_count || 0) + (data.eval_count || 0) },
    };
  }

  // Streaming: return raw response and wrap in OpenAI-compatible SSE
  return { stream: true, rawRes: res };
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
 * Returns a wrapper object when `stream` is true (caller uses .readStream()),
 * or the parsed JSON body when false. Retries rate limits and 5xx a couple
 * of times with backoff; everything else fails fast as a ProviderError.
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

  let lastErr = null;

  // Try Ollama first.
  try{
    const orRes = await ollamaCall({ messages, tools, stream, maxTokens, temperature, timeoutMs });
    if(orRes) return orRes;
  }catch(e){
    lastErr = e;
    if(!(e instanceof ProviderError)) console.error('Ollama error:', e.message);
  }

  // Ollama failed — try Groq fallback.
  try{
    const groqRes = await groqFallback({ messages, tools, stream, maxTokens, temperature, timeoutMs });
    if(groqRes) return groqRes;
  }catch(e){
    lastErr = e;
    if(!(e instanceof ProviderError)) console.error('Groq error:', e.message);
  }

  throw lastErr || new ProviderError('No AI provider available. Set OLLAMA_API_KEY or GROQ_API_KEY.', { kind: 'config' });
}

/**
 * Parse a provider response into { text, toolCalls, finish }.
 *
 * Handles both OpenAI-style SSE streams and Ollama's native format.
 */
export async function readStream(res, { onText } = {}){
  if(!res) return { text: '', toolCalls: [], finish: null };

  // Ollama streaming: newline-delimited JSON (not SSE)
  if(res.stream && res.rawRes){
    const reader = res.rawRes.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let text = '';
    const tcs = [];
    let finish = null;

    while(true){
      const { value, done } = await reader.read();
      if(done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for(const line of lines){
        if(!line.trim()) continue;
        let json;
        try { json = JSON.parse(line); } catch { continue; }

        const msg = json.message || {};
        if(msg.content){
          text += msg.content;
          if(onText) await onText(msg.content);
        }
        for(const tc of (msg.tool_calls || [])){
          const i = tc.function?.index ?? 0;
          const slot = tcs[i] || (tcs[i] = { id: '', type: 'function', function: { name: '', arguments: '' } });
          if(tc.id) slot.id = tc.id;
          if(tc.function?.name) slot.function.name = tc.function.name;
          if(tc.function?.arguments !== undefined){
            slot.function.arguments = typeof tc.function.arguments === 'string' ? tc.function.arguments : JSON.stringify(tc.function.arguments);
          }
        }
        if(json.done){
          finish = json.done_reason || 'stop';
          // Flush any remaining thinking content
          if(msg.thinking && onText) await onText('');
        }
      }
    }
    return { text, toolCalls: tcs.filter(Boolean), finish };
  }

  // OpenAI-style SSE stream (Groq, OpenRouter, etc.)
  if(res.body){
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let text = '';
    let finish = null;
    const tcs = [];

    async function eatLine(line){
      if(!line.startsWith('data:')) return;
      let payload = line.slice(5).trim();
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
    return { text, toolCalls: tcs.filter(Boolean), finish };
  }

  // Non-streaming JSON response (from chat() returning parsed JSON)
  const data = res;
  if(data?.choices){
    const msg = data.choices[0]?.message || {};
    const tcs = normalizeToolCalls(msg.tool_calls);
    const text = msg.content || '';
    // Fire onText for non-streaming so callers that track anyText still work
    if(text && onText) await onText(text);
    return {
      text,
      toolCalls: tcs,
      finish: data.choices[0]?.finish_reason || 'stop',
    };
  }
  return { text: '', toolCalls: [], finish: null };
}
