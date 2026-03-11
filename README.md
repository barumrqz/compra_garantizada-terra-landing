# Terra Compra Garantizada — Landing Page

Landing page de lead-gen para **Terra Grupo Inmobiliario**, desplegada en Cloudflare Pages con un Worker de atribución dual (Meta CAPI + GHL API V2).

## Arquitectura

```
┌──────────────┐     ┌─────────────────────┐     ┌─────────────┐
│  Usuario     │────▶│  Cloudflare Pages   │────▶│  GHL API V2 │
│  (Browser)   │     │  + _worker.js       │     │  (Contacto  │
│              │     │                     │────▶│  + Opp)      │
│  dataLayer   │     │  HTMLRewriter       │     └─────────────┘
│  + localStorage    │  (GTM + WA inject)  │
│              │     │                     │────▶┌─────────────┐
└──────────────┘     └─────────────────────┘     │  Meta CAPI  │
                                                  │  (Lead evt) │
                                                  └─────────────┘
```

### Flujo de datos

1. **index.html** — Multi-step form con progressive submission
   - Step 1: Nombre, Teléfono, Email → `POST /api/lead` (crea contacto + oportunidad en GHL)
   - Steps 2-5: Preguntas de filtro → `POST /api/lead-update` (actualiza campo por campo)
   - Step final: `POST /api/lead-complete` (dispara Meta CAPI Lead event)
2. **Multi-Touch Attribution** — UTMs se guardan en `localStorage` (first/last touch + journey completo)
3. **Deduplicación Meta** — `event_id` generado en browser se envía a CAPI para deduplificar con el pixel del browser

## Estructura de archivos

```
.
├── index.html                    # Landing page principal
├── gracias.html                  # Thank-you page (lead calificado)
├── gracias_fuera.html            # Thank-you page (fuera de cobertura)
├── politica-privacidad.html      # Aviso de privacidad (LFPDPPP)
├── terminos.html                 # Términos y condiciones
├── _worker.js                    # Cloudflare Worker (API + HTMLRewriter)
├── tailwind.config.js            # Design tokens centralizados
├── favicon.svg                   # Ícono del sitio
├── .env.example                  # Template de variables de entorno
├── .gitignore                    # Archivos ignorados por Git
└── README.md                     # Este archivo
```

## Variables de entorno

Todas se configuran en **Cloudflare Pages → Settings → Environment variables** (como Secrets).

| Variable | Descripción | Requerida |
|---|---|---|
| `GHL_ACCESS_TOKEN` | Token de Private Integration GHL (`pit-...`) | ✅ |
| `GHL_LOCATION_ID` | ID de la subcuenta GHL | ✅ |
| `GHL_PIPELINE_ID` | ID del pipeline donde crear oportunidades | ✅ |
| `GHL_STAGE_ID` | ID de la etapa inicial del pipeline | ✅ |
| `GHL_FIELD_SITUACION` | ID del custom field: situación | ✅ |
| `GHL_FIELD_ADEUDO` | ID del custom field: adeudo | ✅ |
| `GHL_FIELD_UBICACION` | ID del custom field: ubicación | ✅ |
| `GHL_FIELD_URGENCIA` | ID del custom field: urgencia | ✅ |
| `GHL_FIELD_GA4_CLIENT_ID` | ID del custom field: GA4 Client ID | ✅ |
| `GHL_FIELD_FBCLID` | ID del custom field: fbclid | ✅ |
| `GHL_FIELD_SOURCE_ID` | ID del custom field: source/utm_id | ✅ |
| `GHL_FIELD_SOURCE_URL` | ID del custom field: URL de origen | ✅ |
| `GHL_FIELD_CTWACLID` | ID del custom field: click-to-WhatsApp ID | ✅ |
| `GHL_FIELD_AD_NAME` | ID del custom field: nombre del anuncio | ✅ |
| `META_DATASET_ID` | ID del dataset de Meta (pixel ID) | ✅ |
| `META_ACCESS_TOKEN` | Token de acceso de Meta CAPI | ✅ |
| `META_TEST_CODE` | Código de test de Meta (dejar vacío en prod) | ❌ |
| `GTM_ID` | ID de Google Tag Manager (`GTM-XXXXX`) | ❌ |
| `WHATSAPP_NUMBER` | Número de WhatsApp con código de país | ❌ |
| `ALLOWED_ORIGIN` | Dominio permitido para CORS | ❌ |

## Deploy

1. Clonar el repo
2. Ir a **Cloudflare Dashboard → Workers & Pages → Create application → Pages → Connect to Git**
3. Seleccionar el repositorio
4. **Build settings:** dejar Build command y Build output directory **EN BLANCO**
5. Agregar todas las env vars como Secrets
6. Deploy

### Actualizar env vars

Si cambias una variable de entorno, ve a **Deployments** y haz **Retry deployment** para que tome efecto.

## Testing

- Para probar Meta CAPI sin enviar eventos reales, configura `META_TEST_CODE` con el código de prueba de Meta Events Manager
- Verificar eventos en Meta Events Manager → Test Events
- Verificar contactos en GHL → Contacts

## Stack

- **Frontend:** HTML + Tailwind CSS CDN + Vanilla JS
- **Backend:** Cloudflare Pages Functions (`_worker.js`)
- **CRM:** GoHighLevel API V2
- **Tracking:** Meta CAPI + GTM + GA4
