// P1 message handler — deterministic state machine, no Claude yet.
//
// State transitions:
//   idle         → if patient exists: greet, stay idle (P1 stops here)
//                  if not:           ask name,    go to 'identifying'
//   identifying  → treat message as name, register, return to idle
//
// triage/booking states are wired in P2 once Claude+MCP are in place.

const db = require('./db');
const wa = require('./wa');

/** Quick "is this plausibly a person's name?" check — Spanish-friendly. */
function looksLikeName(s) {
    const t = s.trim();
    if (t.length < 2 || t.length > 60) return false;
    // letters (incl. accented), spaces, hyphens, apostrophes
    return /^[\p{L}][\p{L}\s'\-]{1,59}$/u.test(t);
}

async function handleInbound({ from, text, waMessageId }) {
    const conv = await db.getOrCreateConversation(from);

    // Idempotency: if Meta retries, the unique index on wa_message_id rejects
    // the duplicate insert and we exit before sending a second reply.
    const inMsg = await db.logMessage({
        conversationId: conv.id,
        direction: 'in',
        content: text,
        waMessageId,
    });
    if (inMsg && inMsg.duplicate) {
        console.log(`[wa] dup ${waMessageId} — skip`);
        return;
    }

    let reply;
    let nextState = conv.state;
    let nextPatch = {};

    if (conv.state === 'identifying') {
        // We previously asked "¿Cómo te llamas?" — interpret this turn as the name.
        const name = text.trim();
        if (!looksLikeName(name)) {
            reply = 'Disculpa, no entendí tu nombre. ¿Me lo escribes solo con letras? Por ejemplo: "María López".';
        } else {
            const patient = await db.registerPatient(from, name);
            nextPatch.patient_id = patient.id;
            nextState = 'idle';
            reply = `Mucho gusto, ${name} 👋. Ya estás registrado/a. Cuéntame qué te trae por aquí — ¿algún síntoma o quieres agendar una cita?`;
        }
    } else {
        // Default flow: identify or greet.
        const patient = conv.patient_id
            ? null  // already linked
            : await db.findPatientByPhone(from);

        if (conv.patient_id || patient) {
            // Known patient — friendly hello. (Triage handled by Claude in P2.)
            const name = patient ? patient.name : null;
            if (patient && !conv.patient_id) nextPatch.patient_id = patient.id;
            reply = name
                ? `Hola ${name} 👋. Soy el asistente de la clínica. ¿En qué te puedo ayudar hoy? (puedes contarme un síntoma o pedir una cita)`
                : 'Hola 👋. Soy el asistente de la clínica. ¿En qué te puedo ayudar hoy?';
            nextState = 'idle';
        } else {
            // New patient — ask the name.
            reply = 'Hola 👋, soy el asistente de la Clínica. Veo que es tu primera vez por aquí. ¿Cómo te llamas?';
            nextState = 'identifying';
        }
    }

    await wa.sendText(from, reply);
    await db.logMessage({
        conversationId: conv.id,
        direction: 'out',
        content: reply,
    });
    if (nextState !== conv.state || Object.keys(nextPatch).length) {
        await db.updateConversation(conv.id, { state: nextState, ...nextPatch });
    }
}

module.exports = { handleInbound };
