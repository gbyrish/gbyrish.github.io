// Helpish Admin Tools — read and write operations for store management.
//
// These tools are ONLY exposed to authenticated admins via the admin agent
// mode. They are NEVER available in customer chat. The permission gate is
// enforced by helpish.js (admin auth check) and by this module (CUSTOMER_TOOLS
// in tools.js cannot reach these).

import {
  getProducts, getSettings, getOrderForUser,
  updateOrderStatus, cancelOrder, updateInventory, updateProduct,
  createDiscount, updateDiscount, deleteDiscount, updateStoreSetting,
  StoreError, FS_ROOT, WEB_KEY,
} from './store.js';

function decodeFields(fields){
  const out = {};
  for(const [k, v] of Object.entries(fields || {})){
    if(v == null) out[k] = null;
    else if('stringValue' in v) out[k] = v.stringValue;
    else if('integerValue' in v) out[k] = Number(v.integerValue);
    else if('doubleValue' in v) out[k] = Number(v.doubleValue);
    else if('booleanValue' in v) out[k] = v.booleanValue;
    else if('nullValue' in v) out[k] = null;
    else if('timestampValue' in v) out[k] = v.timestampValue;
    else if('arrayValue' in v) out[k] = (v.arrayValue.values || []).map(decodeValue);
    else if('mapValue' in v) out[k] = decodeFields(v.mapValue.fields || {});
  }
  return out;
}
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
async function fsGet(path, { idToken, query = '' } = {}){
  const headers = {};
  let url = `https://firestore.googleapis.com/v1/projects/${process.env.FIREBASE_PROJECT_ID || 'gybrish-store'}/databases/(default)/documents/${path}`;
  const params = new URLSearchParams(query);
  if(idToken) headers['Authorization'] = `Bearer ${idToken}`;
  else params.set('key', process.env.FIREBASE_API_KEY || 'AIzaSyAAkIcNkUzzvcbUwXirBxsFPhtZcNqOsV0');
  const qs = params.toString();
  if(qs) url += (url.includes('?') ? '&' : '?') + qs;
  const res = await fetch(url, { headers, signal: AbortSignal.timeout ? AbortSignal.timeout(12000) : undefined });
  if(!res.ok) throw new StoreError(`Firestore ${res.status} on ${path}`);
  return res.json();
}
function docId(name){ return String(name || '').split('/').pop(); }

/* ---------------- Admin tool schemas ---------------- */

const ORDER_ID = { type: 'string', description: 'Order ID (e.g. GB-12345).' };

export const ADMIN_TOOL_SCHEMAS = [
  /* ---- Read tools ---- */

  {
    type: 'function',
    function: {
      name: 'search_orders',
      description: 'Search orders by status, date range, or customer name. Returns matching orders with their IDs, status, totals, and dates.',
      parameters: {
        type: 'object',
        properties: {
          status: { type: 'string', description: 'Filter by order status (e.g. Pending, Processing, Shipped, Delivered, Cancelled).' },
          daysBack: { type: 'number', description: 'Only orders from the last N days. Default 30.' },
          limit: { type: 'number', description: 'Max results to return. Default 10, max 50.' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'lookup_order',
      description: 'Get full details for a specific order by its ID. Use this when you know the exact order ID.',
      parameters: {
        type: 'object',
        properties: { orderId: ORDER_ID },
        required: ['orderId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_today_orders',
      description: 'Get all orders placed today. Returns a summary list.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_sales_summary',
      description: 'Get a sales summary for today or a recent period: total revenue, order count, average order value, and status breakdown.',
      parameters: {
        type: 'object',
        properties: {
          daysBack: { type: 'number', description: 'How many days to include. Default 1 (today), max 30.' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_low_stock_products',
    description: 'Get products with low stock (stock <= 5) or out of stock. Sorted by stock level ascending.',
      parameters: {
        type: 'object',
        properties: {
          threshold: { type: 'number', description: 'Stock level to flag as low. Default 5.' },
        },
      },
    },
  },
  /* ---- Write tools ---- */

  {
    type: 'function',
    function: {
      name: 'update_order_status',
      description: 'Update the status of an order. Requires admin confirmation.',
      parameters: {
        type: 'object',
        properties: {
          orderId: ORDER_ID,
          status: { type: 'string', description: 'New status: Pending, Processing, Shipped, Delivered, Cancelled, Cancelled by Admin.' },
          note: { type: 'string', description: 'Optional note to attach to the order.' },
          confirmToken: { type: 'string', description: 'Confirmation token from the admin. Only include after the admin explicitly confirms.' },
        },
        required: ['orderId', 'status'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'cancel_order',
      description: 'Cancel an order and restore stock for each item. Requires admin confirmation.',
      parameters: {
        type: 'object',
        properties: {
          orderId: ORDER_ID,
          reason: { type: 'string', description: 'Optional cancellation reason.' },
          confirmToken: { type: 'string', description: 'Confirmation token from the admin. Only include after the admin explicitly confirms.' },
        },
        required: ['orderId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_inventory',
      description: 'Update the stock count for a product. Requires admin confirmation.',
      parameters: {
        type: 'object',
        properties: {
          productId: { type: 'string', description: 'Product ID or name.' },
          stock: { type: 'integer', description: 'New stock level (must be >= 0).' },
          confirmToken: { type: 'string', description: 'Confirmation token from the admin. Only include after the admin explicitly confirms.' },
        },
        required: ['productId', 'stock'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_product',
      description: 'Update product details (name, price, description, etc.). Requires admin confirmation.',
      parameters: {
        type: 'object',
        properties: {
          productId: { type: 'string', description: 'Product ID or name.' },
          name: { type: 'string', description: 'New product name.' },
          price: { type: 'integer', description: 'New price in PKR.' },
          description: { type: 'string', description: 'New description text.' },
          category: { type: 'string', description: 'New category.' },
          badge: { type: 'string', description: 'New badge text or null to remove.' },
          confirmToken: { type: 'string', description: 'Confirmation token from the admin. Only include after the admin explicitly confirms.' },
        },
        required: ['productId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_discount',
      description: 'Create a new discount/promo code. Requires admin confirmation.',
      parameters: {
        type: 'object',
        properties: {
          code: { type: 'string', description: 'Promo code (uppercase, no spaces).' },
          type: { type: 'string', description: 'Discount type: "percent" (percentage off) or "fixed" (fixed PKR off).', enum: ['percent', 'fixed'] },
          value: { type: 'number', description: 'Discount value (percentage or PKR amount).' },
          minSpend: { type: 'integer', description: 'Minimum order total to apply this code. Default 0.' },
          description: { type: 'string', description: 'Short description shown to customers.' },
          confirmToken: { type: 'string', description: 'Confirmation token from the admin. Only include after the admin explicitly confirms.' },
        },
        required: ['code', 'type', 'value'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_discount',
      description: 'Update an existing discount/promo code. Requires admin confirmation.',
      parameters: {
        type: 'object',
        properties: {
          discountId: { type: 'string', description: 'Discount code or document ID.' },
          active: { type: 'boolean', description: 'Whether the discount is active.' },
          value: { type: 'number', description: 'New discount value.' },
          minSpend: { type: 'integer', description: 'New minimum spend.' },
          confirmToken: { type: 'string', description: 'Confirmation token from the admin. Only include after the admin explicitly confirms.' },
        },
        required: ['discountId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delete_discount',
      description: 'Delete a discount/promo code permanently. Requires admin confirmation.',
      parameters: {
        type: 'object',
        properties: {
          discountId: { type: 'string', description: 'Discount code or document ID to delete.' },
          confirmToken: { type: 'string', description: 'Confirmation token from the admin. Only include after the admin explicitly confirms.' },
        },
        required: ['discountId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_store_setting',
      description: 'Update a store setting (e.g. sale configuration, free shipping threshold, tax rate). Requires admin confirmation.',
      parameters: {
        type: 'object',
        properties: {
          key: { type: 'string', description: 'Setting key. Examples: sale.discount, freeShippingThreshold, taxRate, storeName.' },
          value: { type: 'string', description: 'New value for the setting.' },
          confirmToken: { type: 'string', description: 'Confirmation token from the admin. Only include after the admin explicitly confirms.' },
        },
        required: ['key', 'value'],
      },
    },
  },
];

/* ---------------- Tool dispatch ---------------- */

const READ_TOOLS = new Set([
  'search_orders', 'lookup_order', 'get_today_orders', 'get_sales_summary', 'get_low_stock_products',
]);
export const WRITE_TOOLS = new Set([
  'update_order_status', 'cancel_order', 'update_inventory', 'update_product',
  'create_discount', 'update_discount', 'delete_discount', 'update_store_setting',
]);
export const ADMIN_TOOLS = new Set([...READ_TOOLS, ...WRITE_TOOLS]);
export function isAdminTool(name){ return ADMIN_TOOLS.has(name); }

function parseValue(raw){
  if(raw === 'true') return true;
  if(raw === 'false') return false;
  if(!isNaN(Number(raw)) && raw !== '') return Number(raw);
  return raw;
}

async function resolveProductId(query, idToken){
  if(/^[A-Za-z]+-\d+$/i.test(query)) return query;
  const products = await getProducts();
  const q = String(query).toLowerCase();
  const hit = products.find(p => p.id === query || p.name?.toLowerCase() === q || p.name?.toLowerCase().includes(q));
  if(hit) return hit.id;
  return query;
}

export async function runAdminTool(name, rawArgs, ctx){
  const args = typeof rawArgs === 'string' ? JSON.parse(rawArgs) : (rawArgs || {});
  const isWrite = WRITE_TOOLS.has(name);

  // Confirmation gate: write tools need a confirmToken.
  if(isWrite && !args.confirmToken){
    return {
      needsConfirmation: true,
      tool: name,
      summary: summarizeWrite(name, args),
      args: stripConfirmToken(args),
    };
  }

  // Execute the tool.
  try{
    switch(name){
      /* ---- Read ---- */
      case 'search_orders': return await searchOrders(args, ctx);
      case 'lookup_order': return await lookupOrder(args, ctx);
      case 'get_today_orders': return await getTodayOrders(ctx);
      case 'get_sales_summary': return await salesSummary(args, ctx);
      case 'get_low_stock_products': return await lowStock(args, ctx);
      /* ---- Write ---- */
      case 'update_order_status': return await doUpdateOrderStatus(args, ctx);
      case 'cancel_order': return await doCancelOrder(args, ctx);
      case 'update_inventory': return await doUpdateInventory(args, ctx);
      case 'update_product': return await doUpdateProduct(args, ctx);
      case 'create_discount': return await doCreateDiscount(args, ctx);
      case 'update_discount': return await doUpdateDiscount(args, ctx);
      case 'delete_discount': return await doDeleteDiscount(args, ctx);
      case 'update_store_setting': return await doUpdateStoreSetting(args, ctx);
      default: return { error: `Unknown admin tool: ${name}` };
    }
  }catch(err){
    return { error: err.message || String(err) };
  }
}

function summarizeWrite(name, args){
  switch(name){
    case 'update_order_status': return `Update order ${args.orderId} status to "${args.status}"${args.note ? ' with note: "'+args.note+'"' : ''}`;
    case 'cancel_order': return `Cancel order ${args.orderId}${args.reason ? ' (reason: "'+args.reason+'")' : ''}`;
    case 'update_inventory': return `Set stock of product ${args.productId} to ${args.stock}`;
    case 'update_product': return `Update product ${args.productId}: ${Object.entries(args).filter(([k])=>k!=='productId'&&k!=='confirmToken').map(([k,v])=>`${k}=${v}`).join(', ') || 'no changes specified'}`;
    case 'create_discount': return `Create discount code "${args.code}" (${args.type} ${args.value}${args.type==='percent'?'%':' PKR'} off)`;
    case 'update_discount': return `Update discount ${args.discountId}: ${Object.entries(args).filter(([k])=>k!=='discountId'&&k!=='confirmToken').map(([k,v])=>`${k}=${v}`).join(', ')}`;
    case 'delete_discount': return `Delete discount code "${args.discountId}" permanently`;
    case 'update_store_setting': return `Set store setting "${args.key}" = "${args.value}"`;
  }
}

function stripConfirmToken(args){
  const { confirmToken, ...rest } = args;
  return rest;
}

/* ---- Read tool implementations ---- */

async function searchOrders(args, ctx){
  const limit = Math.min(50, Math.max(1, Number(args.limit) || 10));
  const daysBack = Number(args.daysBack) || 30;
  const statusFilter = String(args.status || '').trim();

  const since = new Date(Date.now() - daysBack * 86400000).toISOString();
  let url = `${FS_ROOT()}/orders?key=${process.env.FIREBASE_API_KEY || 'AIzaSyAAkIcNkUzzvcbUwXirBxsFPhtZcNqOsV0'}`;
  const params = new URLSearchParams();
  params.set('pageSize', String(limit));
  const q = `createdAt >= ${since}`;
  if(statusFilter) params.set('query', `status=="${statusFilter}" AND createdAt >= ${since}`);
  else params.set('query', `createdAt >= ${since}`);

  const headers = {};
  const idToken = ctx.idToken;
  if(idToken) headers['Authorization'] = `Bearer ${idToken}`;

  const res = await fetch(`${url}&${params.toString()}`, {
    headers,
    signal: AbortSignal.timeout ? AbortSignal.timeout(12000) : undefined,
  });
  if(!res.ok) throw new StoreError(`Failed to search orders: ${res.status}`);
  const data = await res.json();
  const orders = (data.documents || []).map(d => {
    const o = decodeFields(d.fields || {});
    return {
      orderId: o.orderId || docId(d.name),
      status: o.status || 'Pending',
      total: o.totals?.grand ?? null,
      customer: o.customer?.name || o.customer?.email || 'Guest',
      placedAt: o.createdAt || o.placedAt || null,
    };
  });
  return { results: orders, total: orders.length };
}

async function lookupOrder(args, ctx){
  const id = String(args.orderId || '').trim();
  const result = await getOrderForUser(id, ctx.user, ctx.idToken);
  if(result.error === 'not_found') throw new StoreError(`Order ${id} not found.`);
  if(result.error === 'not_authorized') throw new StoreError(`Not authorized to view order ${id}.`);
  if(result.error) throw new StoreError(result.error);
  return result;
}

async function getTodayOrders(ctx){
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const since = startOfDay.toISOString();
  let url = `${FS_ROOT()}/orders?key=${process.env.FIREBASE_API_KEY || 'AIzaSyAAkIcNkUzzvcbUwXirBxsFPhtZcNqOsV0'}`;
  const params = new URLSearchParams({ pageSize: '50', query: `createdAt >= "${since}"` });
  const headers = {};
  if(ctx.idToken) headers['Authorization'] = `Bearer ${ctx.idToken}`;
  const res = await fetch(`${url}&${params.toString()}`, {
    headers,
    signal: AbortSignal.timeout ? AbortSignal.timeout(12000) : undefined,
  });
  if(!res.ok) throw new StoreError(`Failed to fetch today's orders: ${res.status}`);
  const data = await res.json();
  const orders = (data.documents || []).map(d => {
    const o = decodeFields(d.fields || {});
    return {
      orderId: o.orderId || docId(d.name),
      status: o.status || 'Pending',
      total: o.totals?.grand ?? null,
      customer: o.customer?.name || o.customer?.email || 'Guest',
      placedAt: o.createdAt || o.placedAt || null,
    };
  });
  const revenue = orders.reduce((s, o) => s + (Number(o.total) || 0), 0);
  return {
    date: new Date().toISOString().split('T')[0],
    count: orders.length,
    revenue,
    avgOrder: orders.length ? Math.round(revenue / orders.length) : 0,
    statusBreakdown: orders.reduce((acc, o) => { acc[o.status] = (acc[o.status] || 0) + 1; return acc; }, {}),
    orders,
  };
}

async function salesSummary(args, ctx){
  const daysBack = Math.min(30, Math.max(1, Number(args.daysBack) || 1));
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const since = new Date(startOfDay.getTime() - daysBack * 86400000).toISOString();

  let url = `${FS_ROOT()}/orders?key=${process.env.FIREBASE_API_KEY || 'AIzaSyAAkIcNkUzzvcbUwXirBxsFPhtZcNqOsV0'}`;
  const params = new URLSearchParams({ pageSize: '50', query: `createdAt >= "${since}"` });
  const headers = {};
  if(ctx.idToken) headers['Authorization'] = `Bearer ${ctx.idToken}`;
  const res = await fetch(`${url}&${params.toString()}`, {
    headers,
    signal: AbortSignal.timeout ? AbortSignal.timeout(12000) : undefined,
  });
  if(!res.ok) throw new StoreError(`Failed to fetch sales: ${res.status}`);
  const data = await res.json();
  const orders = (data.documents || []).map(d => decodeFields(d.fields || {}));
  const total = orders.reduce((s, o) => s + (Number(o.totals?.grand) || 0), 0);
  return {
    period: daysBack === 1 ? 'today' : `last ${daysBack} days`,
    orderCount: orders.length,
    totalRevenue: total,
    avgOrderValue: orders.length ? Math.round(total / orders.length) : 0,
    statusBreakdown: orders.reduce((acc, o) => { acc[o.status || 'Unknown'] = (acc[o.status || 'Unknown'] || 0) + 1; return acc; }, {}),
  };
}

async function lowStock(args, ctx){
  const threshold = Number(args.threshold) || 5;
  const products = await getProducts();
  const low = products
    .filter(p => Number(p.stock || 0) <= threshold)
    .sort((a, b) => Number(a.stock || 0) - Number(b.stock || 0))
    .slice(0, 20)
    .map(p => ({
      id: p.id,
      name: p.name,
      stock: Number(p.stock || 0),
      price: Number(p.price || 0),
      category: p.category || '',
    }));
  return { threshold, products: low, count: low.length };
}

/* ---- Write tool implementations ---- */

async function doUpdateOrderStatus(args, ctx){
  const { orderId, status, note } = args;
  const result = await updateOrderStatus(orderId, status, ctx.idToken, note ? { adminNote: note } : {});
  return { success: true, orderId, newStatus: result.status, updatedAt: result.updatedAt };
}

async function doCancelOrder(args, ctx){
  const result = await cancelOrder(args.orderId, ctx.idToken);
  return { success: true, ...result };
}

async function doUpdateInventory(args, ctx){
  const pid = await resolveProductId(args.productId, ctx.idToken);
  const result = await updateInventory(pid, args.stock, ctx.idToken);
  return { success: true, ...result };
}

async function doUpdateProduct(args, ctx){
  const pid = await resolveProductId(args.productId, ctx.idToken);
  const fields = { ...args };
  delete fields.productId;
  delete fields.confirmToken;
  if(!Object.keys(fields).length) throw new StoreError('No fields specified to update.');
  const result = await updateProduct(pid, fields, ctx.idToken);
  return { success: true, ...result };
}

async function doCreateDiscount(args, ctx){
  const fields = { ...args };
  delete fields.confirmToken;
  const result = await createDiscount(fields, ctx.idToken);
  return { success: true, ...result };
}

async function doUpdateDiscount(args, ctx){
  const { discountId, ...fields } = args;
  delete fields.confirmToken;
  if(!Object.keys(fields).length) throw new StoreError('No fields specified to update.');
  const result = await updateDiscount(discountId, fields, ctx.idToken);
  return { success: true, ...result };
}

async function doDeleteDiscount(args, ctx){
  const result = await deleteDiscount(args.discountId, ctx.idToken);
  return { success: true, ...result };
}

async function doUpdateStoreSetting(args, ctx){
  const result = await updateStoreSetting(args.key, parseValue(args.value), ctx.idToken);
  return { success: true, key: args.key, value: args.value };
}
