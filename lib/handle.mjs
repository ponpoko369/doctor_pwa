// P2 message handler.
//
// Identification is still deterministic — Claude has no business asking for
// the phone or guessing the name. Once we know who the patient is, we hand
// the rest of the conversation to Claude (with MCP tools) for triage and
// booking.
//
// State machine collapses to two effective modes:
//   identifying → asking name, registering (deterministic)
//   anything else → Claude is in charge (it manages its own micro-states)

import {
    findPatientByPhone,
    registerPatient,
    getOrCreateConversation,
    updateConversation,
    logMessage,
} from './db.mjs';
import { sendText } from './wa.mjs';
import { ask, loadHistory } from './claude.mjs';

const SAFE_FALLBACK =
    'Disculpa, tuve un problema técnico. ¿Puedes intentar de nuevo en un momento?';

/** Quick "is this plausibly a person's name?" check — Spanish-friendly. */
function looksLikeName(s) {
    const t = s.trim();
    if (t.length < 2 || t.length > 60) return false;
    return /^[\p{L}][\p{L}\s'\-]{1,59}$/u.test(t);
}

export async function handleInbound({ from, text, waMessageId }) {
    const conv = await getOrCreateConversation(from);

    // Idempotency: Meta retries → unique index on wa_message_id rejects the
    // duplicate insert and we short-circuit before sending a second reply.
    const inMsg = await logMessage({
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
    let patient = null;

    if (conv.state === 'identifying') {
        // We previously asked "¿Cómo te llamas?" — interpret this turn as the name.
        const name = text.trim();
        if (!looksLikeName(name)) {
            reply = 'Disculpa, no entendí tu nombre. ¿Me lo escribes solo con letras? Por ejemplo: "María López".';
        } else {
            patient = await registerPatient(from, name);
            nextPatch.patient_id = patient.id;
            nextState = 'triage';
            reply = `Mucho gusto, ${name} 👋. Cuéntame qué te trae por aquí — ¿algún síntoma o quieres agendar una cita?`;
        }
    } else {
        // Resolve the patient. Conversation may have it cached; otherwise look up.
        if (conv.patient_id) {
            // Patient is linked — fetch fresh in case the row updated.
            patient = await findPatientByPhone(from);
        } else {
            patient = await findPatientByPhone(from);
            if (patient) nextPatch.patient_id = patient.id;
        }

        if (!patient) {
            // Brand new — start identification.
            reply = 'Hola 👋, soy el asistente de la Clínica. Veo que es tu primera vez por aquí. ¿Cómo te llamas?';
            nextState = 'identifying';
        } else {
            // ── Identified path: Claude takes over ────────────────────────────
            try {
                const history = await loadHistory(conv.id, inMsg.id);
                reply = await ask({
                    patient,
                    phone: from,
                    history,
                    currentUserText: text,
                });
                if (nextState === 'idle' || !nextState) nextState = 'triage';
            } catch (e) {
                // Logged so it shows up in Vercel Functions logs; Meta gets a graceful reply.
                console.error('[wa] claude error', e && e.message ? e.message : e);
                reply = SAFE_FALLBACK;
            }
        }
    }

    await sendText(from, reply);
    await logMessage({
        conversationId: conv.id,
        direction: 'out',
        content: reply,
    });
    if (nextState !== conv.state || Object.keys(nextPatch).length) {
        await updateConversation(conv.id, { state: nextState, ...nextPatch });
    }
}
