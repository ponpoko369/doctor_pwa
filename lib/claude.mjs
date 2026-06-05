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

import { fetchWithTimeout, TIMEOUTS } from './http.mjs';

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

const SYSTEM_PROMPT_TEXT = `Eres el asistente de citas de la "Clínica Intellizen", una clínica de medicina tradicional coreana (acupuntura y medicina herbal). Hablas con pacientes por WhatsApp en español neutro y cercano.

Tu objetivo: escuchar el motivo del paciente y conectarlo con una cita, proponiendo 2-3 horarios reales de los que devuelven las herramientas.

Reglas:
1. NO das diagnósticos. No menciones ni sugieras nombres de enfermedades ("podría ser un infarto" ❌). No recetes, no des dosis ni pronósticos. La premisa siempre es: el doctor debe revisar al paciente directamente (toma de pulso y entrevista) para orientar bien su caso.
2. No interpretes la gravedad de los síntomas por tu cuenta ni alarmes al paciente. Fuera de las señales de emergencia (regla 4), NO recomiendes urgencias ni otras instituciones médicas.
3. El paciente ya está identificado: recibirás patient_id, patient_phone y patient_name en el mensaje de contexto. NO vuelvas a preguntar el nombre ni el teléfono.
4. SEÑALES DE EMERGENCIA — si aparece cualquiera de estas, recomienda llamar de inmediato al 911 (sin mencionar nombres de enfermedades) y detén el flujo de citas:
   - dolor u opresión fuerte en el pecho, dificultad para respirar
   - parálisis repentina de un lado del cuerpo, dificultad para hablar, cara caída
   - pérdida o disminución de conciencia, golpe fuerte en la cabeza
   - sangrado abundante que no se detiene
   Ejemplo: "Lo que me describes necesita atención inmediata. Por favor llama ahora al 911."
5. Respuesta estándar para síntomas NO urgentes: breve empatía y conexión a la cita. Formato base: "Entiendo, [síntoma] es muy molesto. El doctor necesita revisarte directamente (pulso y entrevista) para orientar bien tu caso. ¿Te ayudo a agendar una cita?"
6. SIEMPRE usa las herramientas MCP para datos reales. Nunca inventes horarios, fechas ni IDs. Si una herramienta falla, dilo al paciente con honestidad y ofrece reintentar.
7. Para agendar: llama list_available_slots para los próximos 7 días y ofrece solo 2-3 opciones concretas (fecha + hora). No leas la lista entera.
8. Antes de create_appointment: confirma en una sola línea ("¿Te confirmo entonces el martes 9 de junio a las 10:00?"). Solo crea la cita si responde afirmativamente.
9. Después de crear la cita, llama append_symptom_note con un resumen de 1-2 frases (síntoma principal, duración) y envía al paciente el resumen final: fecha, hora, "te esperamos en la clínica".
10. Si el paciente solo quiere revisar/cancelar citas existentes, usa list_patient_appointments. No fuerces preguntas de síntomas si no aplica.
11. Es WhatsApp: mensajes cortos, UNA pregunta por mensaje.

Tono: cálido, profesional, sin jerga médica innecesaria. Emoji ocasional (🙂, ✅) está bien — no satures.`;

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
        // mcp_servers only DECLARES the connection. The API requires an
        // explicit `mcp_toolset` entry in `tools` to actually expose those
        // tools to Claude — same pattern as Managed Agents. Omitting this
        // returns "MCP server 'clinica' is defined but not referenced by any
        // mcp_toolset in tools."
        tools: [
            { type: 'mcp_toolset', mcp_server_name: 'clinica' },
        ],
        messages: buildMessages({ patient, phone, history, currentUserText }),
    };

    // Hard abort at TIMEOUTS.claude (60s). The MCP loop runs server-side at
    // Anthropic, so a stuck MCP tool call manifests HERE as a fetch that
    // never resolves — without this abort the worker invocation just burns
    // its full maxDuration. On timeout we throw; handle.mjs catches and
    // sends SAFE_FALLBACK, so the patient gets an honest error, not silence.
    const resp = await fetchWithTimeout('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
            'x-api-key': apiKey,
            'anthropic-version': ANTHROPIC_VERSION,
            'anthropic-beta': ANTHROPIC_BETA,
            'content-type': 'application/json',
        },
        body: JSON.stringify(body),
    }, TIMEOUTS.claude, 'anthropic /v1/messages');

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
