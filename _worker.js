// Script de Cloudflare Worker (addEventListener fetch)
// Proxy de Atribución Dual (Meta CAPI + GHL) con EMQ Scoring y RUTEO ESTATICO

export default {
    async fetch(request, env) {
        const url = new URL(request.url);

        // ==========================================
        // 1. ZONA DE API BACKEND (/api/lead)
        // ==========================================
        if (url.pathname === '/api/lead') {

            // Manejo OBLIGATORIO de CORS: Preflight
            if (request.method === 'OPTIONS') {
                return new Response(null, {
                    headers: {
                        'Access-Control-Allow-Origin': '*',
                        'Access-Control-Allow-Methods': 'POST, OPTIONS',
                        'Access-Control-Allow-Headers': 'Content-Type, Validation'
                    }
                });
            }

            if (request.method !== 'POST') {
                return new Response('Not allowed', { status: 405 });
            }

            const headers = {
                'Access-Control-Allow-Origin': '*',
                'Content-Type': 'application/json'
            };

            try {
                // Extracción segura del payload, user_agent y CF-Connecting-IP.
                const data = await request.json();
                const clientIP = request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For') || '';
                const userAgent = request.headers.get('User-Agent') || '';

                // NORMALIZACIÓN PII
                const rawEmail = data.correo || '';
                const rawPhone = data.telefono || '';
                const rawName = data.nombre || '';

                const normEmail = rawEmail.toLowerCase().trim();
                const normPhoneRaw = rawPhone.replace(/\D/g, ''); // Solo números
                const normPhone = normPhoneRaw.length === 10 ? '52' + normPhoneRaw : normPhoneRaw;
                const normFirstName = rawName.split(' ')[0]?.toLowerCase().trim() || '';
                const normLastName = rawName.split(' ').slice(1).join(' ')?.toLowerCase().trim() || '';

                // HASHEO (SHA-256)
                async function sha256(str) {
                    if (!str) return '';
                    const encoder = new TextEncoder();
                    const buffer = await crypto.subtle.digest('SHA-256', encoder.encode(str));
                    const hashArray = Array.from(new Uint8Array(buffer));
                    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
                }

                const [hashedEmail, hashedPhone, hashedFirstName, hashedLastName] = await Promise.all([
                    sha256(normEmail), sha256(normPhone), sha256(normFirstName), sha256(normLastName)
                ]);

                const META_DATASET_ID = env.META_DATASET_ID || 'YOUR_META_PIXEL_ID';
                const META_ACCESS_TOKEN = env.META_ACCESS_TOKEN || 'YOUR_META_ACCESS_TOKEN';

                // GHL API V2 (Private Integration Token)
                const GHL_ACCESS_TOKEN = env.GHL_ACCESS_TOKEN || 'YOUR_GHL_ACCESS_TOKEN';
                const GHL_LOCATION_ID = env.GHL_LOCATION_ID || 'YOUR_LOCATION_ID';
                const META_TEST_CODE = env.META_TEST_CODE || null;

                // CAPI PAYLOAD
                const capiPayload = {
                    data: [{
                        event_name: 'Lead',
                        event_time: Math.floor(Date.now() / 1000), // SEGUNDOS UNIX
                        action_source: 'website',
                        event_source_url: data.source_url || 'https://terra.com.mx',
                        event_id: data.event_id || '',
                        user_data: {
                            client_ip_address: clientIP,
                            client_user_agent: userAgent,
                            em: hashedEmail ? [hashedEmail] : [],
                            ph: hashedPhone ? [hashedPhone] : [],
                            fn: hashedFirstName ? [hashedFirstName] : [],
                            ln: hashedLastName ? [hashedLastName] : [],
                            fbc: data.fbc || '',
                            fbp: data.fbp || ''
                        },
                        custom_data: {
                            situacion: data.situacion || '',
                            adeudo: data.adeudo || '',
                            ubicacion: data.ubicacion || '',
                            urgencia: data.urgencia || '',
                            first_touch_campaign: data.first_touch?.utm_campaign || '',
                            last_touch_campaign: data.last_touch?.utm_campaign || '',
                            journey_touches: data.ad_journey ? data.ad_journey.length : 0
                        }
                    }]
                };

                // Si hay código de prueba de Meta, se adjunta
                if (META_TEST_CODE) {
                    capiPayload.test_event_code = META_TEST_CODE;
                }

                // META REQUEST TRIGGER (Solo si NO es una situación problemática)
                // "Alguien más vive ahí (traspaso informal)" contamina los prospectos ideales en Meta.
                console.log("--> META PAYLOAD:", JSON.stringify(capiPayload));
                let metaReq = Promise.resolve({ status: 'Skipped' }); // Promesa vacía por defecto
                if (data.situacion !== 'Alguien más vive ahí (traspaso informal)') {
                    metaReq = fetch(`https://graph.facebook.com/v19.0/${META_DATASET_ID}/events?access_token=${META_ACCESS_TOKEN}`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(capiPayload)
                    }).then(async r => ({ status: r.status, body: await r.text() })).catch(e => ({ error: e.message }));
                }

                // ==========================================
                // GHL SMART UPSERT ALGORITHM (API V2)
                // Evitar db_constraint fallido por mezcla de email/teléfono
                // ==========================================

                const ghlHeaders = {
                    'Authorization': `Bearer ${GHL_ACCESS_TOKEN}`,
                    'Version': '2021-07-28',
                    'Content-Type': 'application/json',
                    'Accept': 'application/json'
                };

                // Funciones Auxiliares GHL
                const searchContact = async (query) => {
                    if (!query) return null;
                    const res = await fetch(`https://services.leadconnectorhq.com/contacts/search?query=${encodeURIComponent(query)}`, { headers: ghlHeaders });
                    if (!res.ok) return null;
                    const data = await res.json();
                    return data.contacts && data.contacts.length > 0 ? data.contacts[0].id : null;
                };

                const ghlSmartPromise = async () => {
                    try {
                        let contactId = null;
                        let action = 'POST'; // DEFAULT

                        // 1. BUSCAR POR TELÉFONO PRIMERO (Prioridad Inmobiliaria)
                        if (normPhone) {
                            contactId = await searchContact(normPhone);
                        }

                        // 2. BUSCAR POR CORREO SI NO HAY TELÉFONO
                        if (!contactId && normEmail) {
                            contactId = await searchContact(normEmail);
                        }

                        // PREPARAR DATOS COMUNES (Custom Fields y Tags)
                        const commonPayload = {
                            tags: ["lead flipping", "diagnóstico compra garantizada", "api_directa"],
                            source: "Terra Compra Garantizada",
                            customFields: [
                                { id: env.GHL_FIELD_SITUACION || 'ZqhjRk3qpd6h72qrGHTJ', field_value: data.situacion || '' },
                                { id: env.GHL_FIELD_ADEUDO || 'rSdAto1Gs3169a5Xoxm2', field_value: data.adeudo || '' },
                                { id: env.GHL_FIELD_UBICACION || 'pXWbHc17gFWLnPwh25ff', field_value: data.ubicacion || '' },
                                { id: env.GHL_FIELD_URGENCIA || 'zZ6Yb7X4k3enahD3mgUO', field_value: data.urgencia || '' },
                                {
                                    id: 'OI507tXb9GeiGgN3FTID', // Multi-Touch Journey
                                    field_value: JSON.stringify({
                                        first_click: data.first_touch || {},
                                        last_click: data.last_touch || {},
                                        all_touches: data.ad_journey || []
                                    })
                                },
                                // Social Listening & Tracking Confirmed IDs
                                { id: env.GHL_FIELD_GA4_CLIENT_ID || 'PENDING', field_value: data.ga4_client_id || '' },
                                { id: env.GHL_FIELD_FBCLID || 'PENDING', field_value: data.fbclid || '' },
                                { id: env.GHL_FIELD_SOURCE_ID || 'PENDING', field_value: data.last_touch?.utm_id || '' },
                                { id: env.GHL_FIELD_SOURCE_URL || 'PENDING', field_value: data.source_url || '' },
                                { id: env.GHL_FIELD_CTWACLID || 'PENDING', field_value: '' }, // Dejado vacío para leads de Web (Evita contaminación de campos de Whatsapp)
                                { id: env.GHL_FIELD_AD_NAME || 'PENDING', field_value: data.last_touch?.utm_content || '' }
                            ]
                        };

                        let res = null;
                        
                        // 3. DECISIÓN: ACTUALIZAR O CREAR
                        if (contactId) {
                            // UPDATE (PUT) - Para contactos existentes
                            // TRUCO A25: Solo inyectamos el First Name, Common Fields y Tags, PERO dejamos los emails/phones fuera
                            // para que la base de datos de GHL no patee error de restricción.
                            const updatePayload = {
                                ...commonPayload,
                                firstName: normFirstName,
                                lastName: normLastName
                            };
                            
                            res = await fetch(`https://services.leadconnectorhq.com/contacts/${contactId}`, {
                                method: 'PUT',
                                headers: ghlHeaders,
                                body: JSON.stringify(updatePayload)
                            });
                            action = 'PUT';

                        } else {
                            // CREATE (POST) - Contacto totalmente nuevo
                            const createPayload = {
                                ...commonPayload,
                                locationId: GHL_LOCATION_ID,
                                firstName: normFirstName,
                                lastName: normLastName,
                                email: normEmail,
                                phone: '+' + normPhone
                            };

                            res = await fetch('https://services.leadconnectorhq.com/contacts/', {
                                method: 'POST',
                                headers: ghlHeaders,
                                body: JSON.stringify(createPayload)
                            });
                            action = 'POST';
                        }

                        const bodyData = await res.text();
                        let oppBodyData = null;

                        if (res.ok) {
                            const jsonRes = JSON.parse(bodyData);
                            // Rescatar ContactID si era nuevo
                            if (action === 'POST' && jsonRes.contact?.id) {
                                contactId = jsonRes.contact.id;
                            }

                            // Crear Oportunidad en Pipeline
                            if (contactId) {
                                const oppPayload = {
                                    locationId: GHL_LOCATION_ID,
                                    contactId: contactId,
                                    pipelineId: env.GHL_PIPELINE_ID || 'FTICLZZ1pokVnGmFYXam',
                                    pipelineStageId: env.GHL_STAGE_ID || '87ef379f-90a7-4060-99ff-de14eaadf628',
                                    name: `${rawName || 'Lead'} - Terra Landing`,
                                    status: "open"
                                };

                                const oppRes = await fetch('https://services.leadconnectorhq.com/opportunities/', {
                                    method: 'POST',
                                    headers: ghlHeaders,
                                    body: JSON.stringify(oppPayload)
                                });
                                oppBodyData = await oppRes.text();
                            }
                        }
                        return { action: action, status: res.status, contactId: contactId, oppBody: oppBodyData };
                    } catch (e) {
                         return { error: e.message };
                    }
                };

                // PARALLEL EXECUTION (Fail-safe)
                const [metaResult, ghlResult] = await Promise.all([metaReq, ghlSmartPromise()]);

                return new Response(JSON.stringify({
                    success: true,
                    event_id: data.event_id,
                    debug_meta: metaResult,
                    debug_ghl: ghlResult
                }), { headers, status: 200 });

            } catch (error) {
                // Retornar 200 incluso si hay crash interno para que redirija a gracias.html
                return new Response(JSON.stringify({ success: false, msg: error.message }), { headers, status: 200 });
            }
        }

        // ==========================================
        // 2. ZONA DE TRANSFORMACIÓN HTML (GTM Dinámico)
        // ==========================================
        const GTM_ID = env.GTM_ID || null;
        const WHATSAPP_NUMBER = env.WHATSAPP_NUMBER || '524446687573';

        if (url.pathname === '/' || url.pathname === '/index.html' || url.pathname === '/gracias.html') {
            const response = await env.ASSETS.fetch(request);
            
            if (response.headers.get('content-type')?.includes('text/html')) {
                let rewriter = new HTMLRewriter();

                if (GTM_ID) {
                    rewriter.on('head', {
                        element(el) {
                            el.prepend(`
                                <!-- Google Tag Manager -->
                                <script>(function(w,d,s,l,i){w[l]=w[l]||[];w[l].push({'gtm.start':
                                new Date().getTime(),event:'gtm.js'});var f=d.getElementsByTagName(s)[0],
                                j=d.createElement(s),dl=l!='dataLayer'?'&l='+l:'';j.async=true;j.src=
                                'https://www.googletagmanager.com/gtm.js?id='+i+dl;f.parentNode.insertBefore(j,f);
                                })(window,document,'script','dataLayer','${GTM_ID}');</script>
                                <!-- End Google Tag Manager -->
                            `, { html: true });
                        }
                    })
                    .on('body', {
                        element(el) {
                            el.prepend(`
                                <!-- Google Tag Manager (noscript) -->
                                <noscript><iframe src="https://www.googletagmanager.com/ns.html?id=${GTM_ID}"
                                height="0" width="0" style="display:none;visibility:hidden"></iframe></noscript>
                                <!-- End Google Tag Manager (noscript) -->
                            `, { html: true });
                        }
                    });
                }

                if (WHATSAPP_NUMBER) {
                    rewriter.on('a[href*="wa.me"]', {
                        element(el) {
                            const href = el.getAttribute('href');
                            el.setAttribute('href', href.replace('524446687573', WHATSAPP_NUMBER));
                        }
                    });
                }

                return rewriter.transform(response);
            }
            return response;
        }

        return env.ASSETS.fetch(request);
    }
};
