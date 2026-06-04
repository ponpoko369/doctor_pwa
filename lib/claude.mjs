// Claude wrapper for the WhatsApp triage flow.
//
// Strategy:
//   - Anthropic Messages API with `mcp_servers` connector (beta) → Anthropic
//     calls our /api/mcp endpoint server-side. Our webhook never sees the
//     tool-use loop; we just get the final assistant text.
//   - Sonnet 4.6 + adaptive thinking (no budget_tokens — deprecated on 4.6).
//   - Prompt caching on the system prompt: it's stable per deploy, and we hit
//     this code path once per inbound WhatsApp message — the cache pays for
//     itself by the second turn of any conversation.

const MODEL = 'claude-sonnet-4-6';
const ANTHROPIC_VERSION = '2023-06-01';
const ANTHROPIC_BETA = 'mcp-client-2025-11-20';
const MAX_TOKENS = 1024;        // WhatsApp messages are short; cap output cost.

function env(name) {
    const raw = process.env[name] || '';
    const v = raw.replace(/^﻿/, '').trim();
    if (!v) throw new Error(`${name} not set`);
    return v;
}

const SYSTEM_PROMPT_TEXT = `Eres "Asistente de Citas" de la Clínica. Hablas con un paciente por WhatsApp en español neutro y cercano.

Tu objetivo es: hacer un triage breve, proponer 2-3 horarios concretos de la lista que devuelve la herramienta, y confirmar la cita.

Reglas estrictas:
1. SIEMPRE usa las herramientas MCP para datos reales. Nunca inventes horarios, médicos ni IDs. Si una herramienta falla, dilo al paciente con honestidad y ofrece reintentar.
2. El paciente ya está identificado: recibirás patient_id y patient_phone en el mensaje de contexto. NO vuelvas a preguntar el nombre ni el teléfono.
3. Triage breve: pregunta máximo 3-4 cosas — síntoma principal, duración, intensidad (1-10), y banderas rojas (fiebre alta, dolor torácico, dificultad para respirar, sangrado abundante, pérdida de conciencia).
4. UNA pregunta por mensaje. WhatsApp no es un formulario; manda mensajes cortos.
5. BANDERA ROJA detectada (cualquiera de las anteriores muy severa) → instruye llamar inmediatamente al 911/Cruz Roja y NO agendes cita. Salida inmediata del flujo de booking.
6. Cuando tengas suficiente triage, llama list_available_slots para los próximos 7 días, ofrece 2 o 3 opciones concretas con fecha y hora, y espera la elección del paciente. No leas la lista entera.
7. Antes de create_appointment: confirma con el paciente la fecha+hora elegida en una sola línea ("¿Te confirmo entonces el martes 9 de junio a las 10:00?"). Solo crea la cita si responde afirmativamente.
8. Después de crear la cita, llama append_symptom_note con un resumen clínico de 1-2 frases (motivo, duración, intensidad) y envía al paciente un resumen final: fecha, hora, motivo, dirección breve ("te esperamos en la clínica").
9. Si el paciente solo quiere revisar/cancelar citas existentes, usa list_patient_appointments. No fuerces el flujo de triage si no aplica.
10. No diagnostiques, no recetes, no des dosis. Si insiste, recuerda que el médico verá el motivo en la consulta.

Tono: cálido, profesional, sin jerga médica innecesaria. Emoji ocasional (👋, ✅) está bien — no satures.`;

/**
 * Build the messages array Anthropic expects. We prepend a per-conversation
 * "context block" as the first user turn so the patient_id, phone, and today's
 * date are always available without polluting the system prompt (which we
 * cache). The history from Supabase is in chronological order already.
 */
function buildMessages({ patient, phone, history, currentUserText }) {
    const today = new Date().toISOString().slice(0, 10);
    const contextBlock = [
        `[CONTEXTO]`,
        `patient_id: ${patient.id}`,
        `patient_phone: ${phone}`,
        `patient_name: ${patient.name}`,
        `today: ${today}`,
    ].join('\n');

    // First synthetic user turn carries context. The model never has to
    // ask for IDs — they're right here.
    const out = [
        { role: 'user', content: contextBlock },
        { role: 'assistant', content: 'Entendido. Estoy listo para ayudar a este paciente.' },
    ];

    for (const m of history) {
        out.push({
            role: m.direction === 'in' ? 'user' : 'assistant',
            content: m.content,
        });
    }
    // Current turn last
    out.push({ role: 'user', content: currentUserText });
    return out;
}

/**
 * Call Claude with our MCP server attached. Returns the assistant's final
 * text response (Anthropic runs the tool-call loop server-side and only
 * returns the final answer).
 */
export async function ask({ patient, phone, history, currentUserText }) {
    const apiKey = env('ANTHROPIC_API_KEY');
    const mcpUrl = env('CLINICA_MCP_URL');           // e.g. https://doctorpwa.vercel.app/api/mcp
    const mcpToken = env('MCP_AUTH_TOKEN');

    const body = {
        model: MODEL,
        max_tokens: MAX_TOKENS,
        thinking: { type: 'adaptive' },
        system: [
            {
                type: 'text',
                text: SYSTEM_PROMPT_TEXT,
                // Cached: same bytes every webhook call, breakpoint at last system
                // block also covers the MCP tool list since tools render before
                // system in the prefix.
                cache_control: { type: 'ephemeral' },
            },
        ],
        mcp_servers: [
            {
                type: 'url',
                name: 'clinica',
                url: mcpUrl,
                authorization_token: mcpToken,
            },
        ],
        messages: buildMessages({ patient, phone, history, currentUserText }),
    };

    const resp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
            'x-api-key': apiKey,
            'anthropic-version': ANTHROPIC_VERSION,
            'anthropic-beta': ANTHROPIC_BETA,
            'content-type': 'application/json',
        },
        body: JSON.stringify(body),
    });

    if (!resp.ok) {
        const errBody = await resp.text();
        throw new Error(`Anthropic ${resp.status}: ${errBody.slice(0, 400)}`);
    }
    const data = await resp.json();

    // Adaptive thinking blocks come first with no visible text — strip them.
    // mcp_tool_use / mcp_tool_result blocks also appear here when tools fired;
    // those have no `.text`. We want only assistant TextBlocks.
    const text = (data.content || [])
        .filter((c) => c.type === 'text')
        .map((c) => c.text)
        .join('')
        .trim();

    if (!text) {
        // Fallback so we never leave the patient hanging.
        return 'Disculpa, tuve un problema técnico al procesar tu mensaje. ¿Puedes repetirlo?';
    }
    return text;
}

export { listConversationMessages as loadHistory } from './db.mjs';
