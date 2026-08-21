// Test-only stand-in for the AI Gateway.
//
// Enabled with HELPISH_MOCK=1. It exists so the tool layer, permission gating,
// streaming, conversation trimming and the chat UI can all be exercised
// end-to-end without spending a real model call — and so Helpish stays testable
// if the gateway is unreachable.
//
// It is not a model. It picks a plausible tool for the question, then reads the
// tool result back as a short answer. Production never imports this unless the
// env var is set.

function sseResponse(events){
  const encoder = new TextEncoder();
  let i = 0;
  const stream = new ReadableStream({
    async pull(controller){
      if(i >= events.length){
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
        return;
      }
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(events[i++])}\n\n`));
      await new Promise(r => setTimeout(r, 12));      // visible streaming
    },
  });
  return { ok: true, status: 200, body: stream };
}

const textDeltas = (text) => text.match(/\S+\s*/g)?.map(chunk => ({
  choices: [{ index: 0, delta: { content: chunk } }],
})) || [];

function toolCallEvent(name, args){
  return [{
    choices: [{
      index: 0,
      delta: { tool_calls: [{ index: 0, id: `mock_${name}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] },
    }],
  }, {
    choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
  }];
}

const money = (n) => 'Rs. ' + Number(n || 0).toLocaleString('en-US');

function pickTool(text){
  const t = text.toLowerCase();
  const budget = t.match(/(?:under|below|less than|upto|up to|max)\s*(?:rs\.?|pkr)?\s*([\d,]+)/i)
    || t.match(/(?:rs\.?|pkr)\s*([\d,]+)/i);
  const budgetMax = budget ? Number(budget[1].replace(/,/g, '')) : undefined;

  if(/order\s*(?:id|number|#)?\s*(gb-[\w-]+|\d{4,})/i.test(t) || /\bmy order\b|\border status\b/.test(t)){
    const id = t.match(/(gb-[\w-]+)/i)?.[1] || '';
    return ['getAuthenticatedOrder', { orderId: id }];
  }
  if(/\bsale\b|\bdeal|\bdiscount\b(?!\s*code)|\boffer/.test(t)) return ['getActiveSale', {}];
  if(/promo|coupon|code/.test(t)) return ['getPromoInformation', {}];
  if(/shipping|delivery|deliver|postage|payment|cod/.test(t)) return ['getShippingInformation', {}];
  if(/categor|what do you sell|what all/.test(t)) return ['getCategories', {}];
  if(/in stock|available|availability|stock/.test(t)) return ['checkProductStock', { name: text.replace(/.*(?:of|for)\s+/i, '').slice(0, 40) }];
  if(/gift|birthday|anniversary|present|eid|wedding/.test(t)){
    return ['recommendGifts', { budgetMax, occasion: (t.match(/birthday|anniversary|eid|wedding/) || [])[0], limit: 4 }];
  }
  return ['searchProducts', { query: text.replace(/[?.!]/g, '').split(/\s+/).slice(0, 5).join(' '), maxPrice: budgetMax, limit: 4 }];
}

function answerFromToolResult(result){
  if(!result) return 'I could not read that just now. Try again in a moment.';
  if(result.error){
    if(result.error === 'not_signed_in') return 'Please sign in to your Gbyrish account and I can pull up that order for you.';
    if(result.error === 'order_unavailable') return 'I cannot find that order id on your account. Check it on your profile page and send it again.';
    return 'The catalogue is briefly unavailable. Try again in a moment.';
  }
  const list = result.products || result.candidates;
  if(Array.isArray(list)){
    if(!list.length) return 'Nothing in stock matches that. Tell me a slightly higher budget and I will look again.';
    const lines = list.slice(0, 3).map(p => `${p.name} at ${money(p.price)}${p.stock <= 3 ? ` (only ${p.stock} left)` : ''} — #product/${p.id}`);
    return `Here is what fits: ${lines.join('; ')}. ${list[0].name} is the one I would pick first.`;
  }
  if(result.order) return `Order ${result.order.orderId} is currently ${result.order.status}, with ${result.order.items.length} item(s) and a total of ${money(result.order.total)}.`;
  if(result.product) return `${result.product.name} is ${money(result.product.price)} and ${result.product.inStock ? `in stock with ${result.product.stock} available` : 'out of stock right now'}. ${result.product.description.slice(0, 160)}`;
  if(typeof result.inStock === 'boolean') return `${result.name} is ${result.inStock ? `in stock, ${result.stock} available` : 'out of stock at the moment'}.`;
  if(result.categories) return `We sell ${result.categories.map(c => c.name).join(', ')}. Tell me who the gift is for and your budget, and I will narrow it down.`;
  if('saleRunning' in result){
    return result.saleRunning
      ? `${result.name} is running right now at ${result.discountPercent} percent off${result.ends ? `, until ${result.ends}` : ''}.`
      : 'No store-wide sale is running at the moment, though some individual products are discounted.';
  }
  if(result.percentCoupons) return result.percentCoupons.length
    ? `Active codes: ${result.percentCoupons.map(c => `${c.code} for ${c.percentOff} percent off`).join(', ')}. Enter one in the cart.`
    : 'There are no promo codes active right now.';
  if(result.flatShippingFee !== undefined){
    return `Shipping is ${money(result.flatShippingFee)}, free over ${money(result.freeShippingOver)}. Gift wrap is ${money(result.giftWrapFee)}. We accept ${result.paymentMethods.join(' and ')}. For delivery timing, message us on WhatsApp.`;
  }
  return 'Ask me about a product, a budget, or an order id and I will look it up.';
}

/** Same contract as gateway.chat(): a Response-ish for stream, a JSON body otherwise. */
export function mockChat({ messages, tools, stream }){
  const last = messages[messages.length - 1] || {};

  // Admin drafting and summarising both call without tools and expect JSON back.
  if(!tools && !stream){
    const sys = String(messages[0]?.content || '');
    if(sys.includes('draft product listings')){
      const desc = String(last.content || '');
      const price = Number(desc.match(/(?:rs\.?|pkr)\s*([\d,]+)/i)?.[1]?.replace(/,/g, '') || '') || null;
      const stock = Number(desc.match(/(\d+)\s*(?:in stock|pieces|pcs|units)/i)?.[1] || '') || null;
      const name = desc.split(/[.,\n]/)[0].replace(/^(?:a|an|the)\s+/i, '').trim().slice(0, 60) || 'Handcrafted Piece';
      const isBundle = /\bbundle\b|\bdeal\b|\bcombo\b/i.test(desc);
      const cat = isBundle ? 'Deals'
        : (['Ring', 'Wallet', 'Bouquets (Customizable)', 'Customized Baskets', 'Stainless Steel Jewelry']
            .find(c => desc.toLowerCase().includes(c.toLowerCase().split(' ')[0])) || 'Stainless Steel Jewelry');
      // Bundle extras, so the Deals-only fields can be exercised end to end.
      const worth = Number(desc.match(/(?:worth|value|combined)\s*(?:of\s*)?(?:rs\.?|pkr)?\s*([\d,]+)/i)?.[1]?.replace(/,/g, '') || '') || null;
      const includes = desc.match(/includes?\s+([^.]+)/i)?.[1]?.split(/,| and /).map(s => s.trim()).filter(Boolean) || [];
      return {
        choices: [{ message: { content: JSON.stringify({
          name: name.replace(/\b\w/g, m => m.toUpperCase()),
          category: cat,
          description: `${name.replace(/\b\w/g, m => m.toUpperCase())}, handcrafted in small batches at Gbyrish. Finished by hand so every piece carries its own character. A considered choice for gifting or for keeping.`,
          price, originalPrice: isBundle ? worth : null, stock,
          customizable: /custom|personal|engrav|name/i.test(desc),
          includedItems: isBundle ? includes : [],
          badge: isBundle ? 'best value' : null,
          notes: price ? '' : 'No price was given, so the price field was left empty.',
        }) } }],
      };
    }
    return { choices: [{ message: { content: 'Earlier the customer was browsing gift options and discussing budget.' } }] };
  }

  // Admin agent mode: system prompt contains "Admin Agent".
  if(sysIncludes(messages, 'Admin Agent')){
    const toolMsg = [...messages].reverse().find(m => m.role === 'tool');
    if(toolMsg){
      let result = null;
      try { result = JSON.parse(toolMsg.content); } catch { /* leave null */ }
      return sseResponse([...textDeltas(answerFromAdminToolResult(result)), { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }]);
    }
    const userMsg = [...messages].reverse().find(m => m.role === 'user');
    const text = String(userMsg?.content || '');
    // Check if the user confirmed a write action.
    if(/^(yes|confirm|proceed|do it|go ahead)$/i.test(text) && tools){
      return sseResponse(toolCallEvent('update_order_status', { orderId: 'GB-10001', status: 'Shipped' }));
    }
    // Pick an admin tool based on keywords.
    const adminTool = pickAdminTool(text);
    return sseResponse(toolCallEvent(adminTool[0], adminTool[1]));
  }

  // A tool result is on the stack: answer from it.
  const toolMsg = [...messages].reverse().find(m => m.role === 'tool');
  if(toolMsg){
    let result = null;
    try { result = JSON.parse(toolMsg.content); } catch { /* leave null */ }
    return sseResponse([...textDeltas(answerFromToolResult(result)), { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }]);
  }

  // First pass: request a tool.
  const userMsg2 = [...messages].reverse().find(m => m.role === 'user');
  const text2 = String(userMsg2?.content || '');
  if(tools){
    const [name, args] = pickTool(text2);
    return sseResponse(toolCallEvent(name, args));
  }
  return sseResponse([...textDeltas('Ask me about our products, prices, gifts or your order and I will look it up.'), { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }]);
}

function sysIncludes(messages, str){
  return messages.some(m => m.role === 'system' && String(m.content).includes(str));
}

function pickAdminTool(text){
  const t = text.toLowerCase();
  if(/\btoday\b/.test(t) && /order/.test(t)) return ['get_today_orders', {}];
  if(/\bsale\b|\brevenue\b|\bsummary\b/.test(t)) return ['get_sales_summary', {}];
  if(/\blow\b.*\bstock\b|\bout of\b.*\bstock\b/.test(t)) return ['get_low_stock_products', {}];
  if(/\border\b.*\bsearch\b|\bfind\b.*\border\b/.test(t)) return ['search_orders', { daysBack: 7, limit: 10 }];
  if(/\border\s*(?:id|number|#)?\s*(gb-[\w-]+|\d{4,})/i.test(t)) return ['lookup_order', { orderId: (t.match(/(gb-[\w-]+)/i) || [])[1] || 'GB-10001' }];
  if(/\bupdate\b.*\bstatus\b|\bship/.test(t)) return ['update_order_status', { orderId: 'GB-10001', status: 'Shipped' }];
  if(/\bcancel/.test(t)) return ['cancel_order', { orderId: 'GB-10001' }];
  if(/\bstock\b.*\bto\b.*\d/.test(t)) return ['update_inventory', { productId: 'prod-001', stock: 10 }];
  if(/\bprice\b.*\bto\b.*\d/.test(t)) return ['update_product', { productId: 'prod-001', price: 1999 }];
  if(/\bdiscount\b.*\bcreate\b|\bpromo\b.*\bcode\b/.test(t)) return ['create_discount', { code: 'TEST20', type: 'percent', value: 20 }];
  if(/\bdelete\b.*\bdiscount\b|\bremove\b.*\bpromo\b/.test(t)) return ['delete_discount', { discountId: 'TEST20' }];
  return ['search_orders', { daysBack: 7, limit: 10 }];
}

function answerFromAdminToolResult(result){
  if(!result) return 'Done.';
  if(result.error) return 'Error: ' + result.error;
  if(result.results) return `Found ${result.results.length} order(s). The most recent is ${result.results[0]?.orderId} (${result.results[0]?.status}).`;
  if(result.count !== undefined) return `Found ${result.count} product(s) with low stock.`;
  if(result.orderId) return `Order ${result.orderId}: status is ${result.status}.`;
  if(result.success) return 'Done. ' + JSON.stringify(result).slice(0, 120);
  if(result.date) return `Today: ${result.count} orders, Rs. ${result.revenue?.toLocaleString?.('en-US') || result.revenue} revenue.`;
  if(result.period) return `${result.period}: ${result.orderCount} orders, Rs. ${result.totalRevenue?.toLocaleString?.('en-US') || result.totalRevenue} total.`;
  return 'Done.';
}
