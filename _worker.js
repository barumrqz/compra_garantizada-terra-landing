// Script de Cloudflare Worker (addEventListener fetch)
// Proxy de Atribución Dual (Meta CAPI + GHL) con EMQ Scoring y RUTEO ESTÁTICO
// V6 — Progressive Form Submission (3 endpoints)

export default {
    async fetch(request, env) {
        const url = new URL(request.url);

        // CORS headers compartidos
        const corsHeaders = {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, Validation'
        };
        const jsonHeaders = { ...corsHeaders, 'Content-Type': 'application/json' };

        // Preflight para TODOS los /api/* endpoints
        if (request.method === 'OPTIONS' && url.pathname.startsWith('/api/')) {
            return new Response(null, { headers: corsHeaders });
        }

        // ==========================================
        // SHARED: GHL Config & Helpers
        // ==========================================
        const GHL_ACCESS_TOKEN = env.GHL_ACCESS_TOKEN || '';
        const GHL_LOCATION_ID = env.GHL_LOCATION_ID || '';
        const META_DATASET_ID = env.META_DATASET_ID || '';
        const META_ACCESS_TOKEN = env.META_ACCESS_TOKEN || '';
        const META_TEST_CODE = env.META_TEST_CODE || null;

        const ghlHeaders = {
            'Authorization': `Bearer ${GHL_ACCESS_TOKEN}`,
            'Version': '2021-07-28',
            'Content-Type': 'application/json',
            'Accept': 'application/json'
        };

        // GHL field name → env var → hardcoded fallback ID
        const FIELD_MAP = {
            situacion: env.GHL_FIELD_SITUACION || 'ZqhjRk3qpd6h72qrGHTJ',
            adeudo: env.GHL_FIELD_ADEUDO || 'rSdAto1Gs3169a5Xoxm2',
            ubicacion: env.GHL_FIELD_UBICACION || 'pXWbHc17gFWLnPwh25ff',
            urgencia: env.GHL_FIELD_URGENCIA || 'zZ6Yb7X4k3enahD3mgUO',
            journey: 'OI507tXb9GeiGgN3FTID',
            ga4_client_id: env.GHL_FIELD_GA4_CLIENT_ID || 'PENDING',
            fbclid: env.GHL_FIELD_FBCLID || 'PENDING',
            source_id: env.GHL_FIELD_SOURCE_ID || 'PENDING',
            source_url: env.GHL_FIELD_SOURCE_URL || 'PENDING',
            ctwaclid: env.GHL_FIELD_CTWACLID || 'PENDING',
            ad_name: env.GHL_FIELD_AD_NAME || 'PENDING'
        };

        const searchContact = async (query) => {
            if (!query) return null;
            const res = await fetch(`https://services.leadconnectorhq.com/contacts/search?query=${encodeURIComponent(query)}`, { headers: ghlHeaders });
            if (!res.ok) return null;
            const data = await res.json();
            return data.contacts && data.contacts.length > 0 ? data.contacts[0].id : null;
        };

        async function sha256(str) {
            if (!str) return '';
            const encoder = new TextEncoder();
            const buffer = await crypto.subtle.digest('SHA-256', encoder.encode(str));
            const hashArray = Array.from(new Uint8Array(buffer));
            return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
        }

        // ==========================================
        // 1. POST /api/lead — Create GHL Contact + Opportunity (NO Meta)
        // ==========================================
        if (url.pathname === '/api/lead' && request.method === 'POST') {
            try {
                const data = await request.json();

                // NORMALIZACIÓN PII
                const rawName = data.nombre || '';
                const rawPhone = data.telefono || '';
                const rawEmail = data.correo || '';

                const normEmail = rawEmail.toLowerCase().trim();
                const normPhoneRaw = rawPhone.replace(/\D/g, '');
                const normPhone = normPhoneRaw.length === 10 ? '52' + normPhoneRaw : normPhoneRaw;
                const normFirstName = rawName.split(' ')[0]?.toLowerCase().trim() || '';
                const normLastName = rawName.split(' ').slice(1).join(' ')?.toLowerCase().trim() || '';

                // Smart Upsert: buscar por teléfono, luego por email
                let contactId = null;
                if (normPhone) contactId = await searchContact(normPhone);
                if (!contactId && normEmail) contactId = await searchContact(normEmail);

                // Custom fields (tracking only en esta fase, sin qualification fields)
                const trackingFields = [
                    {
                        id: FIELD_MAP.journey,
                        field_value: JSON.stringify({
                            first_click: data.first_touch || {},
                            last_click: data.last_touch || {},
                            all_touches: data.ad_journey || []
                        })
                    },
                    { id: FIELD_MAP.ga4_client_id, field_value: data.ga4_client_id || '' },
                    { id: FIELD_MAP.fbclid, field_value: data.fbclid || '' },
                    { id: FIELD_MAP.source_id, field_value: data.last_touch?.utm_id || '' },
                    { id: FIELD_MAP.source_url, field_value: data.source_url || '' },
                    { id: FIELD_MAP.ctwaclid, field_value: '' },
                    { id: FIELD_MAP.ad_name, field_value: data.last_touch?.utm_content || '' }
                ];

                const commonPayload = {
                    tags: ["lead flipping", "diagnóstico compra garantizada", "api_directa"],
                    source: "Terra Compra Garantizada",
                    customFields: trackingFields
                };

                let res = null;
                let action = 'POST';

                if (contactId) {
                    // UPDATE existente
                    res = await fetch(`https://services.leadconnectorhq.com/contacts/${contactId}`, {
                        method: 'PUT',
                        headers: ghlHeaders,
                        body: JSON.stringify({
                            ...commonPayload,
                            firstName: normFirstName,
                            lastName: normLastName
                        })
                    });
                    action = 'PUT';
                } else {
                    // CREATE nuevo
                    res = await fetch('https://services.leadconnectorhq.com/contacts/', {
                        method: 'POST',
                        headers: ghlHeaders,
                        body: JSON.stringify({
                            ...commonPayload,
                            locationId: GHL_LOCATION_ID,
                            firstName: normFirstName,
                            lastName: normLastName,
                            email: normEmail,
                            phone: '+' + normPhone
                        })
                    });
                    action = 'POST';
                }

                const bodyData = await res.text();
                let oppBodyData = null;

                if (res.ok) {
                    const jsonRes = JSON.parse(bodyData);
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

                return new Response(JSON.stringify({
                    success: true,
                    contactId: contactId,
                    action: action,
                    debug_ghl: { status: res.status, oppBody: oppBodyData }
                }), { headers: jsonHeaders, status: 200 });

            } catch (error) {
                return new Response(JSON.stringify({ success: false, contactId: null, msg: error.message }), { headers: jsonHeaders, status: 200 });
            }
        }

        // ==========================================
        // 2. POST /api/lead-update — Update single field on existing contact
        // ==========================================
        if (url.pathname === '/api/lead-update' && request.method === 'POST') {
            try {
                const data = await request.json();
                const { contactId, field, value } = data;

                if (!contactId || !field) {
                    return new Response(JSON.stringify({ success: false, msg: 'Missing contactId or field' }), { headers: jsonHeaders, status: 200 });
                }

                const fieldId = FIELD_MAP[field];
                if (!fieldId) {
                    return new Response(JSON.stringify({ success: false, msg: `Unknown field: ${field}` }), { headers: jsonHeaders, status: 200 });
                }

                const updatePayload = {
                    customFields: [
                        { id: fieldId, field_value: value || '' }
                    ]
                };

                const res = await fetch(`https://services.leadconnectorhq.com/contacts/${contactId}`, {
                    method: 'PUT',
                    headers: ghlHeaders,
                    body: JSON.stringify(updatePayload)
                });

                return new Response(JSON.stringify({
                    success: res.ok,
                    status: res.status
                }), { headers: jsonHeaders, status: 200 });

            } catch (error) {
                return new Response(JSON.stringify({ success: false, msg: error.message }), { headers: jsonHeaders, status: 200 });
            }
        }

        // ==========================================
        // 3. POST /api/lead-complete — Fire Meta CAPI Lead event
        // ==========================================
        if (url.pathname === '/api/lead-complete' && request.method === 'POST') {
            try {
                const data = await request.json();
                const clientIP = request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For') || '';
                const userAgent = request.headers.get('User-Agent') || '';

                // NORMALIZACIÓN PII
                const rawName = data.nombre || '';
                const rawPhone = data.telefono || '';
                const rawEmail = data.correo || '';

                const normEmail = rawEmail.toLowerCase().trim();
                const normPhoneRaw = rawPhone.replace(/\D/g, '');
                const normPhone = normPhoneRaw.length === 10 ? '52' + normPhoneRaw : normPhoneRaw;
                const normFirstName = rawName.split(' ')[0]?.toLowerCase().trim() || '';
                const normLastName = rawName.split(' ').slice(1).join(' ')?.toLowerCase().trim() || '';

                // HASHEO SHA-256
                const [hashedEmail, hashedPhone, hashedFirstName, hashedLastName] = await Promise.all([
                    sha256(normEmail), sha256(normPhone), sha256(normFirstName), sha256(normLastName)
                ]);

                // CAPI PAYLOAD
                const capiPayload = {
                    data: [{
                        event_name: 'Lead',
                        event_time: Math.floor(Date.now() / 1000),
                        action_source: 'website',
                        event_source_url: data.source_url || 'https://compragarantizadaterra.com',
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

                if (META_TEST_CODE) {
                    capiPayload.test_event_code = META_TEST_CODE;
                }

                console.log("--> META CAPI PAYLOAD:", JSON.stringify(capiPayload));

                // Fire Meta CAPI (skip for "traspaso informal" to avoid contamination)
                let metaResult = { status: 'Skipped' };
                if (data.situacion !== 'Alguien más vive ahí (traspaso informal)') {
                    try {
                        const metaRes = await fetch(`https://graph.facebook.com/v19.0/${META_DATASET_ID}/events?access_token=${META_ACCESS_TOKEN}`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify(capiPayload)
                        });
                        metaResult = { status: metaRes.status, body: await metaRes.text() };
                    } catch (e) {
                        metaResult = { error: e.message };
                    }
                }

                return new Response(JSON.stringify({
                    success: true,
                    event_id: data.event_id,
                    debug_meta: metaResult
                }), { headers: jsonHeaders, status: 200 });

            } catch (error) {
                return new Response(JSON.stringify({ success: false, msg: error.message }), { headers: jsonHeaders, status: 200 });
            }
        }

        // ==========================================
        // 4. HTML TRANSFORMATION ZONE (GTM + WhatsApp Rewrite)
        // ==========================================
        const GTM_ID = env.GTM_ID || null;
        const WHATSAPP_NUMBER = env.WHATSAPP_NUMBER || '524446687573';

        // Now includes gracias_fuera.html in the rewriter routes
        if (url.pathname === '/' || url.pathname === '/index.html' || url.pathname === '/gracias.html' || url.pathname === '/gracias_fuera.html') {
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
