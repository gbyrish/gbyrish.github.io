// Helpish store data access.
//
// Reads the REAL Gbyrish store through the Firestore REST API — the same data
// the site itself renders — so Helpish can never invent products, prices, stock
// or sale terms. There is no second database and no duplicated product list.
//
// Reads are unauthenticated for public collections (products, settings), exactly
// like a signed-out visitor. Order reads use the caller's own Firebase ID token
// as the bearer, so Firestore security rules apply unchanged.

export const PROJECT = () => process.env.FIREBASE_PROJECT_ID || 'gybrish-store';
export const WEB_KEY = () => process.env.FIREBASE_API_KEY || 'AIzaSyAAkIcNkUzzvcbUwXirBxsFPhtZcNqOsV0';
export const FS_ROOT = () => `https://firestore.googleapis.com/v1/projects/${PROJECT()}/databases/(default)/documents`;

// Mirrors ADMIN_EMAILS in index.html. Overridable with HELPISH_ADMIN_EMAILS.
const BUILTIN_ADMINS = ['ahmadasifkhan2023@gmail.com', 'gybrish@gmail.com', 'gbyrish@gmail.com'];

// Mirrors State.coupons in index.html, which is a client-side constant with no
// Firestore source. settings.coupons wins when the store starts storing them.
const BUILTIN_COUPONS = { WELCOME10: 10, GBYRISH20: 20 };

export class StoreError extends Error {
  constructor(message, { kind = 'store' } = {}){ super(message); this.name = 'StoreError'; this.kind = kind; }
}

/* ---------------- Firestore REST value decoding ---------------- */

function decodeValue(v){
  if(v == null) return null;
  if('stringValue' in v) return v.stringValue;
  if('integerValue' in v) return Number(v.integerValue);
  if('doubleValue' in v) return Number(v.doubleValue);
  if('booleanValue' in v) return v.booleanValue;
  if('nullValue' in v) return null;
  if('timestampValue' in v) return v.timestampValue;
  if('arrayValue' in v) return (v.arrayValue.values || []).map(decodeValue);
  if('mapValue' in v) return decodeFields(v.mapValue.fields || {});
  return null;
}

function decodeFields(fields){
  const out = {};
  for(const [k, v] of Object.entries(fields)) out[k] = decodeValue(v);
  return out;
}

function docId(name){ return String(name || '').split('/').pop(); }

/* ---------------- Firestore REST value encoding (for writes) ---------------- */

function encodeValue(v){
  if(v == null) return { nullValue: null };
  if(typeof v === 'boolean') return { booleanValue: v };
  if(typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if(typeof v === 'string') return { stringValue: v };
  if(Array.isArray(v)) return { arrayValue: { values: v.map(encodeValue) } };
  if(typeof v === 'object') return { mapValue: { fields: encodeFields(v) } };
  return { stringValue: String(v) };
}

function encodeFields(obj){
  const out = {};
  for(const [k, v] of Object.entries(obj)) out[k] = encodeValue(v);
  return out;
}

async function fsSet(path, fields, { idToken, query = '' } = {}){
  const url = `${FS_ROOT()}/${path}?${query ? query + '&' : ''}key=${WEB_KEY()}`;
  const headers = { 'Content-Type': 'application/json' };
  if(idToken) headers['Authorization'] = `Bearer ${idToken}`;
  else headers['x-goog-user-project'] = PROJECT();

  const res = await fetch(url, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({ fields: encodeFields(fields), mask: { fieldPaths: Object.keys(fields) } }),
    signal: AbortSignal.timeout ? AbortSignal.timeout(15000) : undefined,
  });
  if(!res.ok){
    const body = await res.text().catch(() => '');
    throw new StoreError(`Firestore PATCH ${res.status} on ${path}: ${body.slice(0, 200)}`,
      { kind: res.status === 403 || res.status === 401 ? 'forbidden' : 'store' });
  }
  return res.json();
}

async function fsDelete(path, { idToken, query = '' } = {}){
  let url = `${FS_ROOT()}/${path}?${query ? query + '&' : ''}key=${WEB_KEY()}`;
  const headers = {};
  if(idToken) headers['Authorization'] = `Bearer ${idToken}`;
  else headers['x-goog-user-project'] = PROJECT();

  const res = await fetch(url, {
    method: 'DELETE',
    headers,
    signal: AbortSignal.timeout ? AbortSignal.timeout(15000) : undefined,
  });
  if(res.status === 404 || res.status === 409) return; // already gone or locked
  if(!res.ok){
    const body = await res.text().catch(() => '');
    throw new StoreError(`Firestore DELETE ${res.status} on ${path}: ${body.slice(0, 200)}`,
      { kind: res.status === 403 || res.status === 401 ? 'forbidden' : 'store' });
  }
}

async function fsGet(path, { idToken, query = '' } = {}){
  const headers = {};
  let url = `${FS_ROOT()}/${path}`;
  const params = new URLSearchParams(query);
  if(idToken) headers['Authorization'] = `Bearer ${idToken}`;
  else params.set('key', WEB_KEY());
  const qs = params.toString();
  if(qs) url += (url.includes('?') ? '&' : '?') + qs;

  const res = await fetch(url, {
    headers,
    signal: AbortSignal.timeout ? AbortSignal.timeout(12000) : undefined,
  });
  if(!res.ok){
    const body = await res.text().catch(() => '');
    throw new StoreError(`Firestore ${res.status} on ${path}: ${body.slice(0, 200)}`,
      { kind: res.status === 403 || res.status === 401 ? 'forbidden' : (res.status === 404 ? 'not_found' : 'store') });
  }
  return res.json();
}

/* ---------------- Cached public reads ---------------- */

const cache = new Map();               // key -> { at, value }
const TTL_MS = 30000;                  // short: stock and sales change

async function cached(key, loader){
  const hit = cache.get(key);
  const now = Date.now();
  if(hit && now - hit.at < TTL_MS) return hit.value;
  const value = await loader();
  cache.set(key, { at: now, value });
  return value;
}

export async function getProducts(){
  return cached('products', async () => {
    const out = [];
    let pageToken = '';
    // Paginate so a growing catalogue stays complete.
    for(let page = 0; page < 6; page++){
      const q = new URLSearchParams({ pageSize: '300' });
      if(pageToken) q.set('pageToken', pageToken);
      const data = await fsGet('products', { query: q.toString() });
      for(const d of (data.documents || [])){
        out.push({ id: docId(d.name), ...decodeFields(d.fields || {}) });
      }
      pageToken = data.nextPageToken || '';
      if(!pageToken) break;
    }
    return out;
  });
}

export async function getSettings(){
  return cached('settings', async () => {
    try{
      const d = await fsGet('settings/site');
      return decodeFields(d.fields || {});
    }catch(err){
      if(err.kind === 'not_found') return {};
      throw err;
    }
  });
}

/* ---------------- Pricing / sale logic (mirrors index.html) ---------------- */

function saleConfig(settings){
  const def = { active: false, name: '', description: '', discount: 0, startDate: '', startTime: '', endDate: '', endTime: '' };
  return { ...def, ...(settings.sale || {}) };
}

function parseSaleTime(dateStr, timeStr){
  if(!dateStr) return 0;
  const d = String(dateStr).split('-').map(Number);
  const t = String(timeStr || '00:00').split(':').map(Number);
  return new Date(d[0], (d[1] || 1) - 1, d[2] || 1, t[0] || 0, t[1] || 0).getTime();
}

export function saleState(settings){
  const c = saleConfig(settings);
  if(!c.active) return 'off';
  const s = parseSaleTime(c.startDate, c.startTime);
  const e = parseSaleTime(c.endDate, c.endTime);
  if(!s || !e || e <= s) return 'off';
  const now = Date.now();
  if(now < s) return 'upcoming';
  if(now >= e) return 'expired';
  return 'active';
}

// Same precedence as effPrice() in index.html: a per-item discount wins over
// the global sale discount.
export function effectivePrice(p, settings){
  const base = Number(p.price || 0);
  const item = Number(p.discountPercent || 0);
  const sale = saleState(settings) === 'active' ? Number(saleConfig(settings).discount || 0) : 0;
  const discount = item > 0 ? item : sale;
  return discount > 0 ? Math.round(base * (1 - discount / 100)) : base;
}

/**
 * Product copy as the model should see it.
 *
 * Store descriptions contain emoji and decorative bullets. The site UI is
 * emoji-free, and Helpish quotes these descriptions back to customers, so they
 * are stripped here rather than hoping the model drops them.
 */
export function cleanCopy(text, limit = 400){
  return String(text || '')
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{2B00}-\u{2BFF}\u{2190}-\u{21FF}]/gu, '')
    // Decorative bullets and dingbats live outside the emoji blocks. Dashes and
    // curly quotes are deliberately left alone — they belong in real copy.
    .replace(/[•‣⁃∙·▪-◿❖⁙✻-✿]/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, '. ')
    .replace(/\.\s*\.+/g, '.')
    .trim()
    .slice(0, limit);
}

export function publicProduct(p, settings){
  const price = effectivePrice(p, settings);
  const base = Number(p.price || 0);
  const reviews = p.reviews && typeof p.reviews === 'object' ? Object.values(p.reviews) : [];
  const ratings = reviews.map(r => Number(r?.rating || 0)).filter(n => n > 0);
  return {
    id: p.id,
    name: p.name || '',
    category: p.category || '',
    price,
    listPrice: price !== base ? base : undefined,
    originalPrice: Number(p.originalPrice || 0) > base ? Number(p.originalPrice) : undefined,
    onSale: price !== base,
    stock: Number(p.stock || 0),
    inStock: Number(p.stock || 0) > 0,
    customizable: !!p.customizable,
    badge: p.badge || undefined,
    includedItems: Array.isArray(p.includedItems) && p.includedItems.length ? p.includedItems : undefined,
    description: cleanCopy(p.description, 400),
    reviewCount: reviews.length,
    rating: ratings.length ? Math.round((ratings.reduce((a, b) => a + b, 0) / ratings.length) * 10) / 10 : null,
    url: `#product/${p.id}`,
  };
}

/* ---------------- Promo + shipping (from real settings) ---------------- */

export function promoInformation(settings){
  const coupons = (settings.coupons && typeof settings.coupons === 'object') ? settings.coupons : BUILTIN_COUPONS;
  const rules = Array.isArray(settings.spendDiscountRules) ? settings.spendDiscountRules : [];
  return {
    percentCoupons: Object.entries(coupons).map(([code, pct]) => ({ code, percentOff: Number(pct) })),
    spendDiscounts: rules.filter(r => r && r.active !== false).map(r => ({
      name: r.name || '',
      minSpend: Number(r.minSpend || 0),
      discountAmount: Number(r.discountAmount || 0),
      scope: r.scope || 'store',
      category: r.category || undefined,
    })),
    stacking: settings.spendDiscountStacking || 'best',
    note: 'Promo codes are entered in the cart or at checkout.',
  };
}

export function shippingInformation(settings){
  const freeThreshold = Number(settings.freeShippingThreshold || 5000);
  return {
    currency: 'PKR',
    flatShippingFee: 250,
    freeShippingOver: freeThreshold,
    giftWrapFee: 150,
    taxPercent: Number(settings.taxRate || 0),
    paymentMethods: ['Cash on Delivery', 'Bank Transfer'],
    // Deliberately not fabricated: the store does not publish delivery-day
    // estimates anywhere in its data, so Helpish must not guess them.
    deliveryTimeframe: null,
    deliveryNote: 'Specific delivery timeframes are not published in the store settings. Ask the customer to confirm timing over WhatsApp.',
    whatsapp: '+92 336 3611223',
  };
}

/* ---------------- Auth: verify the caller ---------------- */

/**
 * Verify a Firebase ID token without the Admin SDK, using the Identity Toolkit
 * lookup endpoint. An invalid or expired token yields null — the caller is then
 * treated as a guest, never as the claimed user.
 */
export async function verifyIdToken(idToken){
  if(!idToken || typeof idToken !== 'string' || idToken.length < 20) return null;
  try{
    const res = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${WEB_KEY()}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken }),
      signal: AbortSignal.timeout ? AbortSignal.timeout(10000) : undefined,
    });
    if(!res.ok) return null;
    const data = await res.json();
    const u = data.users?.[0];
    if(!u) return null;
    return { uid: u.localId, email: (u.email || '').toLowerCase(), name: u.displayName || '' };
  }catch{
    return null;
  }
}

export async function isAdmin(user, idToken){
  if(!user?.email) return false;
  const env = (process.env.HELPISH_ADMIN_EMAILS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  const list = env.length ? env : BUILTIN_ADMINS;
  if(list.includes(user.email)) return true;
  // Dynamic admins live in the `admins` collection, doc id = lowercased email.
  try{
    await fsGet(`admins/${encodeURIComponent(user.email)}`, { idToken });
    return true;
  }catch{
    return false;
  }
}

/**
 * Read one order on behalf of a verified user.
 *
 * Two independent gates: Firestore rules see the user's own token, and the
 * order's `uid` is compared to the verified uid. A customer can therefore only
 * ever read their own order, whatever they type into the chat.
 */
export async function getOrderForUser(orderId, user, idToken){
  if(!user) return { error: 'not_signed_in' };
  const id = String(orderId || '').trim();
  if(!id) return { error: 'no_order_id' };
  let doc;
  try{
    doc = await fsGet(`orders/${encodeURIComponent(id)}`, { idToken });
  }catch(err){
    if(err.kind === 'not_found') return { error: 'not_found' };
    if(err.kind === 'forbidden') return { error: 'not_authorized' };
    throw err;
  }
  const o = decodeFields(doc.fields || {});
  if(o.uid && o.uid !== user.uid) return { error: 'not_authorized' };
  return {
    orderId: o.orderId || id,
    status: o.status || 'Pending',
    placedAt: o.createdAt || o.placedAt || null,
    items: (o.items || []).map(i => ({ name: i.name, qty: i.qty, price: i.price })),
    total: o.totals?.grand ?? null,
    payment: o.payment || null,
    giftWrap: !!o.giftWrap,
    city: o.customer?.city || null,
    cancelledAt: o.cancelledAt || null,
  };
}

/* ---------------- Admin write functions ---------------- */

/**
 * Update specific fields on an order. Returns the updated document fields.
 */
export async function updateOrderStatus(orderId, status, idToken, extraFields = {}){
  const id = String(orderId || '').trim();
  if(!id) throw new StoreError('orderId is required', { kind: 'bad_input' });
  const fields = { status, ...extraFields };
  if(status === 'Cancelled' || status === 'Cancelled by Admin') fields.cancelledAt = new Date().toISOString();
  if(!fields.updatedAt) fields.updatedAt = new Date().toISOString();
  const result = await fsSet(`orders/${encodeURIComponent(id)}`, fields, { idToken });
  return decodeFields(result.fields || {});
}

/**
 * Cancel an order and restore stock for each item.
 */
export async function cancelOrder(orderId, idToken){
  const id = String(orderId || '').trim();
  if(!id) throw new StoreError('orderId is required', { kind: 'bad_input' });
  // Fetch the order first to get items for stock restoration.
  let doc;
  try{ doc = await fsGet(`orders/${encodeURIComponent(id)}`, { idToken }); }
  catch(err){ throw new StoreError(`Cannot find order ${id}: ${err.message}`, { kind: 'not_found' }); }
  const o = decodeFields(doc.fields || {});

  // Cancel the order.
  const fields = { status: 'Cancelled', cancelledAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  await fsSet(`orders/${encodeURIComponent(id)}`, fields, { idToken });

  // Restore stock for each item.
  const items = o.items || [];
  const restores = [];
  for(const item of items){
    if(item.productId || item.id){
      const pid = item.productId || item.id;
      const qty = Number(item.qty || item.quantity || 0);
      if(qty > 0){
        restores.push(
          fsGet(`products/${encodeURIComponent(pid)}`, { idToken }).then(d => {
            const p = decodeFields(d.fields || {});
            const current = Number(p.stock || 0);
            return fsSet(`products/${encodeURIComponent(pid)}`, { stock: current + qty }, { idToken });
          }).catch(() => {})
        );
      }
    }
  }
  await Promise.allSettled(restores);
  return { cancelled: true, orderId: id, itemsRestored: items.length };
}

/**
 * Update inventory (stock) for a product.
 */
export async function updateInventory(productId, newStock, idToken){
  const pid = String(productId || '').trim();
  if(!pid) throw new StoreError('productId is required', { kind: 'bad_input' });
  const stock = Math.max(0, Number(newStock));
  const result = await fsSet(`products/${encodeURIComponent(pid)}`, { stock }, { idToken });
  return { productId: pid, stock, updated: true };
}

/**
 * Update arbitrary fields on a product.
 */
export async function updateProduct(productId, fields, idToken){
  const pid = String(productId || '').trim();
  if(!pid) throw new StoreError('productId is required', { kind: 'bad_input' });
  if(!fields || typeof fields !== 'object') throw new StoreError('fields object is required', { kind: 'bad_input' });
  const safe = { ...fields };
  // Never allow stock updates through this function — use updateInventory.
  delete safe.stock;
  // Only allow safe product fields.
  const allowed = ['name', 'price', 'description', 'category', 'badge', 'originalPrice',
                   'discountPercent', 'customizable', 'includedItems', 'image', 'images',
                   'features', 'specifications', 'careInstructions', 'shippingInfo'];
  const filtered = {};
  for(const k of allowed){ if(k in safe) filtered[k] = safe[k]; }
  if(!Object.keys(filtered).length) throw new StoreError('No valid fields to update', { kind: 'bad_input' });
  filtered.updatedAt = new Date().toISOString();
  const result = await fsSet(`products/${encodeURIComponent(pid)}`, filtered, { idToken });
  return { productId: pid, updated: Object.keys(filtered) };
}

/**
 * Create a new discount/promo document.
 */
export async function createDiscount(data, idToken){
  if(!data || typeof data !== 'object') throw new StoreError('discount data is required', { kind: 'bad_input' });
  // Generate an ID from the code if provided, otherwise Firestore auto-generates.
  const code = String(data.code || '').trim().toUpperCase();
  const docId = code || undefined;
  const fields = {
    code: code || undefined,
    type: data.type || 'percent',
    value: Number(data.value || 0),
    active: data.active !== false,
    minSpend: Number(data.minSpend || 0),
    maxUses: data.maxUses ? Number(data.maxUses) : null,
    currentUses: 0,
    description: data.description || '',
    createdAt: new Date().toISOString(),
  };
  if(docId){
    await fsSet(`discounts/${encodeURIComponent(docId)}`, fields, { idToken });
    return { id: docId, ...fields };
  }
  // Use the create endpoint for auto-ID.
  const url = `${FS_ROOT()}/discounts?key=${WEB_KEY()}`;
  const headers = { 'Content-Type': 'application/json' };
  if(idToken) headers['Authorization'] = `Bearer ${idToken}`;
  else headers['x-goog-user-project'] = PROJECT();
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ fields: encodeFields(fields) }),
    signal: AbortSignal.timeout ? AbortSignal.timeout(15000) : undefined,
  });
  if(!res.ok){
    const body = await res.text().catch(() => '');
    throw new StoreError(`Firestore create discount ${res.status}: ${body.slice(0, 200)}`, { kind: 'store' });
  }
  const result = await res.json();
  return { id: docId(result.name || ''), ...fields };
}

/**
 * Update fields on an existing discount.
 */
export async function updateDiscount(discountId, fields, idToken){
  const did = String(discountId || '').trim();
  if(!did) throw new StoreError('discountId is required', { kind: 'bad_input' });
  if(!fields || typeof fields !== 'object') throw new StoreError('fields object is required', { kind: 'bad_input' });
  const safe = { ...fields };
  safe.updatedAt = new Date().toISOString();
  const result = await fsSet(`discounts/${encodeURIComponent(did)}`, safe, { idToken });
  return { discountId: did, updated: Object.keys(safe) };
}

/**
 * Delete a discount document.
 */
export async function deleteDiscount(discountId, idToken){
  const did = String(discountId || '').trim();
  if(!did) throw new StoreError('discountId is required', { kind: 'bad_input' });
  await fsDelete(`discounts/${encodeURIComponent(did)}`, { idToken });
  return { deleted: true, discountId: did };
}

/**
 * Update a setting field in the site settings document.
 */
export async function updateStoreSetting(key, value, idToken){
  const k = String(key || '').trim();
  if(!k) throw new StoreError('key is required', { kind: 'bad_input' });
  const result = await fsSet(`settings/site`, { [k]: value }, { idToken });
  return { key: k, updated: true };
}
