// Local dev server for Gbyrish + Halpish.
//
//   node server/dev.js            -> http://localhost:8080
//
// Serves the site as static files and runs /api/halpish in-process, so the AI
// Gateway key stays on the server exactly as it does on Vercel. Nothing here
// ships to production; Vercel serves index.html statically and api/halpish.js as
// a function.

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT || 8080);

/* ---------------- .env.local -> process.env ---------------- */

async function loadEnv(){
  for(const file of ['.env.local', '.env']){
    let text;
    try { text = await readFile(join(ROOT, file), 'utf8'); } catch { continue; }
    for(const line of text.split(/\r?\n/)){
      const trimmed = line.trim();
      if(!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if(eq < 1) continue;
      const key = trimmed.slice(0, eq).trim();
      let value = trimmed.slice(eq + 1).trim();
      if((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
      if(!(key in process.env)) process.env[key] = value;
    }
  }
}

/* ---------------- Static files ---------------- */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.txt': 'text/plain; charset=utf-8',
};

async function serveStatic(req, res, pathname){
  // Anything under api/, server/ or a dotfile is not web-servable — this is how
  // .env.local stays unreachable over HTTP.
  const rel = normalize(decodeURIComponent(pathname)).replace(/^([/\\])+/, '');
  if(rel.startsWith('..') || rel.startsWith('api') || rel.startsWith('server') || rel.split(/[/\\]/).some(p => p.startsWith('.'))){
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    return res.end('Not found');
  }

  let file = join(ROOT, rel || 'index.html');
  try{
    const info = await stat(file);
    if(info.isDirectory()) file = join(file, 'index.html');
  }catch{
    // Unknown path: hand back index.html so hash routes work on a hard refresh.
    file = join(ROOT, 'index.html');
  }

  try{
    const data = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(data);
  }catch{
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  }
}

/* ---------------- Server ---------------- */

await loadEnv();
// Imported after the env is loaded so the handler sees the key.
const { default: halpish } = await import('../api/halpish.js');

createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  try{
    if(url.pathname === '/api/halpish') return await halpish(req, res);
    if(url.pathname === '/api/halpish/health'){
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        ok: true,
        model: process.env.HALPISH_MODEL || 'minimax/minimax-m3',
        keyConfigured: !!process.env.BLOCKRUN_API_KEY || !!process.env.GROQ_API_KEY,   // boolean only, never the key
        mock: !!process.env.HALPISH_MOCK,
      }));
    }
    await serveStatic(req, res, url.pathname);
  }catch(err){
    console.error('dev server error:', err);
    if(!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('Server error');
  }
}).listen(PORT, () => {
  console.log(`Gbyrish dev server on http://localhost:${PORT}`);
  const brKey = process.env.BLOCKRUN_API_KEY;
  console.log(`Halpish model: ${process.env.HALPISH_MODEL || 'minimax/minimax-m3'} | OpenRouter ${process.env.OPENROUTER_API_KEY ? 'primary' : 'MISSING'} | Groq ${process.env.GROQ_API_KEY ? 'fallback' : 'off'}${process.env.HALPISH_MOCK ? ' | MOCK provider' : ''}`);
});
