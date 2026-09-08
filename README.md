# AdMaker IA Pro

MVP full-stack para convertir la foto y datos de un producto en una campaña publicitaria.

## Incluye
- Dashboard SaaS
- Generación real de copy con OpenAI Responses API
- Entrada multimodal: texto + imagen del producto
- Generación de un creativo visual con el endpoint de imágenes
- Historial local de campañas
- Planes Free / Pro / Business (interfaz; cobros reales se conectan después)
- Arquitectura lista para conectar Stripe, WhatsApp Cloud API y una base de datos

## Ejecutar
1. Instala Node.js 20+.
2. Copia `.env.example` como `.env`.
3. Coloca tu `OPENAI_API_KEY`.
4. Ejecuta `npm install`.
5. Ejecuta `npm start`.
6. Abre `http://localhost:3000`.

La clave de API queda en el servidor y no en el navegador.

## Siguiente etapa de producción
- PostgreSQL/Supabase para usuarios y campañas.
- Auth real (Clerk/Auth.js/Supabase Auth).
- Stripe para suscripciones.
- WhatsApp Cloud API para recibir/enviar mensajes.
- Almacenamiento S3/R2 para imágenes.
- Analytics de Meta Ads/TikTok Ads.
