import 'dotenv/config';
import express from 'express';
import OpenAI from 'openai';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const port = process.env.PORT || 3000;
const client = process.env.OPENAI_API_KEY ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;

app.use(express.json({ limit: '12mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const demoCampaigns = [];

function fallback(data) {
  const n=data.name || 'tu producto', p=data.price || 'precio especial', d=data.description || 'una solución pensada para facilitarte la vida';
  return {
    headline:`${n}: una forma más fácil de conseguir lo que buscas`,
    emotional:`¿Buscas algo que realmente te dé ${d}? Conoce ${n} y descubre por qué puede ser justo lo que estabas buscando. ✨`,
    offer:`🔥 ${n} por ${p}. Una oportunidad para probar ${d}. Escríbenos hoy y pregunta por disponibilidad.`,
    direct:`Conoce ${n}. ${d}. Ideal para ${data.audience || 'personas que buscan calidad'}. Precio: ${p}. Escríbenos por WhatsApp.`,
    whatsapp:`Hola 👋 Vi ${n} y quiero más información. ¿Sigue disponible por ${p}? También quisiera saber cómo funciona la entrega.`,
    reel:`0–3s: muestra ${n} con una pregunta potente.\\n3–8s: demuestra ${d}.\\n8–12s: muestra ${p}.\\n12–15s: “Escríbenos por WhatsApp y pide el tuyo”.`,
    audiences:[data.audience || 'Compradores interesados', 'Personas comparando opciones', 'Clientes que valoran precio y calidad'],
    cta:'Escríbenos por WhatsApp'
  };
}

app.post('/api/generate', async (req,res)=>{
  const data=req.body || {};
  if(!data.name && !data.description) return res.status(400).json({error:'Agrega el nombre o descripción del producto.'});
  if(!client) return res.json({ ...fallback(data), demo:true });

  const content=[{
    type:'input_text',
    text:`Eres el director creativo de una agencia de performance marketing. Crea una campaña para este producto.
Producto: ${data.name || ''}
Precio: ${data.price || ''}
Descripción: ${data.description || ''}
Público: ${data.audience || ''}
Objetivo: ${data.goal || 'ventas'}
Devuelve SOLO JSON válido con estas claves:
headline, emotional, offer, direct, whatsapp, reel, audiences (array de 3 strings), cta.
No inventes características técnicas ni descuentos que no estén dados. Escribe en español latino. Sé persuasivo sin prometer resultados garantizados.`
  }];
  if(data.imageDataUrl) content.push({type:'input_image', image_url:data.imageDataUrl, detail:'high'});

  try {
    const r=await client.responses.create({model:'gpt-5.6-luna', input:[{role:'user',content}]});
    let raw=r.output_text || '';
    raw=raw.replace(/^```json\s*/,'').replace(/```$/,'').trim();
    const result=JSON.parse(raw);
    demoCampaigns.unshift({id:Date.now(), name:data.name || 'Sin nombre', createdAt:new Date().toISOString(), result});
    res.json(result);
  } catch(e) {
    console.error(e);
    res.status(500).json({error:'No se pudo generar la campaña. Revisa tu API key y vuelve a intentar.'});
  }
});

app.post('/api/generate-image', async (req,res)=>{
  const {prompt}=req.body || {};
  if(!prompt) return res.status(400).json({error:'Falta el prompt.'});
  if(!client) return res.json({demo:true, imageDataUrl:null, message:'Añade OPENAI_API_KEY para activar imágenes IA.'});
  try{
    const response = await client.images.generate({
      model:'gpt-image-2',
      prompt,
      size:'1024x1024',
      quality:'medium',
      output_format:'webp'
    });
    const b64=response.data?.[0]?.b64_json;
    res.json({imageDataUrl:b64 ? `data:image/webp;base64,${b64}` : null});
  }catch(e){
    console.error(e);
    res.status(500).json({error:'No se pudo generar el creativo visual.'});
  }
});

app.get('/api/campaigns',(req,res)=>res.json(demoCampaigns));

app.get('*',(req,res)=>res.sendFile(path.join(__dirname,'public','index.html')));
app.listen(port, '0.0.0.0', () => console.log(`AdMaker IA Pro running on port ${port}`));
