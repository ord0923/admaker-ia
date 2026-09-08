import 'dotenv/config';
import express from 'express';
import OpenAI, { toFile } from 'openai';
import { createClient } from '@supabase/supabase-js';
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
const FREE_MONTHLY_LIMIT = 3;

app.use(express.json({ limit: '15mb' }));
app.use(express.static(path.join(__dirname, 'public')));

function tokenFrom(req) {
  const h = req.headers.authorization || '';
  return h.startsWith('Bearer ') ? h.slice(7) : '';
}
function dbFor() {
  return supabaseAdmin;
}
async function requireUser(req, res, next) {
  if (!supabaseAuth) return res.status(503).json({ error: 'La autenticación todavía no está configurada en Render.' });
  if (!supabaseAdmin) return res.status(503).json({ error: 'Falta configurar SUPABASE_SECRET_KEY en Render.' });
  const token = tokenFrom(req);
  if (!token) return res.status(401).json({ error: 'Inicia sesión para usar AdMaker IA.' });
  const { data, error } = await supabaseAuth.auth.getUser(token);
  if (error || !data?.user) return res.status(401).json({ error: 'Tu sesión expiró. Inicia sesión nuevamente.' });
  req.user = data.user;
  req.token = token;
  req.db = dbFor();
  next();
}
function monthStartISO() {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString();
}
async function monthlyUsage(req) {
  if (!req.db) return 0;
  const { count, error } = await req.db.from('campaigns').select('id', { count: 'exact', head: true }).eq('user_id', req.user.id).gte('created_at', monthStartISO());
  if (error) {
    console.error('SUPABASE_USAGE_ERROR_RAW', String(error));
    console.error('SUPABASE_USAGE_ERROR_JSON', JSON.stringify(error));
    console.error('SUPABASE_USAGE_ERROR_OBJECT', error);
    if (error.code === '42P01') return 0;
    throw error;
  }
  return count || 0;
}
function fallback(data) {
  const n=data.name || 'tu producto', p=data.price || 'precio especial', d=data.description || 'una solución pensada para facilitarte la vida';
  return { headline:`${n}: una forma más fácil de conseguir lo que buscas`, emotional:`¿Buscas algo que realmente te dé ${d}? Conoce ${n} y descubre por qué puede ser justo lo que estabas buscando. ✨`, offer:`🔥 ${n} por ${p}. Una oportunidad para probar ${d}. Escríbenos hoy y pregunta por disponibilidad.`, direct:`Conoce ${n}. ${d}. Ideal para ${data.audience || 'personas que buscan calidad'}. Precio: ${p}. Escríbenos por WhatsApp.`, whatsapp:`Hola 👋 Vi ${n} y quiero más información. ¿Sigue disponible por ${p}? También quisiera saber cómo funciona la entrega.`, reel:`0–3s: muestra ${n} con una pregunta potente.\n3–8s: demuestra ${d}.\n8–12s: muestra ${p}.\n12–15s: “Escríbenos por WhatsApp y pide el tuyo”.`, audiences:[data.audience || 'Compradores interesados','Personas comparando opciones','Clientes que valoran precio y calidad'], cta:'Escríbenos por WhatsApp' };
}

app.get('/api/config', (req,res)=>res.json({ supabaseUrl, supabaseAnonKey: supabasePublishableKey, configured:Boolean(supabaseUrl && supabasePublishableKey) }));
app.get('/api/me', requireUser, async (req,res)=>{ const usage=await monthlyUsage(req); res.json({id:req.user.id,email:req.user.email,name:req.user.user_metadata?.full_name||req.user.user_metadata?.name||'',plan:'FREE',used:usage,limit:FREE_MONTHLY_LIMIT}); });
app.get('/api/usage', requireUser, async (req,res)=>{
  try {
    const used=await monthlyUsage(req);
    res.json({plan:'FREE',used,limit:FREE_MONTHLY_LIMIT,remaining:Math.max(0,FREE_MONTHLY_LIMIT-used)});
  } catch(e) {
    console.error('API_USAGE_ERROR_RAW', String(e));
    console.error('API_USAGE_ERROR_JSON', JSON.stringify(e));
    console.error('API_USAGE_ERROR_OBJECT', e);
    res.status(500).json({error:'No se pudo consultar el uso.'});
  }
});

app.post('/api/generate', requireUser, async (req,res)=>{
  const data=req.body || {};
  if(!data.name && !data.description) return res.status(400).json({error:'Agrega el nombre o la descripción del producto.'});
  let used;
  try {
    used=await monthlyUsage(req);
  } catch(e) {
    console.error('API_GENERATE_USAGE_ERROR', {
      code: e?.code || '',
      message: e?.message || '',
      details: e?.details || '',
      hint: e?.hint || ''
    });
    return res.status(500).json({error:'No se pudo comprobar tu límite.'});
  }
  if(used >= FREE_MONTHLY_LIMIT) return res.status(402).json({error:`Has usado tus ${FREE_MONTHLY_LIMIT} campañas gratuitas de este mes. Ve a Planes para conocer las opciones PRO.`});
  if(!client) return res.json({ ...fallback(data), demo:true, usage:{used:used+1,limit:FREE_MONTHLY_LIMIT} });
  const content=[{type:'input_text',text:`Eres el director creativo de una agencia de performance marketing. Crea una campaña para este producto.\nProducto: ${data.name||''}\nPrecio: ${data.price||''}\nDescripción: ${data.description||''}\nPúblico: ${data.audience||''}\nObjetivo: ${data.goal||'ventas'}\nDevuelve SOLO JSON válido con estas claves: headline, emotional, offer, direct, whatsapp, reel, audiences (array de 3 strings), cta. No inventes características técnicas ni descuentos que no estén dados. Escribe en español latino. Sé persuasivo sin prometer resultados garantizados.` }];
  if(data.imageDataUrl) content.push({type:'input_image',image_url:data.imageDataUrl,detail:'high'});
  try {
    const r=await client.responses.create({model:'gpt-5.6-luna',input:[{role:'user',content}]});
    let raw=(r.output_text||'').replace(/^```json\s*/,'').replace(/```$/,'').trim();
    const result=JSON.parse(raw);
    const { error } = await req.db.from('campaigns').insert({ user_id:req.user.id, name:data.name||'Sin nombre', product_price:data.price||'', description:data.description||'', audience:data.audience||'', goal:data.goal||'', result });
    if(error) { console.error('DB_INSERT_ERROR',error); return res.status(500).json({error:'La campaña se generó, pero no se pudo guardar en tu historial.'}); }
    res.json({...result,usage:{used:used+1,limit:FREE_MONTHLY_LIMIT}});
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

app.get('/api/campaigns', requireUser, async (req,res)=>{ const {data,error}=await req.db.from('campaigns').select('id,name,product_price,description,audience,goal,result,created_at').order('created_at',{ascending:false}).limit(50); if(error) return res.status(500).json({error:'No se pudo cargar el historial. Ejecuta el SQL de instalación en Supabase.'}); res.json(data||[]); });
app.delete('/api/campaigns/:id', requireUser, async (req,res)=>{ const {error}=await req.db.from('campaigns').delete().eq('id',req.params.id).eq('user_id',req.user.id); if(error) return res.status(500).json({error:'No se pudo eliminar la campaña.'}); res.json({ok:true}); });

app.use((req,res)=>res.sendFile(path.join(__dirname,'public','index.html')));
app.listen(port,'0.0.0.0',()=>console.log(`AdMaker IA running on port ${port}`));
