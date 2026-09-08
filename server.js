import 'dotenv/config';
import express from 'express';
import OpenAI, { toFile } from 'openai';
import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const port = process.env.PORT || 3000;
const client = process.env.OPENAI_API_KEY ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;
const supabaseUrl = process.env.SUPABASE_URL || '';
const supabasePublishableKey = process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY || '';
const supabaseSecretKey = process.env.SUPABASE_SECRET_KEY || '';
const supabaseAuth = supabaseUrl && supabasePublishableKey ? createClient(supabaseUrl, supabasePublishableKey) : null;
const supabaseAdmin = supabaseUrl && supabaseSecretKey ? createClient(supabaseUrl, supabaseSecretKey) : null;

const mercadopagoAccessToken = process.env.MERCADOPAGO_ACCESS_TOKEN || '';
const mercadopagoWebhookSecret = process.env.MERCADOPAGO_WEBHOOK_SECRET || '';
const mercadopagoWebhookTestSecret = process.env.MERCADOPAGO_WEBHOOK_TEST_SECRET || mercadopagoWebhookSecret;
const MERCADOPAGO_PRO_PLAN_ID = process.env.MERCADOPAGO_PRO_PLAN_ID || '';
const MERCADOPAGO_BUSINESS_PLAN_ID = process.env.MERCADOPAGO_BUSINESS_PLAN_ID || '';
const MERCADOPAGO_PRO_PLAN_NAME = 'AdMaker IA PRO';
const MERCADOPAGO_BUSINESS_PLAN_NAME = 'AdMaker IA BUSINESS';
const FREE_MONTHLY_LIMIT = 3;
const PLAN_LIMITS = { FREE: 3, PRO: 50, BUSINESS: 200 };

app.use(express.json({ limit: '15mb' }));
app.use(express.static(path.join(__dirname, 'public')));

function tokenFrom(req) {
  const h = req.headers.authorization || '';
  return h.startsWith('Bearer ') ? h.slice(7) : '';
}

async function supabaseRest(pathname, options = {}) {
  if (!supabaseUrl || !supabaseSecretKey) throw new Error('SUPABASE_SECRET_KEY no configurada');
  const headers = {
    apikey: supabaseSecretKey,
    Authorization: `Bearer ${supabaseSecretKey}`,
    'Content-Type': 'application/json',
    ...(options.headers || {})
  };
  const response = await fetch(`${supabaseUrl}/rest/v1/${pathname}`, { ...options, headers });
  const text = await response.text();
  if (!response.ok) {
    console.error('SUPABASE_REST_ERROR', JSON.stringify({ status: response.status, statusText: response.statusText, body: text.slice(0, 2000) }));
    const err = new Error(`Supabase REST ${response.status}: ${text}`);
    err.status = response.status;
    err.body = text;
    throw err;
  }
  return text ? JSON.parse(text) : null;
}

async function requireUser(req, res, next) {
  if (!supabaseAuth) return res.status(503).json({ error: 'La autenticación todavía no está configurada en Render.' });
  if (!supabaseSecretKey) return res.status(503).json({ error: 'Falta configurar SUPABASE_SECRET_KEY en Render.' });
  const token = tokenFrom(req);
  if (!token) return res.status(401).json({ error: 'Inicia sesión para usar AdMaker IA.' });
  const { data, error } = await supabaseAuth.auth.getUser(token);
  if (error || !data?.user) return res.status(401).json({ error: 'Tu sesión expiró. Inicia sesión nuevamente.' });
  req.user = data.user;
  req.token = token;
  next();
}

function monthStartISO() {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString();
}

function normalizePlan(value) {
  const p = String(value || 'FREE').toUpperCase();
  return PLAN_LIMITS[p] ? p : 'FREE';
}

async function accountState(userId) {
  let rows = await supabaseRest(`subscriptions?select=id,mp_subscription_id,mp_plan_id,plan,status,payer_email,updated_at&user_id=eq.${encodeURIComponent(userId)}&order=updated_at.desc&limit=20`);
  let active = (rows || []).find(r => normalizePlan(r.plan) !== 'FREE' && String(r.status).toLowerCase() === 'authorized');

  // Self-heal: if the webhook was missed or arrived before the real plan IDs
  // were known, ask Mercado Pago for this user's active subscription and sync it.
  if (!active && mercadopagoAccessToken && supabaseAdmin) {
    try {
      const { data: userData } = await supabaseAdmin.auth.admin.getUserById(userId);
      const synced = await syncUserSubscriptionFromMercadoPago(userData?.user || null);
      if (synced?.matched) {
        rows = await supabaseRest(`subscriptions?select=id,mp_subscription_id,mp_plan_id,plan,status,payer_email,updated_at&user_id=eq.${encodeURIComponent(userId)}&order=updated_at.desc&limit=20`);
        active = (rows || []).find(r => normalizePlan(r.plan) !== 'FREE' && String(r.status).toLowerCase() === 'authorized');
      }
    } catch (e) {
      console.warn('MP_ACCOUNT_SELF_HEAL_ERROR', String(e));
    }
  }

  const plan = active ? normalizePlan(active.plan) : 'FREE';
  return { plan, limit: PLAN_LIMITS[plan], subscription: active || null };
}

async function monthlyUsage(req) {
  // Usage is based on every campaign generated this month, not on how many
  // campaigns remain visible in History. Deleting a campaign therefore never
  // restores a monthly generation credit.
  const userId = encodeURIComponent(req.user.id);
  const start = encodeURIComponent(monthStartISO());
  const rows = await supabaseRest(`campaigns?select=id&user_id=eq.${userId}&created_at=gte.${start}`);
  return Array.isArray(rows) ? rows.length : 0;
}

function fallback(data) {
  const n=data.name || 'tu producto', p=data.price || 'precio especial', d=data.description || 'una solución pensada para facilitarte la vida';
  return { headline:`${n}: una forma más fácil de conseguir lo que buscas`, emotional:`¿Buscas algo que realmente te dé ${d}? Conoce ${n} y descubre por qué puede ser justo lo que estabas buscando. ✨`, offer:`🔥 ${n} por ${p}. Una oportunidad para probar ${d}. Escríbenos hoy y pregunta por disponibilidad.`, direct:`Conoce ${n}. ${d}. Ideal para ${data.audience || 'personas que buscan calidad'}. Precio: ${p}. Escríbenos por WhatsApp.`, whatsapp:`Hola 👋 Vi ${n} y quiero más información. ¿Sigue disponible por ${p}? También quisiera saber cómo funciona la entrega.`, reel:`0–3s: muestra ${n} con una pregunta potente.\n3–8s: demuestra ${d}.\n8–12s: muestra ${p}.\n12–15s: “Escríbenos por WhatsApp y pide el tuyo”.`, audiences:[data.audience || 'Compradores interesados','Personas comparando opciones','Clientes que valoran precio y calidad'], cta:'Escríbenos por WhatsApp' };
}

async function mercadoPagoGet(pathname) {
  if (!mercadopagoAccessToken) throw new Error('MERCADOPAGO_ACCESS_TOKEN no configurado');
  const r = await fetch(`https://api.mercadopago.com${pathname}`, {
    headers: { Authorization: `Bearer ${mercadopagoAccessToken}` }
  });
  const text = await r.text();
  if (!r.ok) {
    console.error('MERCADOPAGO_GET_ERROR', r.status, text.slice(0, 2000));
    throw new Error(`Mercado Pago ${r.status}`);
  }
  return text ? JSON.parse(text) : {};
}

function validWebhookSignature(req) {
  const liveMode = req.query.live_mode ?? req.body?.live_mode;
  const secret = String(liveMode) === 'false' ? mercadopagoWebhookTestSecret : mercadopagoWebhookSecret;
  if (!secret) return false;
  const xSignature = req.headers['x-signature'];
  const xRequestId = req.headers['x-request-id'] || '';
  const dataId = req.query['data.id'] || req.body?.data?.id || '';
  if (!xSignature || !dataId) return false;
  const parts = String(xSignature).split(',').reduce((acc, part) => {
    const [k, v] = part.split('=');
    if (k && v) acc[k.trim()] = v.trim();
    return acc;
  }, {});
  if (!parts.ts || !parts.v1) return false;
  const manifest = `id:${dataId};request-id:${xRequestId};ts:${parts.ts};`;
  const expected = crypto.createHmac('sha256', secret).update(manifest).digest('hex');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(parts.v1, 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function findAuthUserByEmail(email) {
  if (!supabaseAdmin || !email) return null;
  const target = String(email).trim().toLowerCase();
  let page = 1;
  const perPage = 1000;
  while (page <= 10) {
    const { data, error } = await supabaseAdmin.auth.admin.listUsers({ page, perPage });
    if (error) throw error;
    const user = (data?.users || []).find(u => String(u.email || '').toLowerCase() === target);
    if (user) return user;
    if (!data?.users || data.users.length < perPage) break;
    page += 1;
  }
  return null;
}

let mpPlanCache = { expiresAt: 0, plans: null };

function planFromMercadoPagoPlanId(planId, catalog = null) {
  const id = String(planId || '');
  if (id && MERCADOPAGO_PRO_PLAN_ID && id === String(MERCADOPAGO_PRO_PLAN_ID)) return 'PRO';
  if (id && MERCADOPAGO_BUSINESS_PLAN_ID && id === String(MERCADOPAGO_BUSINESS_PLAN_ID)) return 'BUSINESS';
  if (catalog) {
    if (catalog.PRO?.id && id === String(catalog.PRO.id)) return 'PRO';
    if (catalog.BUSINESS?.id && id === String(catalog.BUSINESS.id)) return 'BUSINESS';
  }
  return 'FREE';
}

function normalizeText(v) {
  return String(v || '').trim().toLowerCase();
}

async function resolveMercadoPagoPlanCatalog(force = false) {
  if (!mercadopagoAccessToken) return {
    PRO: { id: MERCADOPAGO_PRO_PLAN_ID || '' },
    BUSINESS: { id: MERCADOPAGO_BUSINESS_PLAN_ID || '' }
  };
  if (!force && mpPlanCache.plans && Date.now() < mpPlanCache.expiresAt) return mpPlanCache.plans;

  const [proData, businessData, allData] = await Promise.all([
    mercadoPagoGet(`/preapproval_plan/search?status=active&q=${encodeURIComponent(MERCADOPAGO_PRO_PLAN_NAME)}`),
    mercadoPagoGet(`/preapproval_plan/search?status=active&q=${encodeURIComponent(MERCADOPAGO_BUSINESS_PLAN_NAME)}`),
    mercadoPagoGet('/preapproval_plan/search?status=active')
  ]);
  const results = Array.isArray(allData?.results) ? allData.results : [];
  const proResults = Array.isArray(proData?.results) ? proData.results : [];
  const businessResults = Array.isArray(businessData?.results) ? businessData.results : [];
  const findPlan = (name, price, externalReference, targetedResults) => {
    const pool = targetedResults.length ? targetedResults : results;
    const exact = pool.find(p => normalizeText(p.reason) === normalizeText(name));
    if (exact) return exact;
    const ref = pool.find(p => normalizeText(p.external_reference) === normalizeText(externalReference));
    if (ref) return ref;
    return results.find(p => Number(p?.auto_recurring?.transaction_amount) === price && String(p?.auto_recurring?.frequency_type || '').toLowerCase() === 'months');
  };

  const pro = findPlan(MERCADOPAGO_PRO_PLAN_NAME, 29900, 'ADMAKER_PRO', proResults);
  const business = findPlan(MERCADOPAGO_BUSINESS_PLAN_NAME, 79900, 'ADMAKER_BUSINESS', businessResults);
  const catalog = {
    PRO: { id: pro?.id || MERCADOPAGO_PRO_PLAN_ID || '', reason: pro?.reason || MERCADOPAGO_PRO_PLAN_NAME },
    BUSINESS: { id: business?.id || MERCADOPAGO_BUSINESS_PLAN_ID || '', reason: business?.reason || MERCADOPAGO_BUSINESS_PLAN_NAME }
  };
  mpPlanCache = { plans: catalog, expiresAt: Date.now() + 5 * 60 * 1000 };
  console.log('MP_PLAN_CATALOG', JSON.stringify({ PRO: catalog.PRO.id ? '[id encontrado]' : '[sin id]', BUSINESS: catalog.BUSINESS.id ? '[id encontrado]' : '[sin id]' }));
  return catalog;
}

function inferPlanFromSubscription(subscription, catalog = null) {
  const byId = planFromMercadoPagoPlanId(subscription?.preapproval_plan_id, catalog);
  if (byId !== 'FREE') return byId;

  const amount = Number(subscription?.auto_recurring?.transaction_amount);
  if (amount === 29900) return 'PRO';
  if (amount === 79900) return 'BUSINESS';

  const reason = normalizeText(subscription?.reason);
  if (reason === normalizeText(MERCADOPAGO_PRO_PLAN_NAME)) return 'PRO';
  if (reason === normalizeText(MERCADOPAGO_BUSINESS_PLAN_NAME)) return 'BUSINESS';
  return 'FREE';
}

async function syncUserSubscriptionFromMercadoPago(user) {
  const email = String(user?.email || '').trim();
  if (!email || !mercadopagoAccessToken) return { matched: false, reason: 'missing_email_or_token' };
  const catalog = await resolveMercadoPagoPlanCatalog(true);
  const query = `/preapproval/search?payer_email=${encodeURIComponent(email)}&limit=100`;
  const data = await mercadoPagoGet(query);
  const results = Array.isArray(data?.results) ? data.results : [];
  const authorizedResults = results.filter(r => String(r?.status || '').toLowerCase() === 'authorized');
  if (!authorizedResults.length) return { matched: false, reason: 'no_authorized_subscription' };

  // Mercado Pago's search response normally includes preapproval_plan_id, but
  // we also fetch the full subscription when that field is missing so we can
  // reliably resolve the plan. As a final fallback, infer the plan from the
  // recurring amount because our PRO/BUSINESS prices are unique.
  const candidates = [];
  for (const item of authorizedResults) {
    let sub = item;
    if (!sub.preapproval_plan_id || !sub.auto_recurring?.transaction_amount) {
      try {
        const full = await mercadoPagoGet(`/preapproval/${encodeURIComponent(item.id)}`);
        if (full?.id) sub = { ...item, ...full };
      } catch (e) {
        console.warn('MP_SUBSCRIPTION_DETAIL_ERROR', String(e));
      }
    }
    const plan = inferPlanFromSubscription(sub, catalog);
    candidates.push({ sub, plan });
  }

  const ranked = candidates
    .filter(x => x.plan !== 'FREE')
    .sort((a, b) => new Date(b.sub.date_created || 0) - new Date(a.sub.date_created || 0));

  if (!ranked.length) {
    console.warn('MP_SUBSCRIPTION_UNRECOGNIZED_PLAN', JSON.stringify({
      email: '[oculto]',
      candidates: candidates.map(x => ({
        id: String(x.sub?.id || ''),
        preapproval_plan_id: String(x.sub?.preapproval_plan_id || ''),
        amount: Number(x.sub?.auto_recurring?.transaction_amount || 0),
        reason: String(x.sub?.reason || '')
      }))
    }));
    return { matched: false, reason: 'unrecognized_plan' };
  }

  return saveSubscriptionFromMercadoPago(ranked[0].sub, ranked[0].plan, catalog, user);
}

async function saveSubscriptionFromMercadoPago(subscription, knownPlan = '', catalog = null, matchedUser = null) {
  const plan = knownPlan || planFromMercadoPagoPlanId(subscription.preapproval_plan_id, catalog || await resolveMercadoPagoPlanCatalog());
  const status = String(subscription.status || 'pending').toLowerCase();
  const payerEmail = subscription.payer_email || subscription.payer_email_address || matchedUser?.email || '';
  const user = matchedUser || await findAuthUserByEmail(payerEmail);
  if (!user) {
    console.warn('MP_USER_NOT_FOUND', payerEmail ? '[email recibido, usuario no encontrado]' : '[sin email]');
    return { matched: false, plan, status };
  }
  const effectivePlan = status === 'authorized' ? plan : 'FREE';
  await supabaseRest('subscriptions?on_conflict=mp_subscription_id', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify({
      user_id: user.id,
      mp_subscription_id: String(subscription.id),
      mp_plan_id: String(subscription.preapproval_plan_id || ''),
      plan: effectivePlan,
      status,
      payer_email: payerEmail,
      updated_at: new Date().toISOString()
    })
  });
  console.log('MP_SUBSCRIPTION_SYNC', JSON.stringify({ user_id: user.id, plan: effectivePlan, status, mp_subscription_id: String(subscription.id) }));
  return { matched: true, plan: effectivePlan, status };
}

async function processMercadoPagoWebhook(req) {
  const type = String(req.query.type || req.body?.type || '');
  const dataId = String(req.query['data.id'] || req.body?.data?.id || '');
  if (!dataId) return { ignored: true, reason: 'missing_data_id' };

  if (type === 'subscription_preapproval') {
    const subscription = await mercadoPagoGet(`/preapproval/${encodeURIComponent(dataId)}`);
    return saveSubscriptionFromMercadoPago(subscription);
  }

  if (type === 'subscription_authorized_payment') {
    const invoice = await mercadoPagoGet(`/authorized_payments/${encodeURIComponent(dataId)}`);
    if (!invoice.preapproval_id) return { ignored: true, reason: 'missing_preapproval_id' };
    const subscription = await mercadoPagoGet(`/preapproval/${encodeURIComponent(invoice.preapproval_id)}`);
    return saveSubscriptionFromMercadoPago(subscription);
  }

  return { ignored: true, reason: `unsupported_type:${type}` };
}

app.get('/api/config', (req,res)=>res.json({ supabaseUrl, supabaseAnonKey: supabasePublishableKey, configured:Boolean(supabaseUrl && supabasePublishableKey) }));

app.get('/api/plans', requireUser, async (req,res)=>{
  try {
    const catalog = await resolveMercadoPagoPlanCatalog();
    const proId = catalog.PRO.id;
    const businessId = catalog.BUSINESS.id;
    res.json({
      PRO: { name:'PRO', price:29900, limit:50, planId:proId, checkoutUrl:proId ? `https://www.mercadopago.com.co/subscriptions/checkout?preapproval_plan_id=${encodeURIComponent(proId)}` : '' },
      BUSINESS: { name:'BUSINESS', price:79900, limit:200, planId:businessId, checkoutUrl:businessId ? `https://www.mercadopago.com.co/subscriptions/checkout?preapproval_plan_id=${encodeURIComponent(businessId)}` : '' }
    });
  } catch (e) {
    console.error('API_PLANS_ERROR', String(e));
    res.status(500).json({error:'No se pudieron consultar los planes de Mercado Pago.'});
  }
});

app.post('/api/mercadopago/sync', requireUser, async (req,res)=>{
  try {
    const result = await syncUserSubscriptionFromMercadoPago(req.user);
    const account = await accountState(req.user.id);
    res.json({ok:true, sync:result, plan:account.plan, limit:account.limit});
  } catch (e) {
    console.error('API_MP_SYNC_ERROR', String(e));
    res.status(500).json({error:'No se pudo sincronizar tu suscripción.'});
  }
});

app.get('/api/me', requireUser, async (req,res)=>{
  try {
    const usage=await monthlyUsage(req);
    const account=await accountState(req.user.id);
    res.json({id:req.user.id,email:req.user.email,name:req.user.user_metadata?.full_name||req.user.user_metadata?.name||'',plan:account.plan,used:usage,limit:account.limit});
  } catch(e) { console.error('API_ME_ERROR', String(e)); res.status(500).json({error:'No se pudo cargar tu cuenta.'}); }
});

app.get('/api/usage', requireUser, async (req,res)=>{
  try {
    const [used, account]=await Promise.all([monthlyUsage(req), accountState(req.user.id)]);
    res.json({plan:account.plan,used,limit:account.limit,remaining:Math.max(0,account.limit-used)});
  } catch(e) {
    console.error('API_USAGE_ERROR_RAW', String(e));
    res.status(500).json({error:'No se pudo consultar el uso.'});
  }
});

app.post('/api/generate', requireUser, async (req,res)=>{
  const data=req.body || {};
  if(!data.name && !data.description) return res.status(400).json({error:'Agrega el nombre o la descripción del producto.'});
  let used, account;
  try {
    [used, account] = await Promise.all([monthlyUsage(req), accountState(req.user.id)]);
  } catch(e) {
    console.error('API_GENERATE_USAGE_ERROR', String(e));
    return res.status(500).json({error:'No se pudo comprobar tu límite.'});
  }
  if(used >= account.limit) return res.status(402).json({error:`Has usado las ${account.limit} campañas de tu plan ${account.plan}. Revisa Planes para aumentar tu capacidad.`});
  if(!client) return res.json({ ...fallback(data), demo:true, usage:{used:used+1,limit:account.limit,plan:account.plan} });
  const metaRequested = data.metaAds !== false;
  const metaInstruction = metaRequested ? `\nGenera también un paquete de META ADS para Facebook e Instagram con: meta.primary_texts (3 textos principales distintos), meta.headlines (5 titulares de máximo 40 caracteres), meta.descriptions (3 descripciones cortas), meta.cta (CTA breve) y meta.recommended_format (Feed, Stories o Reels). Respeta las políticas publicitarias: no uses atributos personales sensibles, no prometas resultados garantizados y no inventes descuentos o características.` : `\nNo generes el paquete de Meta Ads porque el usuario lo desactivó.`;
  const campaignType = data.campaignType || 'Venta directa';
  const tone = data.tone || 'Persuasivo';
  const platform = data.platform || 'Multicanal';
  const offer = data.offer || '';
  const content=[{type:'input_text',text:`Eres el director creativo y estratega de performance de una agencia de publicidad digital. Crea una campaña altamente accionable para este producto y contexto.\nProducto: ${data.name||''}\nPrecio: ${data.price||''}\nDescripción: ${data.description||''}\nPúblico: ${data.audience||''}\nObjetivo: ${data.goal||'Conseguir ventas'}\nTipo de campaña: ${campaignType}\nTono: ${tone}\nCanal principal: ${platform}\nOferta adicional proporcionada por el usuario: ${offer}\nEstilo de mensaje: ${data.messageStyle || 'Beneficios + deseo'}\nLongitud: ${data.length || 'Equilibrada'}\n${metaInstruction}\nDevuelve SOLO JSON válido con EXACTAMENTE estas claves: headline, hooks (array de 5), emotional, offer, direct, whatsapp, reel, caption (caption para Instagram/Facebook), short_ad (anuncio corto), audiences (array de 3 strings), cta, visual_brief, score_reason, meta. score_reason debe ser una explicación de 1-2 frases sobre por qué el mensaje es claro y accionable. Si Meta Ads está desactivado, meta debe ser null. No inventes características técnicas, garantías, testimonios, descuentos, cifras de resultados ni atributos personales. Escribe en español latino. Usa frases naturales, concretas y comerciales. Adapta el lenguaje al tipo de campaña y al tono.` }];
  if(data.imageDataUrl) content.push({type:'input_image',image_url:data.imageDataUrl,detail:'high'});
  try {
    const r=await client.responses.create({model:'gpt-5.6-luna',input:[{role:'user',content}]});
    let raw=(r.output_text||'').replace(/^```json\s*/,'').replace(/```$/,'').trim();
    const result=JSON.parse(raw);
    try {
      await supabaseRest('campaigns', { method:'POST', headers:{ Prefer:'return=minimal' }, body:JSON.stringify({ user_id:req.user.id, name:data.name||'Sin nombre', product_price:data.price||'', description:data.description||'', audience:data.audience||'', goal:data.goal||'', plan:account.plan, result }) });
    } catch(error) { console.error('DB_INSERT_ERROR', String(error)); return res.status(500).json({error:'La campaña se generó, pero no se pudo guardar en tu historial.'}); }
    res.json({...result,usage:{used:used+1,limit:account.limit,plan:account.plan}});
  } catch(e){ console.error(e); res.status(500).json({error:'No se pudo generar la campaña. Revisa la configuración de la API.'}); }
});

app.post('/api/generate-image', requireUser, async (req,res)=>{
  const {prompt,imageDataUrl}=req.body||{};
  if(!prompt) return res.status(400).json({error:'Falta el prompt.'});
  if(!client) return res.json({demo:true,imageDataUrl:null,message:'Añade OPENAI_API_KEY para activar imágenes IA.'});
  try {
    let response;
    if(imageDataUrl && imageDataUrl.startsWith('data:image/')){
      const match=imageDataUrl.match(/^data:(image\/[^;]+);base64,(.+)$/s);
      if(!match) return res.status(400).json({error:'La imagen subida no tiene un formato válido.'});
      const mime=match[1], ext=mime.split('/')[1].replace('jpeg','jpg');
      const file=await toFile(Buffer.from(match[2],'base64'),`producto.${ext}`,{type:mime});
      response=await client.images.edit({model:'gpt-image-2',image:file,prompt,size:'1024x1024',quality:'medium',output_format:'webp'});
    } else response=await client.images.generate({model:'gpt-image-2',prompt,size:'1024x1024',quality:'medium',output_format:'webp'});
    const b64=response.data?.[0]?.b64_json;
    res.json({imageDataUrl:b64?`data:image/webp;base64,${b64}`:null});
  } catch(e){ console.error('IMAGE_GENERATION_ERROR',e); res.status(500).json({error:e?.message||'No se pudo generar el creativo visual.'}); }
});

app.get('/api/campaigns', requireUser, async (req,res)=>{ try { const rows=await supabaseRest('campaigns?select=id,name,product_price,description,audience,goal,plan,result,created_at&user_id=eq.'+encodeURIComponent(req.user.id)+'&order=created_at.desc&limit=100'); const visible=(rows||[]).filter(x=>!x?.result?._deleted); res.json(visible); } catch(e) { console.error('CAMPAIGNS_ERROR', String(e)); res.status(500).json({error:'No se pudo cargar el historial. Revisa la configuración de Supabase.'}); } });
app.delete('/api/campaigns/:id', requireUser, async (req,res)=>{ try { const id=encodeURIComponent(req.params.id); const rows=await supabaseRest('campaigns?select=id,result&user_id=eq.'+encodeURIComponent(req.user.id)+'&id=eq.'+id+'&limit=1'); if(!rows?.length) return res.status(404).json({error:'Campaña no encontrada.'}); const result={...(rows[0].result||{}),_deleted:true,_deleted_at:new Date().toISOString()}; await supabaseRest('campaigns?id=eq.'+id+'&user_id=eq.'+encodeURIComponent(req.user.id), { method:'PATCH', headers:{ Prefer:'return=minimal' }, body:JSON.stringify({result}) }); res.json({ok:true,usage_preserved:true}); } catch(e) { console.error('DELETE_CAMPAIGN_ERROR', String(e)); res.status(500).json({error:'No se pudo eliminar la campaña.'}); } });

// Mercado Pago Webhook: verifies Mercado Pago's HMAC signature, then fetches the
// subscription/invoice from Mercado Pago before changing the user's plan.
app.post('/api/mercadopago/webhook', async (req,res)=>{
  try {
    if (!mercadopagoWebhookSecret) return res.status(503).json({error:'Webhook secret no configurado.'});
    if (!validWebhookSignature(req)) return res.status(401).json({error:'Firma de webhook inválida.'});
    const result = await processMercadoPagoWebhook(req);
    res.status(200).json({ok:true,...result});
  } catch(e) {
    console.error('MERCADOPAGO_WEBHOOK_ERROR', String(e));
    res.status(500).json({error:'No se pudo procesar la notificación.'});
  }
});

app.use((req,res)=>res.sendFile(path.join(__dirname,'public','index.html')));
app.listen(port,'0.0.0.0',()=>console.log(`AdMaker IA running on port ${port}`));
