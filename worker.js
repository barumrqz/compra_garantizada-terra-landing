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

                const metaReq = fetch(`https://graph.facebook.com/v19.0/${META_DATASET_ID}/events?access_token=${META_ACCESS_TOKEN}`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(capiPayload)
                });

                // GHL PAYLOAD (API V2: Contacts)
                // Usando upsert para actualizar si ya existe, buscando por email/teléfono
                const ghlPayload = {
                    locationId: GHL_LOCATION_ID,
                    firstName: normFirstName,
                    lastName: normLastName,
                    email: normEmail,
                    phone: '+' + normPhone, // GHL prefiere el formato internacional estandarizado
                    tags: ["landing_evaluacion", "api_directa"],
                    source: "Terra Compra Garantizada",
                    customFields: [
                        // Aquí mapeas los Custom Fields Creados en tu Subcuenta
                        // Debes conseguir el ID del campo en Settings > Custom Fields
                        {
                            id: env.GHL_FIELD_SITUACION || 'ZqhjRk3qpd6h72qrGHTJ',
                            field_value: data.situacion || ''
                        },
                        {
                            id: env.GHL_FIELD_ADEUDO || 'rSdAto1Gs3169a5Xoxm2',
                            field_value: data.adeudo || ''
                        },
                        {
                            id: env.GHL_FIELD_UBICACION || 'pXWbHc17gFWLnPwh25ff',
                            field_value: data.ubicacion || ''
                        },
                        {
                            id: env.GHL_FIELD_URGENCIA || 'zZ6Yb7X4k3enahD3mgUO',
                            field_value: data.urgencia || ''
                        },
                        {
                            id: env.GHL_FIELD_UTM_JOURNEY || 'OI507tXb9GeiGgN3FTID',
                            // Convertimos el JSON extenso a texto para que sea visible en la ficha de GHL
                            field_value: JSON.stringify({
                                first_click: data.first_touch || {},
                                last_click: data.last_touch || {},
                                all_touches: data.ad_journey || []
                            })
                        }
                    ]
                };

                const ghlHeaders = {
                    'Authorization': `Bearer ${GHL_ACCESS_TOKEN}`,
                    'Version': '2021-07-28',
                    'Content-Type': 'application/json',
                    'Accept': 'application/json'
                };

                const ghlPromise = async () => {
                    const res = await fetch('https://services.leadconnectorhq.com/contacts/', {
                        method: 'POST',
                        headers: ghlHeaders,
                        body: JSON.stringify(ghlPayload)
                    });

                    if (res.ok) {
                        const jsonRes = await res.json();
                        const contactId = jsonRes.contact?.id;

                        // Crear Oportunidad en Pipeline "Terra Interés Social" > "Nuevo Lead"
                        if (contactId) {
                            const oppPayload = {
                                locationId: GHL_LOCATION_ID,
                                contactId: contactId,
                                pipelineId: env.GHL_PIPELINE_ID || 'Yd2KKgmW67huLnfz1EFT',
                                pipelineStageId: env.GHL_STAGE_ID || '6f63fcb8-e175-4a3e-a642-10104e7f019a',
                                name: `${rawName || 'Lead'} - Terra Landing`,
                                status: "open"
                            };

                            await fetch('https://services.leadconnectorhq.com/opportunities/', {
                                method: 'POST',
                                headers: ghlHeaders,
                                body: JSON.stringify(oppPayload)
                            });
                        }
                    }
                };

                // PARALLEL EXECUTION (Fail-safe)
                await Promise.allSettled([metaReq, ghlPromise()]);

                return new Response(JSON.stringify({ success: true, event_id: data.event_id }), { headers, status: 200 });

            } catch (error) {
                // Retornar 200 incluso si hay crash interno para que redirija a gracias.html
                return new Response(JSON.stringify({ success: false, msg: error.message }), { headers, status: 200 });
            }
        }

        // ==========================================
        // 2. ZONA DE RUTEO FRONTEND (index y gracias)
        // ==========================================
        // Si el usuario navegó a la raíz o a /gracias.html, Cloudflare sirve el archivo HTML estático
        return env.ASSETS.fetch(request);
    }
};
