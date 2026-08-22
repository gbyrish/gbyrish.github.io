// Helpish tools — the complete set of store functions the model may call.
//
// Two rules hold this file together:
//   1. Every tool reads real store data through api/_lib/store.js. Nothing here
//      makes up a product, price, stock level, sale or policy.
//   2. Dispatch is server-side and permission-checked. The model can only ask
//      for a tool by name; whether that tool runs, and for whom, is decided
//      here — never by anything the customer types.
//
// There are deliberately NO write tools. Helpish cannot create, edit or delete
// anything in the store. Admin product drafting is a separate, gated mode in
// api/helpish.js that returns a draft for a human to confirm.

import {
  getProducts, getSettings, publicProduct, effectivePrice, cleanCopy,
  saleState, promoInformation, shippingInformation, getOrderForUser,
} from './store.js';

// Mirrors CATEGORIES in index.html. Verified against the live catalogue —
// do not "tidy" this list, the strings are the actual Firestore field values.
const CATEGORIES = [
  'Stainless Steel Jewelry', 'Bouquets (Customizable)', 'Customized Baskets',
  'Wallet', 'Ring', 'Deals',
];

// Mirrors CUSTOMIZABLE_CATEGORIES in index.html.
const CUSTOMIZABLE = ['Bouquets (Customizable)', 'Customized Baskets', 'Wallet', 'Ring'];

// Mirrors CAT_HASH — the route each category browses to.
const CAT_HASH = {
  'Stainless Steel Jewelry': '#jewelry',
  'Bouquets (Customizable)': '#bouquets',
  'Customized Baskets': '#giftbaskets',
  'Wallet': '#wallet',
  'Ring': '#rings',
  'Deals': '#deals',
};

/* ---------------- Tool schemas sent to the model ---------------- */

export const TOOL_SCHEMAS = [
  {
    type: 'function',
    function: {
      name: 'searchProducts',
      description: 'Search the Gbyrish catalogue. Use for any question about what the store sells, what fits a budget, or what is available in a category. Returns real products with current prices and stock.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Words to match against product name, description or category. Omit to browse.' },
          category: { type: 'string', enum: CATEGORIES, description: 'Restrict to one category.' },
          minPrice: { type: 'number', description: 'Minimum current price in PKR.' },
          maxPrice: { type: 'number', description: 'Maximum current price in PKR. Use for budget questions.' },
          inStockOnly: { type: 'boolean', description: 'Only products with stock above zero. Default true.' },
          onSaleOnly: { type: 'boolean', description: 'Only products that are currently discounted.' },
          customizableOnly: { type: 'boolean', description: 'Only products that can be personalised.' },
          sort: { type: 'string', enum: ['relevance', 'price-asc', 'price-desc', 'rating', 'popular'], description: 'Result ordering. Default relevance.' },
          limit: { type: 'number', description: 'How many products to return, 1 to 12. Default 6.' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'getProductDetails',
      description: 'Full details for one product: description, price, stock, rating, whether it can be personalised, and what is included. Accepts an id or a product name.',
      parameters: {
        type: 'object',
        properties: {
          productId: { type: 'string', description: 'The product id, as returned by searchProducts.' },
          name: { type: 'string', description: 'The product name, if the id is not known.' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'checkProductStock',
      description: 'Current availability for one product. Use before telling a customer something can be ordered.',
      parameters: {
        type: 'object',
        properties: {
          productId: { type: 'string' },
          name: { type: 'string' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'getCategories',
      description: 'The categories Gbyrish sells, with how many products are in stock in each.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'getActiveSale',
      description: 'Whether a store-wide sale is running right now, its discount and when it ends. Use for any question about deals or sales.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'getPromoInformation',
      description: 'Valid promo codes and spend-based discounts. Use when a customer asks about discount codes or offers.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'getShippingInformation',
      description: 'Shipping fee, free-shipping threshold, gift wrap fee, tax and accepted payment methods.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'getAuthenticatedOrder',
      description: 'Status and contents of ONE order belonging to the signed-in customer. Only works when the customer is signed in and the order is theirs.',
      parameters: {
        type: 'object',
        properties: { orderId: { type: 'string', description: 'The order id, e.g. GB-XXXXXX.' } },
        required: ['orderId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'recommendGifts',
      description: 'Shortlist gift options for an occasion and budget, already filtered to in-stock items and ranked. Use for "find me a gift for X under Y" requests, then compare the results in your reply.',
      parameters: {
        type: 'object',
        properties: {
          budgetMax: { type: 'number', description: 'Maximum spend in PKR.' },
          budgetMin: { type: 'number', description: 'Minimum spend in PKR, if the customer set one.' },
          occasion: { type: 'string', description: 'Free text, e.g. birthday, anniversary, eid, wedding.' },
          recipient: { type: 'string', description: 'Who the gift is for, e.g. sister, wife, friend.' },
          category: { type: 'string', enum: CATEGORIES },
          personalised: { type: 'boolean', description: 'True if the customer wants something that can be personalised.' },
          limit: { type: 'number', description: 'How many candidates to shortlist, 2 to 8. Default 5.' },
        },
      },
    },
  },
];

/* ---------------- Helpers ---------------- */

const norm = (s) => String(s || '').toLowerCase().trim();

function scoreMatch(p, words){
  if(!words.length) return 1;
  const hay = `${norm(p.name)} ${norm(p.category)} ${norm(p.description)} ${norm(p.badge)}`;
  let score = 0;
  for(const w of words){
    if(!w) continue;
    if(norm(p.name).includes(w)) score += 3;
    else if(norm(p.category).includes(w)) score += 2;
    else if(hay.includes(w)) score += 1;
  }
  return score;
}

function reviewStats(p){
  const reviews = p.reviews && typeof p.reviews === 'object' ? Object.values(p.reviews) : [];
  const ratings = reviews.map(r => Number(r?.rating || 0)).filter(n => n > 0);
  return {
    count: reviews.length,
    avg: ratings.length ? ratings.reduce((a, b) => a + b, 0) / ratings.length : 0,
  };
}

// Stop words that carry no identifying weight when matching a product name.
const NAME_NOISE = new Set(['is','the','a','an','of','for','do','you','have','in','stock',
  'available','availability','it','this','that','any','still','and','my','me','i','?']);

async function resolveProduct({ productId, name }){
  const products = await getProducts();
  if(productId){
    const hit = products.find(p => p.id === productId);
    if(hit) return hit;
  }
  if(!name) return null;

  const n = norm(name);
  const direct = products.find(p => norm(p.name) === n)
    || products.find(p => norm(p.name).includes(n))
    || products.find(p => n.includes(norm(p.name)) && norm(p.name).length > 3);
  if(direct) return direct;

  // Word-overlap fallback. The model may paraphrase — "Elara bangle" for
  // "Elara Silver Bangle", or wrap the name in a question. Without this the tool
  // returns "no such product" and Helpish tells the customer, wrongly, that the
  // store does not stock it.
  const words = n.split(/[^a-z0-9]+/).filter(w => w.length > 2 && !NAME_NOISE.has(w));
  if(!words.length) return null;

  let best = null, bestScore = 0;
  for(const p of products){
    const pw = norm(p.name).split(/[^a-z0-9]+/).filter(Boolean);
    if(!pw.length) continue;
    const hits = pw.filter(w => words.includes(w)).length;
    if(!hits) continue;
    // Most of what was asked for has to be present. Without this floor a query
    // for something the store does not stock ("silver anklet") matches any
    // product sharing one word ("Elara Silver Bangle").
    if(hits / words.length < 0.5) continue;
    // Reward covering the product's own name, so "Elara Silver Bangle" beats a
    // product that merely shares one common word like "Set" or "Ring".
    const score = hits / pw.length + hits / words.length;
    if(score > bestScore){ bestScore = score; best = p; }
  }
  // Needs a strong overlap, not one incidental word.
  return bestScore >= 0.9 ? best : null;
}

const clamp = (n, lo, hi, dflt) => {
  const v = Number(n);
  return Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : dflt;
};

/* ---------------- Tool implementations ---------------- */

async function searchProducts(args){
  const [products, settings] = await Promise.all([getProducts(), getSettings()]);
  const words = norm(args.query).split(/\s+/).filter(Boolean);
  const inStockOnly = args.inStockOnly !== false;
  const limit = clamp(args.limit, 1, 12, 6);

  let rows = products.map(p => ({ p, price: effectivePrice(p, settings), stats: reviewStats(p) }));

  if(args.category){
    // Tolerant match: the model may send "Jewelry" for "Stainless Steel Jewelry".
    const want = norm(args.category);
    const exact = rows.filter(r => norm(r.p.category) === want);
    rows = exact.length ? exact : rows.filter(r => norm(r.p.category).includes(want) || want.includes(norm(r.p.category)));
  }
  if(inStockOnly) rows = rows.filter(r => Number(r.p.stock || 0) > 0);
  if(Number.isFinite(Number(args.maxPrice))) rows = rows.filter(r => r.price <= Number(args.maxPrice));
  if(Number.isFinite(Number(args.minPrice))) rows = rows.filter(r => r.price >= Number(args.minPrice));
  if(args.onSaleOnly) rows = rows.filter(r => r.price !== Number(r.p.price || 0));
  if(args.customizableOnly) rows = rows.filter(r => r.p.customizable || CUSTOMIZABLE.includes(r.p.category));

  if(words.length){
    rows = rows.map(r => ({ ...r, score: scoreMatch(r.p, words) })).filter(r => r.score > 0);
  }

  const sort = args.sort || 'relevance';
  rows.sort((a, b) => {
    if(sort === 'price-asc') return a.price - b.price;
    if(sort === 'price-desc') return b.price - a.price;
    if(sort === 'rating') return b.stats.avg - a.stats.avg || b.stats.count - a.stats.count;
    if(sort === 'popular') return b.stats.count - a.stats.count || b.stats.avg - a.stats.avg;
    return (b.score || 0) - (a.score || 0) || b.stats.count - a.stats.count;
  });

  return {
    matched: rows.length,
    returned: Math.min(rows.length, limit),
    products: rows.slice(0, limit).map(r => publicProduct(r.p, settings)),
    ...(rows.length === 0 ? { note: 'Nothing in the catalogue matches those filters. Suggest loosening the budget or trying another category — do not invent products.' } : {}),
  };
}

async function getProductDetails(args){
  const settings = await getSettings();
  const p = await resolveProduct(args);
  if(!p) return { found: false, note: 'No such product in the catalogue. Do not describe it; offer to search instead.' };
  const full = publicProduct(p, settings);
  return {
    found: true,
    product: {
      ...full,
      description: cleanCopy(p.description, 1200),
      personalisable: !!p.customizable || CUSTOMIZABLE.includes(p.category),
      browseUrl: CAT_HASH[p.category] || '#shop',
      imageCount: Array.isArray(p.images) ? p.images.length : (p.image ? 1 : 0),
    },
  };
}

async function checkProductStock(args){
  const p = await resolveProduct(args);
  if(!p) return { found: false, note: 'No such product in the catalogue.' };
  const stock = Number(p.stock || 0);
  return {
    found: true,
    id: p.id,
    name: p.name,
    stock,
    inStock: stock > 0,
    availability: stock <= 0 ? 'out_of_stock' : (stock <= 3 ? 'low_stock' : 'in_stock'),
  };
}

async function getCategories(){
  const products = await getProducts();
  // Derived from the products actually in the catalogue, not from a fixed list —
  // a category that exists in the code but has no stock would otherwise be
  // presented to customers as something they can buy.
  const seen = new Map();
  for(const p of products){
    const name = String(p.category || '').trim();
    if(!name) continue;
    const row = seen.get(name) || { name, totalProducts: 0, inStock: 0 };
    row.totalProducts++;
    if(Number(p.stock || 0) > 0) row.inStock++;
    seen.set(name, row);
  }
  const categories = [...seen.values()]
    .sort((a, b) => b.inStock - a.inStock || b.totalProducts - a.totalProducts)
    .map(c => ({
      ...c,
      personalisable: CUSTOMIZABLE.includes(c.name),
      browseUrl: CAT_HASH[c.name] || '#shop',
    }));
  return {
    categories,
    note: 'These are the categories that currently have products. Do not mention any other category.',
  };
}

async function getActiveSale(){
  const settings = await getSettings();
  const state = saleState(settings);
  const sale = settings.sale || {};
  if(state !== 'active' && state !== 'upcoming'){
    return { saleRunning: false, note: 'No store-wide sale is running. Individual products may still have their own discount — check searchProducts with onSaleOnly.' };
  }
  return {
    saleRunning: state === 'active',
    upcoming: state === 'upcoming',
    name: sale.name || 'Sale',
    description: sale.description || '',
    discountPercent: Number(sale.discount || 0),
    starts: sale.startDate ? `${sale.startDate} ${sale.startTime || ''}`.trim() : null,
    ends: sale.endDate ? `${sale.endDate} ${sale.endTime || ''}`.trim() : null,
  };
}

async function getPromoInformation(){
  const settings = await getSettings();
  return promoInformation(settings);
}

async function getShippingInformation(){
  const settings = await getSettings();
  return shippingInformation(settings);
}

async function recommendGifts(args){
  const limit = clamp(args.limit, 2, 8, 5);
  // Occasion words help ranking but never restrict the result set to nothing:
  // the budget and stock filters do the real work.
  const search = await searchProducts({
    query: [args.occasion, args.recipient, args.category].filter(Boolean).join(' '),
    category: args.category,
    maxPrice: args.budgetMax,
    minPrice: args.budgetMin,
    inStockOnly: true,
    customizableOnly: args.personalised === true ? true : undefined,
    sort: 'relevance',
    limit,
  });

  let shortlist = search.products;
  if(shortlist.length < 2){
    // Widen once: drop the keyword match, keep budget and stock. Better a real
    // in-budget option than a confident empty answer.
    const wider = await searchProducts({
      maxPrice: args.budgetMax,
      minPrice: args.budgetMin,
      inStockOnly: true,
      customizableOnly: args.personalised === true ? true : undefined,
      sort: 'popular',
      limit,
    });
    shortlist = wider.products;
  }

  return {
    budgetMax: Number.isFinite(Number(args.budgetMax)) ? Number(args.budgetMax) : null,
    occasion: args.occasion || null,
    candidates: shortlist,
    guidance: shortlist.length
      ? 'Compare these on price, personalisation and rating, then recommend one with a short reason. Only mention products in this list.'
      : 'Nothing in stock fits that budget. Say so plainly and offer the nearest options by asking to raise the budget.',
  };
}

/* ---------------- Dispatch with permission gating ---------------- */

// Which tools each caller may run. Customers and guests get read-only store
// tools; the order tool additionally requires a verified session.
const CUSTOMER_TOOLS = new Set([
  'searchProducts', 'getProductDetails', 'checkProductStock', 'getCategories',
  'getActiveSale', 'getPromoInformation', 'getShippingInformation',
  'getAuthenticatedOrder', 'recommendGifts',
]);

/**
 * Run one tool call.
 *
 * `ctx` carries the SERVER's view of who the caller is ({ user, idToken }),
 * derived from a verified Firebase ID token. Nothing the model or the browser
 * says about identity is trusted here.
 *
 * Always resolves — a thrown tool becomes an `{ error }` result so the model can
 * apologise usefully instead of the whole turn collapsing.
 */
export async function runTool(name, rawArgs, ctx){
  let args = {};
  if(typeof rawArgs === 'string'){
    try { args = rawArgs.trim() ? JSON.parse(rawArgs) : {}; }
    catch { return { error: 'bad_arguments', note: 'Arguments were not valid JSON. Try the call again with simpler arguments.' }; }
  }else if(rawArgs && typeof rawArgs === 'object'){
    args = rawArgs;
  }

  if(!CUSTOMER_TOOLS.has(name)){
    // Covers both a hallucinated tool name and any attempt to reach something
    // that is not on the customer surface.
    return { error: 'not_available', note: 'That function is not available. Only the listed store functions can be used.' };
  }

  try{
    switch(name){
      case 'searchProducts':          return await searchProducts(args);
      case 'getProductDetails':       return await getProductDetails(args);
      case 'checkProductStock':       return await checkProductStock(args);
      case 'getCategories':           return await getCategories();
      case 'getActiveSale':           return await getActiveSale();
      case 'getPromoInformation':     return await getPromoInformation();
      case 'getShippingInformation':  return await getShippingInformation();
      case 'recommendGifts':          return await recommendGifts(args);
      case 'getAuthenticatedOrder': {
        if(!ctx?.user){
          return { error: 'not_signed_in', note: 'The customer is not signed in. Ask them to sign in to their Gbyrish account to see order details. Do not guess any order information.' };
        }
        const result = await getOrderForUser(args.orderId, ctx.user, ctx.idToken);
        if(result.error === 'not_found' || result.error === 'not_authorized'){
          // One message for both cases on purpose: confirming that an id exists
          // but belongs to someone else would leak information.
          return { error: 'order_unavailable', note: 'No order with that id is on this customer\'s account. Ask them to double-check the id from their profile page.' };
        }
        if(result.error) return { error: result.error };
        return { order: result };
      }
      default:
        return { error: 'not_available' };
    }
  }catch(err){
    return { error: 'store_unavailable', note: `Store data could not be read right now (${err?.kind || 'error'}). Tell the customer the catalogue is briefly unavailable and suggest trying again.` };
  }
}

export { CATEGORIES, CUSTOMIZABLE, CAT_HASH };
