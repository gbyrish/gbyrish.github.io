// Helpish — the Gbyrish AI helper endpoint.
//
// POST /api/helpish
//   { mode: 'chat',        message, history[], summary, idToken?, context? }
//   { mode: 'admin_draft', message, idToken }            -> admin only
//
// Responds with an SSE stream of small JSON events:
//   { type: 'status', label }   a store lookup is running
//   { type: 'text', delta }     model output, token by token
//   { type: 'done', summary }   turn finished
//   { type: 'error', message }  customer-safe sentence, never a provider message
//   { type: 'draft', draft }    admin_draft mode only
//   { type: 'tool_call', id, name, args, preview }   a tool invocation started
//   { type: 'tool_result', id, name, result }         tool finished (success or error)
//
//   { mode: 'admin_chat',   message, history[], summary, idToken }     -> admin only
//   { mode: 'admin_confirm', message, history[], summary, idToken }    -> admin only (confirms write)

import { chat, readStream, ProviderError, modelName } from './_lib/gateway.js';
import { TOOL_SCHEMAS, runTool, CATEGORIES, CUSTOMIZABLE } from './_lib/tools.js';
import { ADMIN_TOOL_SCHEMAS, runAdminTool, isAdminTool, WRITE_TOOLS } from './_lib/admin_tools.js';
import { buildMessages, sanitizeHistory } from './_lib/conversation.js';
import { verifyIdToken, isAdmin, cleanCopy } from './_lib/store.js';
import { customerSystemPrompt, adminDraftPrompt, adminAgentPrompt } from './_lib/persona.js';

const MAX_TOOL_ROUNDS = 4;      // enough for search -> stock -> compare -> answer
const MAX_ADMIN_ROUNDS = 8;     // admin agent: more rounds for multi-step ops
const MAX_MESSAGE_CHARS = 2000;

/* ---------------- Customer-safe error copy ---------------- */

// Whatever went wrong upstream, the customer sees one of these. No status codes,
// no provider wording, no mention of tokens or quotas.
const FRIENDLY = {
  rate_limit: 'A lot of people are chatting with me right now. Give me a few seconds and send that again.',
  billing:    'I am not able to answer right now. Please message the store on WhatsApp and someone will help you straight away.',
  auth:       'I am not able to answer right now. Please message the store on WhatsApp and someone will help you straight away.',
  config:     'I am not able to answer right now. Please message the store on WhatsApp and someone will help you straight away.',
  server:     'Something on my side is not responding. Try again in a moment.',
  timeout:    'That took longer than expected. Try asking again, or keep it a little shorter.',
  network:    'I could not connect just then. Please try again.',
  bad_request:'I could not process that. Try rephrasing it.',
  unknown:    'Something went wrong on my side. Try again in a moment.',
};

const friendlyFor = (err) => FRIENDLY[err?.kind] || FRIENDLY.unknown;

/* ---------------- Prompts ---------------- */

// Helpish's identity, voice, grounding rules and boundaries live in
// _lib/persona.js. That is the file to edit when tuning how it behaves.


/* ---------------- CORS ---------------- */

// The site can be served from GitHub Pages while this function runs on Vercel, so
// every response needs CORS headers, not just the preflight.
//
// Deliberately an allow-list rather than `*`: this endpoint spends real model
// credits and accepts a Firebase ID token in the body, so any origin being able to
// call it means any site can burn the store's budget. Add origins with
// HELPISH_ALLOWED_ORIGINS (comma separated) when a new front end appears.
const DEFAULT_ORIGINS = [
  'https://gbyrish.github.io',
  'http://localhost:8080',
  'http://127.0.0.1:8080',
];

function allowedOrigins(){
  const extra = String(process.env.HELPISH_ALLOWED_ORIGINS || '')
    .split(',').map(s => s.trim().replace(/\/+$/, '')).filter(Boolean);
  return new Set([...DEFAULT_ORIGINS, ...extra]);
}

// Returns the headers to echo back, or {} when the origin isn't allowed — in which
// case the browser blocks the response and the request never reaches the model.
function corsHeaders(req){
  const origin = String(req.headers?.origin || '').replace(/\/+$/, '');
  if(!origin) return {};                       // same-origin or a non-browser caller
  if(!allowedOrigins().has(origin)) return {};
  return {
    'Access-Control-Allow-Origin': origin,     // echoed, never '*', so Vary is honest
    'Vary': 'Origin',
  };
}

// Every JSON reply goes through here so no error path forgets its CORS headers —
// a 403 without them shows the browser a CORS failure instead of the real reason.
function sendJson(req, res, status, payload){
  res.writeHead(status, { 'Content-Type': 'application/json', ...corsHeaders(req) });
  res.end(JSON.stringify(payload));
}

/* ---------------- SSE plumbing ---------------- */

function openStream(res, req){
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
    ...corsHeaders(req),
  });
  let closed = false;
  return {
    send(obj){
      if(closed) return;
      try { res.write(`data: ${JSON.stringify(obj)}\n\n`); } catch { closed = true; }
    },
    end(){
      if(closed) return;
      closed = true;
      try { res.end(); } catch { /* client already gone */ }
    },
  };
}

async function readBody(req){
  if(req.body && typeof req.body === 'object') return req.body;
  if(typeof req.body === 'string'){
    try { return JSON.parse(req.body); } catch { return {}; }
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req){
    size += chunk.length;
    if(size > 200_000) break;              // a chat turn is never this big
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
  catch { return {}; }
}

/* ---------------- Chat turn: stream + tool loop ---------------- */

// Short labels for the in-chat progress line. This is a real description of what
// Helpish is doing, not a generic spinner.
const TOOL_LABELS = {
  searchProducts: 'Looking through the catalogue',
  getProductDetails: 'Reading the product details',
  checkProductStock: 'Checking availability',
  getCategories: 'Checking the categories',
  getActiveSale: 'Checking current deals',
  getPromoInformation: 'Checking promo codes',
  getShippingInformation: 'Checking delivery and fees',
  getAuthenticatedOrder: 'Looking up your order',
  recommendGifts: 'Shortlisting gift options',
};

async function runChatTurn({ stream, messages, ctx }){
  let anyText = false;

  for(let round = 1; round <= MAX_TOOL_ROUNDS; round++){
    const isLastRound = round === MAX_TOOL_ROUNDS;

    const res = await chat({
      messages,
      tools: isLastRound ? undefined : TOOL_SCHEMAS,   // final round must answer
      stream: true,
      maxTokens: isLastRound ? 700 : 350,              // tool rounds: small budget
      temperature: 0.4,
    });

    const { text, toolCalls } = await readStream(res, {
      onText: (delta) => { anyText = true; stream.send({ type: 'text', delta }); },
    });

    if(!toolCalls.length) return { anyText };

    // Record the model's tool request, then run each tool server-side.
    messages.push({
      role: 'assistant',
      content: text || null,
      tool_calls: toolCalls.map(tc => ({ id: tc.id, type: 'function', function: tc.function })),
    });

    const labels = [...new Set(toolCalls.map(tc => TOOL_LABELS[tc.function?.name]).filter(Boolean))];
    if(labels.length) stream.send({ type: 'status', label: labels.join(' · ') });

    const results = await Promise.all(toolCalls.map(async (tc) => ({
      id: tc.id,
      name: tc.function?.name || '',
      result: await runTool(tc.function?.name, tc.function?.arguments, ctx),
    })));

    for(const r of results){
      messages.push({ role: 'tool', tool_call_id: r.id, name: r.name, content: JSON.stringify(r.result).slice(0, 12000) });
    }
    stream.send({ type: 'status', label: '' });
  }

  return { anyText };
}

/* ---------------- Admin agent turn: tool loop with confirmation ---------------- */

const ADMIN_TOOL_LABELS = {
  search_orders: 'Searching orders',
  lookup_order: 'Looking up order',
  get_today_orders: 'Fetching today\'s orders',
  get_sales_summary: 'Calculating sales',
  get_low_stock_products: 'Checking stock levels',
  update_order_status: 'Updating order status',
  cancel_order: 'Cancelling order',
  update_inventory: 'Updating inventory',
  create_product: 'Creating product',
  update_product: 'Updating product',
  create_discount: 'Creating discount',
  update_discount: 'Updating discount',
  delete_discount: 'Deleting discount',
  update_store_setting: 'Updating store setting',
};

async function runAdminAgentTurn({ stream, messages, ctx, isConfirmRound = false }){
  const startTime = Date.now();
  const timerInterval = setInterval(() => {
    stream.send({ type: 'timer', elapsed: Date.now() - startTime });
  }, 2000);

  let anyText = false;
  let pendingConfirm = null;

  try{
    for(let round = 1; round <= MAX_ADMIN_ROUNDS; round++){
      const systemContent = isConfirmRound && round === 1
        ? adminAgentPrompt() + '\n\nThe admin has confirmed the pending operation. Execute the write tool now with the confirmToken included.'
        : adminAgentPrompt();

      const roundMessages = round === 1
        ? [{ role: 'system', content: systemContent }, ...messages]
        : messages;

      const isLastRound = round === MAX_ADMIN_ROUNDS;

      const res = await chat({
        messages: roundMessages,
        tools: isLastRound ? undefined : ADMIN_TOOL_SCHEMAS,
        stream: true,
        maxTokens: isLastRound ? 700 : 350,
        temperature: 0.3,
      });

      const { text, toolCalls } = await readStream(res, {
        onText: (delta) => {
          anyText = true;
          stream.send({ type: 'text', delta });
        },
      });

      if(!toolCalls.length){
        stream.send({ type: 'done' });
        return { anyText, pendingConfirm: null };
      }

      messages.push({
        role: 'assistant',
        content: text || null,
        tool_calls: toolCalls.map(tc => ({ id: tc.id, type: 'function', function: tc.function })),
      });

      // Emit structured events so the frontend can render Cowork-style blocks
      // instead of dumping everything into one text bubble.
      for(const tc of toolCalls){
        stream.send({
          type: 'tool_call',
          id: tc.id,
          name: tc.function?.name || '',
          args: typeof tc.function?.arguments === 'string' ? tc.function.arguments : JSON.stringify(tc.function?.arguments || {}),
          label: ADMIN_TOOL_LABELS[tc.function?.name] || tc.function?.name || '',
        });
      }

      // Check if any tool call needs confirmation (write tool without confirmToken).
      for(const tc of toolCalls){
        let args = {};
        try { args = JSON.parse(tc.function?.arguments || '{}'); } catch { /* keep empty */ }
        if(isAdminTool(tc.function?.name) && WRITE_TOOLS.has(tc.function?.name) && !args.confirmToken){
          // This is a write tool without confirmation — check if we're in confirm round.
          if(!isConfirmRound){
            pendingConfirm = {
              tool: tc.function.name,
              args,
              summary: summarizeWrite(tc.function.name, args),
            };
            stream.send({ type: 'confirm', tool: tc.function.name, args, preview: pendingConfirm.summary });
            stream.send({ type: 'awaiting_confirm' });
            stream.send({ type: 'done' });
            clearInterval(timerInterval);
            return { anyText, pendingConfirm };
          }
        }
      }

      const labels = [...new Set(toolCalls.map(tc => ADMIN_TOOL_LABELS[tc.function?.name]).filter(Boolean))];
      if(labels.length) stream.send({ type: 'status', label: labels.join(' · ') });

      const results = await Promise.all(toolCalls.map(async (tc) => ({
        id: tc.id,
        name: tc.function?.name || '',
        result: await runAdminTool(tc.function?.name, tc.function?.arguments, ctx),
      })));

      for(const r of results){
        messages.push({ role: 'tool', tool_call_id: r.id, name: r.name, content: JSON.stringify(r.result).slice(0, 12000) });
        stream.send({
          type: 'tool_result',
          id: r.id,
          name: r.name,
          result: JSON.stringify(r.result).slice(0, 2000),
          error: r.result?.error ? true : false,
        });
      }
      stream.send({ type: 'status', label: '' });
    }

    stream.send({ type: 'done' });
    return { anyText, pendingConfirm: null };
  }finally{
    clearInterval(timerInterval);
  }
}

function summarizeWrite(name, args){
  switch(name){
    case 'update_order_status': return `Update order ${args.orderId} status to "${args.status}"${args.note ? ' with note: "'+args.note+'"' : ''}`;
    case 'cancel_order': return `Cancel order ${args.orderId}${args.reason ? ' (reason: "'+args.reason+'")' : ''}`;
    case 'update_inventory': return `Set stock of product ${args.productId} to ${args.stock}`;
    case 'create_product': return `Create new product "${args.name}" (${args.category}, Rs. ${args.price}${args.stock ? `, stock: ${args.stock}` : ''})`;
    case 'update_product': return `Update product ${args.productId}: ${Object.entries(args).filter(([k])=>k!=='productId'&&k!=='confirmToken').map(([k,v])=>`${k}=${v}`).join(', ') || 'no changes'}`;
    case 'create_discount': return `Create discount code "${args.code}" (${args.type} ${args.value}${args.type==='percent'?'%':' PKR'} off)`;
    case 'update_discount': return `Update discount ${args.discountId}: ${Object.entries(args).filter(([k])=>k!=='discountId'&&k!=='confirmToken').map(([k,v])=>`${k}=${v}`).join(', ')}`;
    case 'delete_discount': return `Delete discount code "${args.discountId}" permanently`;
    case 'update_store_setting': return `Set store setting "${args.key}" = "${args.value}"`;
    default: return `Execute ${name}`;
  }
}

/* ---------------- Handler ---------------- */

export default async function handler(req, res){
  if(req.method === 'OPTIONS'){
    // corsHeaders() returns {} for an origin that is not on the allow-list, so a
    // disallowed caller gets a 204 with no Allow-Origin and the browser blocks it.
    const cors = corsHeaders(req);
    res.writeHead(204, {
      ...cors,
      ...(cors['Access-Control-Allow-Origin'] ? {
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Max-Age': '86400',
      } : {}),
    });
    return res.end();
  }
  if(req.method !== 'POST'){
    sendJson(req, res, 405, { error: 'Use POST.' });
    return;
  }

  const body = await readBody(req);
  const mode = body.mode === 'admin_draft' ? 'admin_draft'
    : body.mode === 'admin_chat' ? 'admin_chat'
    : body.mode === 'admin_confirm' ? 'admin_confirm'
    : 'chat';
  const message = String(body.message || '').trim().slice(0, MAX_MESSAGE_CHARS);

  // Identity comes from verifying the token, never from the request claiming who
  // the caller is. An invalid token simply means "guest".
  const idToken = typeof body.idToken === 'string' ? body.idToken : '';
  const user = await verifyIdToken(idToken);

  /* --- Admin modes: gated to verified admins only --- */
  if(!process.env.HELPISH_MOCK && (mode === 'admin_draft' || mode === 'admin_chat' || mode === 'admin_confirm')){
    const admin = user ? await isAdmin(user, idToken) : false;
    if(!admin){
      res.writeHead(403, { 'Content-Type': 'application/json', ...corsHeaders(req) });
      return res.end(JSON.stringify({ error: 'This feature is only available to store admins.' }));
    }
  }

  /* --- Admin product drafting: gated, non-streaming, returns a draft only --- */
  if(mode === 'admin_draft'){
    if(!message){
      res.writeHead(400, { 'Content-Type': 'application/json', ...corsHeaders(req) });
      return res.end(JSON.stringify({ error: 'Describe the product first.' }));
    }
    try{
      const data = await chat({
        messages: [
          { role: 'system', content: adminDraftPrompt() },
          { role: 'user', content: message },
        ],
        maxTokens: 800,
        temperature: 0.5,
      });
      const raw = data?.choices?.[0]?.message?.content || '';
      const draft = parseDraft(raw);
      if(!draft){
        res.writeHead(502, { 'Content-Type': 'application/json', ...corsHeaders(req) });
        return res.end(JSON.stringify({ error: 'I could not turn that into product fields. Try describing the product in a sentence or two.' }));
      }
      res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders(req) });
      return res.end(JSON.stringify({ draft, model: modelName() }));
    }catch(err){
      const status = err instanceof ProviderError && err.kind === 'rate_limit' ? 429 : 502;
      res.writeHead(status, { 'Content-Type': 'application/json', ...corsHeaders(req) });
      return res.end(JSON.stringify({ error: friendlyFor(err) }));
    }
  }

  /* --- Admin agent: SSE streaming with tool calls and confirmation --- */
  if(mode === 'admin_chat' || mode === 'admin_confirm'){
    const stream = openStream(res, req);
    req.on?.('close', () => stream.end());

    if(!message){
      stream.send({ type: 'error', message: 'Type a command and I will help.' });
      return stream.end();
    }

    const ctx = { user, idToken, isAdmin: true };
    let history = [...sanitizeHistory(body.history), { role: 'user', content: message }];
    if(body.images && Array.isArray(body.images) && body.images.length){
      history[history.length - 1] = { role: 'user', content: message || '', images: body.images };
    }

    let built;
    try{
      built = await buildMessages({
        system: adminAgentPrompt(),
        history,
        priorSummary: body.summary,
      });
    }catch{
      built = { messages: [{ role: 'system', content: adminAgentPrompt() }, ...history.slice(-8)], summary: body.summary || '' };
    }

    try{
      const { anyText } = await runAdminAgentTurn({
        stream,
        messages: built.messages,
        ctx,
        isConfirmRound: mode === 'admin_confirm',
      });
      if(!anyText){
        stream.send({ type: 'text', delta: 'Done. Let me know if you need anything else.' });
      }
      stream.send({ type: 'done', summary: built.summary });
    }catch(err){
      stream.send({ type: 'error', message: friendlyFor(err) });
      if(err && !(err instanceof ProviderError)) console.error('admin agent turn failed:', err);
    }
    stream.end();
    return;
  }

  /* --- Customer chat --- */
  const stream = openStream(res, req);
  req.on?.('close', () => stream.end());

  if(!message){
    stream.send({ type: 'error', message: 'Type a question and I will help.' });
    return stream.end();
  }

  const admin = user ? await isAdmin(user, idToken) : false;
  let history = [...sanitizeHistory(body.history), { role: 'user', content: message }];
  if(body.images && Array.isArray(body.images) && body.images.length){
    history[history.length - 1] = { role: 'user', content: message || '', images: body.images };
  }

  let built;
  try{
    built = await buildMessages({
      system: customerSystemPrompt({ user, isAdminUser: admin, context: body.context }),
      history,
      priorSummary: body.summary,
    });
  }catch{
    built = { messages: [{ role: 'system', content: customerSystemPrompt({ user, isAdminUser: admin, context: body.context }) }, ...history.slice(-8)], summary: body.summary || '' };
  }

  try{
    const turnResult = await runChatTurn({
      stream,
      messages: built.messages,
      ctx: { user, idToken, isAdmin: admin },
    });
    if(!turnResult.anyText){
      stream.send({ type: 'text', delta: 'I could not find an answer for that. Try asking in a different way, or message the store on WhatsApp at +92 336 3611223.' });
    }
    stream.send({ type: 'done', summary: built.summary });
  }catch(err){
    // The browser keeps the conversation; only this one reply failed.
    stream.send({ type: 'error', message: friendlyFor(err) });
    if(err && !(err instanceof ProviderError)) console.error('helpish turn failed:', err);
    else console.error('helpish provider blocked:', err.message, 'kind:', err.kind, 'status:', err.status);
  }
  stream.end();
}

/* ---------------- Draft normalisation ---------------- */

const CAT_SET = new Set(CATEGORIES.map(c => c.toLowerCase()));

// Exported so the normalisation can be tested on its own. The endpoint's
// behaviour does not change: this is a pure function over the model's output.
export function parseDraft(raw){
  let text = String(raw || '').trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if(fence) text = fence[1].trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if(start < 0 || end <= start) return null;

  let obj;
  try { obj = JSON.parse(text.slice(start, end + 1)); } catch { return null; }
  if(!obj || typeof obj !== 'object') return null;

  // null / undefined / '' must stay null, not become 0. Number(null) is 0, so a
  // price the admin never stated would otherwise be drafted as Rs. 0 and a
  // missing stock count as "out of stock".
  const int = (v) => {
    if(v === null || v === undefined || v === '') return null;
    const n = Math.round(Number(v));
    return Number.isFinite(n) && n >= 0 ? n : null;
  };
  const cat = String(obj.category || '').trim();
  const category = CAT_SET.has(cat.toLowerCase())
    ? CATEGORIES.find(c => c.toLowerCase() === cat.toLowerCase())
    : '';
  const isDeal = category === 'Deals';

  // The form's badge is free text (e.g. "BEST VALUE") and saveProduct only keeps
  // badge / originalPrice / includedItems when the category is Deals — so drop
  // them here too rather than showing the admin fields that would be discarded.
  const badge = isDeal
    ? String(obj.badge || '').replace(/[^A-Za-z0-9 %&+-]/g, '').trim().slice(0, 24).toUpperCase()
    : '';

  const name = String(obj.name || '').trim().slice(0, 120);
  if(!name) return null;

  return {
    name,
    category,
    description: cleanCopy(obj.description, 1500),
    price: int(obj.price),
    originalPrice: isDeal ? int(obj.originalPrice) : null,
    stock: int(obj.stock),
    customizable: obj.customizable === true || CUSTOMIZABLE.includes(category),
    includedItems: isDeal && Array.isArray(obj.includedItems)
      ? obj.includedItems.map(s => cleanCopy(s, 80)).filter(Boolean).slice(0, 10)
      : [],
    badge,
    notes: String(obj.notes || '').trim().slice(0, 300),
  };
}
