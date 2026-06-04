// P2 message handler.
//
// Identification is still deterministic — Claude has no business asking for
// the phone or guessing the name. Once we know who the patient is, we hand
// the rest of the conversation to Claude (with MCP tools) for triage and
// booking.
//
// IDEMPOTENCY CONTRACT
// --------------------
// Meta retries the webhook if we don't return 200 in 5s. Each retry carries
// the SAME wa_message_id. We dedupe at the database level: the inbound
// logMessage() call hits a UNIQUE INDEX on (wa_message_id) WHERE NOT NULL.
// A duplicate insert raises 23505 → logMessage returns {duplicate: true} →
// we short-circuit and send nothing. So Meta retries can't double-message
// the patient even if our background work timed out before completing.
//
// SLOW-PATH ACK
// -------------
// The identified-patient branch goes through Claude + MCP which can take
// 10-60s. We send a brief "estoy revisando" ack *before* the Claude call so
// the patient sees something within ~1s of their message. This now runs
// inside the Node worker (api/process.mjs) rather than Edge waitUntil, so
// the reply path survives to completion — the ack is still worth keeping
// because a 30-60s silent gap reads as "the bot is broken" to a patient.

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

const ACK_TEXT = 'Un momento, déjame revisar... 🩺';

/** Quick "is this plausibly a person's name?" check — Spanish-friendly. */
function looksLikeName(s) {
    const t = s.trim();
    if (t.length < 2 || t.length > 60) return false;
    return /^[\p{L}][\p{L}\s'\-]{1,59}$/u.test(t);
}

/**
 * Send a short "wait, processing" ack to the patient. Best-effort —
 * failures here must NOT kill the main flow (we'd rather risk a silent
 * ack than lose the real reply). Logged with meta.kind='ack' so it can
 * be filtered out of Claude's view of the conversation history.
 */
async function sendAckBestEffort(from, conversationId) {
    try {
        await sendText(from, ACK_TEXT);
        await logMessage({
            conversationId,
            direction: 'out',
            content: ACK_TEXT,
            meta: { kind: 'ack' },
        });
    } catch (e) {
        console.error('[wa] ack failed', e && e.message ? e.message : e);
    }
}

export async function handleInbound({ from, text, waMessageId }) {
    const conv = await getOrCreateConversation(from);

    // ── Dedup ────────────────────────────────────────────────────────────
    // wa_message_id unique index rejects Meta retries. Even if our slow
    // path crashed mid-flight, a retry won't fire a second ack/reply.
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
        // Fast path — interpret this turn as the patient's name. No ack needed.
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
            patient = await findPatientByPhone(from);
        } else {
            patient = await findPatientByPhone(from);
            if (patient) nextPatch.patient_id = patient.id;
        }

        if (!patient) {
            // Fast path — brand new patient, start identification. No ack.
            reply = 'Hola 👋, soy el asistente de la Clínica. Veo que es tu primera vez por aquí. ¿Cómo te llamas?';
            nextState = 'identifying';
        } else {
            // ── Slow path: Claude + MCP ────────────────────────────────────
            // Send the ack BEFORE the Claude call so the patient sees
            // activity even if the isolate dies before the real reply lands.
            await sendAckBestEffort(from, conv.id);

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
