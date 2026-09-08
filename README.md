# AdMaker IA — versión completa

Esta versión incluye cuentas con Supabase, historial persistente por usuario, límite FREE mensual, recuperación de contraseña, generador de campañas, generación de imágenes usando la foto del producto y planes.

## 1. Render
Variables de entorno:
- OPENAI_API_KEY = tu clave actual
- SUPABASE_URL = Project URL de Supabase
- SUPABASE_PUBLISHABLE_KEY = Publishable key de Supabase

Compatibilidad: el servidor también acepta SUPABASE_ANON_KEY si ya tienes esa variable configurada.

## 2. Supabase
Abre **SQL Editor > New query**, pega el contenido de `supabase.sql` y pulsa **Run**. Esto crea la tabla `campaigns`, activa RLS y permite que cada usuario vea/cree/elimine únicamente sus propias campañas.

## 3. Auth
En Supabase > Authentication > Providers, deja habilitado Email. Para pruebas puedes desactivar temporalmente la confirmación de correo; en producción conviene mantenerla activada.

## 4. Despliegue
Sube estos archivos a GitHub y Render hará el deploy con `npm install` y `npm start`.
