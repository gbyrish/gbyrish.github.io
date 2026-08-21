// Halpish conversation shaping.
//
// The browser sends the whole visible conversation; the server decides what the
// model actually sees. Two jobs:
//   - keep requests bounded (recent turns verbatim, older turns summarised)
//   - keep the customer's transcript intact no matter what the model does
//
// The browser never loses messages here: trimming only affects the request body,
// so a rate limit or timeout leaves the on-screen conversation untouched.

import { chat } from './gateway.js';

const MAX_VERBATIM_TURNS = 12;        // user+assistant messages kept word for word
const SUMMARISE_WHEN_OVER = 18;       // older messages get folded into one note
const MAX_CHARS_PER_MESSAGE = 4000;   // a pasted wall of text can't blow the request

const clip = (s) => {
  const t = String(s ?? '');
  return t.length > MAX_CHARS_PER_MESSAGE ? t.slice(0, MAX_CHARS_PER_MESSAGE) + ' […]' : t;
};

/** Keep only well-formed customer/assistant turns, in order. */
export function sanitizeHistory(history){
  if(!Array.isArray(history)) return [];
  return history
    .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
    .map(m => ({ role: m.role, content: clip(m.content) }))
    .slice(-60);                       // hard ceiling on what we'll even consider
}

/**
 * Compress the older part of a long conversation into a single note.
 *
 * Summarising is best-effort: if the model call fails, we fall back to a plain
 * mechanical digest rather than dropping the context or failing the request.
 */
export async function summarizeOlder(older){
  const transcript = older
    .map(m => `${m.role === 'user' ? 'Customer' : 'Halpish'}: ${m.content}`)
    .join('\n')
    .slice(0, 8000);

  try{
    const data = await chat({
      messages: [
        { role: 'system', content: 'Summarise this shop-assistant conversation in under 120 words. Keep only what still matters for answering the next question: what the customer is shopping for, their budget, occasion, recipient, products already discussed by name, and anything they ruled out. No preamble.' },
        { role: 'user', content: transcript },
      ],
      maxTokens: 250,
      temperature: 0,
      attempts: 1,
      timeoutMs: 15000,
    });
    const text = data?.choices?.[0]?.message?.content?.trim();
    if(text) return text;
  }catch{
    // fall through to the mechanical digest
  }

  const asks = older.filter(m => m.role === 'user').map(m => m.content.replace(/\s+/g, ' ').slice(0, 90));
  return `Earlier in this conversation the customer asked about: ${asks.slice(-6).join(' | ')}`;
}

/**
 * Build the message array for a request.
 *
 * Returns { messages, summary } — `summary` is handed back to the browser so it
 * can be replayed on the next turn, which means a long conversation is only ever
 * summarised once.
 */
export async function buildMessages({ system, history, priorSummary }){
  const clean = sanitizeHistory(history);
  let summary = priorSummary && typeof priorSummary === 'string' ? clip(priorSummary) : '';
  let recent = clean;

  if(clean.length > SUMMARISE_WHEN_OVER){
    const cut = clean.length - MAX_VERBATIM_TURNS;
    const older = clean.slice(0, cut);
    recent = clean.slice(cut);
    const fresh = await summarizeOlder(older);
    summary = summary ? `${summary}\n${fresh}` : fresh;
    if(summary.length > MAX_CHARS_PER_MESSAGE) summary = summary.slice(-MAX_CHARS_PER_MESSAGE);
  }else if(clean.length > MAX_VERBATIM_TURNS){
    recent = clean.slice(-MAX_VERBATIM_TURNS);
  }

  const messages = [{ role: 'system', content: system }];
  if(summary) messages.push({ role: 'system', content: `Context from earlier in this conversation:\n${summary}` });
  messages.push(...recent);
  return { messages, summary };
}
