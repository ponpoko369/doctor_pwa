// Supabase REST helpers — no SDK dependency, just fetch.
// Service role key bypasses RLS, so this MUST stay server-side only.
//
// All functions throw on HTTP error. Callers handle.

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://cojzdjajwrzzyqxzljgq.supabase.co';

function key() {
    // Same BOM defense as translate.js — Vercel CLI on Windows can prefix
    // env values with U+FEFF when piped through PowerShell.
    const raw = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
    const k = raw.replace(/^﻿/, '').trim();
    if (!k) throw new Error('SUPABASE_SERVICE_ROLE_KEY not set');
    return k;
}

function headers(extra = {}) {
    const k = key();
    return {
        apikey: k,
        Authorization: `Bearer ${k}`,
        'Content-Type': 'application/json',
        ...extra,
    };
}

async function rest(path, init = {}) {
    const resp = await fetch(`${SUPABASE_URL}/rest/v1${path}`, init);
    if (!resp.ok) {
        const body = await resp.text();
        throw new Error(`Supabase ${resp.status} ${path}: ${body.slice(0, 300)}`);
    }
    // 204 No Content → return null
    if (resp.status === 204) return null;
    return resp.json();
}

// ── patients ────────────────────────────────────────────────────────────────

async function findPatientByPhone(phone) {
    const rows = await rest(
        `/patients?phone=eq.${encodeURIComponent(phone)}&select=*&limit=1`,
        { headers: headers() },
    );
    return rows[0] || null;
}

async function registerPatient(phone, name) {
    const rows = await rest('/patients', {
        method: 'POST',
        headers: headers({ Prefer: 'return=representation' }),
        body: JSON.stringify({ phone, name }),
    });
    return rows[0];
}

// ── conversations ───────────────────────────────────────────────────────────

async function getOrCreateConversation(phone) {
    const existing = await rest(
        `/conversations?patient_phone=eq.${encodeURIComponent(phone)}&select=*&limit=1`,
        { headers: headers() },
    );
    if (existing[0]) return existing[0];
    const created = await rest('/conversations', {
        method: 'POST',
        headers: headers({ Prefer: 'return=representation' }),
        body: JSON.stringify({ patient_phone: phone }),
    });
    return created[0];
}

async function updateConversation(id, patch) {
    const rows = await rest(`/conversations?id=eq.${id}`, {
        method: 'PATCH',
        headers: headers({ Prefer: 'return=representation' }),
        body: JSON.stringify({ ...patch, last_message_at: new Date().toISOString() }),
    });
    return rows[0];
}

// ── messages ────────────────────────────────────────────────────────────────

/**
 * Insert an inbound or outbound message. wa_message_id is unique when present;
 * a duplicate insert returns null (caller treats as "already processed").
 */
async function logMessage({ conversationId, direction, content, waMessageId, meta }) {
    try {
        const rows = await rest('/messages', {
            method: 'POST',
            headers: headers({ Prefer: 'return=representation' }),
            body: JSON.stringify({
                conversation_id: conversationId,
                direction,
                content,
                wa_message_id: waMessageId || null,
                meta: meta || {},
            }),
        });
        return rows[0];
    } catch (e) {
        // 23505 = unique_violation on wa_message_id — Meta retried, we already
        // processed it. Surface a sentinel so callers can short-circuit.
        if (String(e.message).includes('23505')) return { duplicate: true };
        throw e;
    }
}

module.exports = {
    findPatientByPhone,
    registerPatient,
    getOrCreateConversation,
    updateConversation,
    logMessage,
};
