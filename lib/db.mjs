// Supabase REST helpers — Edge Runtime (ESM, global fetch).
// Service role key bypasses RLS, so this MUST stay server-side only.
//
// All functions throw on HTTP error. Callers handle.

import { fetchWithTimeout, TIMEOUTS } from './http.mjs';

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://cojzdjajwrzzyqxzljgq.supabase.co';

function key() {
    // BOM defense — Vercel CLI on Windows can prefix env values with U+FEFF
    // when piped through PowerShell.
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
    // Bounded: a stalled Supabase call must throw, not hang the invocation.
    const resp = await fetchWithTimeout(
        `${SUPABASE_URL}/rest/v1${path}`, init, TIMEOUTS.supabase, `supabase ${path.split('?')[0]}`,
    );
    if (!resp.ok) {
        const body = await resp.text();
        throw new Error(`Supabase ${resp.status} ${path}: ${body.slice(0, 300)}`);
    }
    if (resp.status === 204) return null;
    return resp.json();
}

// ── patients ────────────────────────────────────────────────────────────────

export async function findPatientByPhone(phone) {
    const rows = await rest(
        `/patients?phone=eq.${encodeURIComponent(phone)}&select=*&limit=1`,
        { headers: headers() },
    );
    return rows[0] || null;
}

export async function registerPatient(phone, name) {
    const rows = await rest('/patients', {
        method: 'POST',
        headers: headers({ Prefer: 'return=representation' }),
        body: JSON.stringify({ phone, name }),
    });
    return rows[0];
}

// ── conversations ───────────────────────────────────────────────────────────

export async function getOrCreateConversation(phone) {
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

export async function updateConversation(id, patch) {
    const rows = await rest(`/conversations?id=eq.${id}`, {
        method: 'PATCH',
        headers: headers({ Prefer: 'return=representation' }),
        body: JSON.stringify({ ...patch, last_message_at: new Date().toISOString() }),
    });
    return rows[0];
}

// ── appointments ────────────────────────────────────────────────────────────

// Hardcoded clinic hours — matches the desktop app (patient_flow.dart) and
// the doctor_pwa dashboard. Slots are hourly, 09:00..20:00 inclusive (12 slots).
// Per-doctor blocking lands in P3 when the doctors table arrives.
const SLOT_HOURS = [9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20];

function fmtDate(d) {
    // YYYY-MM-DD in local time. Supabase stores `date` as DATE, no TZ.
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}

function fmtTime(h) {
    return `${String(h).padStart(2, '0')}:00`;
}

/**
 * Generate the universe of (date, time) pairs in [dateFrom, dateTo] inclusive,
 * minus any already booked. Both bounds are 'YYYY-MM-DD' strings.
 *
 * Hard cap at 14 days to keep payloads sane — Claude doesn't need a month of
 * slots to suggest 2-3 options.
 */
export async function listAvailableSlots(dateFromStr, dateToStr) {
    const from = new Date(`${dateFromStr}T00:00:00`);
    const to = new Date(`${dateToStr}T00:00:00`);
    if (isNaN(from) || isNaN(to) || from > to) {
        throw new Error('invalid date range');
    }
    const dayCount = Math.min(
        14,
        Math.floor((to - from) / 86400000) + 1,
    );

    // Pull all bookings in range in one query (much cheaper than per-day).
    const bookings = await rest(
        `/appointments?date=gte.${dateFromStr}&date=lte.${dateToStr}`
        + `&status=eq.confirmed&select=date,time`,
        { headers: headers() },
    );
    const taken = new Set(bookings.map((b) => `${b.date}T${b.time.slice(0, 5)}`));

    const slots = [];
    for (let i = 0; i < dayCount; i++) {
        const d = new Date(from);
        d.setDate(d.getDate() + i);
        const dateStr = fmtDate(d);
        for (const h of SLOT_HOURS) {
            const timeStr = fmtTime(h);
            if (!taken.has(`${dateStr}T${timeStr}`)) {
                slots.push({ date: dateStr, time: timeStr });
            }
        }
    }
    return slots;
}

export async function createAppointment(patientId, date, time) {
    // Mirrors the desktop app's SupabaseRepo.createAppointment shape so the
    // booking shows up identically in clinica_app and doctor_pwa.
    const rows = await rest('/appointments', {
        method: 'POST',
        headers: headers({ Prefer: 'return=representation' }),
        body: JSON.stringify({
            patient_id: patientId,
            date,
            time,
            status: 'confirmed',
        }),
    });
    return rows[0];
}

export async function listPatientAppointments(patientId, onlyUpcoming = true) {
    const today = fmtDate(new Date());
    const filter = onlyUpcoming
        ? `&date=gte.${today}`
        : '';
    const rows = await rest(
        `/appointments?patient_id=eq.${patientId}&status=eq.confirmed`
        + `${filter}&select=*&order=date.asc,time.asc`,
        { headers: headers() },
    );
    return rows;
}

/**
 * Append a triage note to the patient's cumulative `symptoms` column. This
 * matches the existing desktop-app pattern (voice transcripts get appended
 * to the same column with a timestamp prefix).
 */
export async function appendSymptomNote(patientId, note) {
    const rows = await rest(
        `/patients?id=eq.${patientId}&select=symptoms`,
        { headers: headers() },
    );
    const prev = (rows[0] && rows[0].symptoms) || '';
    const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
    const next = prev
        ? `${prev}\n[${stamp} WA] ${note}`
        : `[${stamp} WA] ${note}`;
    await rest(`/patients?id=eq.${patientId}`, {
        method: 'PATCH',
        headers: headers(),
        body: JSON.stringify({ symptoms: next }),
    });
    return { ok: true };
}

// ── messages ────────────────────────────────────────────────────────────────

/**
 * Insert an inbound or outbound message. wa_message_id is unique when present;
 * a duplicate insert (Meta retry) is surfaced as { duplicate: true } so the
 * caller can short-circuit instead of sending a second reply.
 */
/**
 * Last N messages for a conversation in chronological order, excluding the
 * one with `excludeMsgId` (the just-inserted inbound, so we can pass it as
 * the current turn separately).
 *
 * Filters out transport-layer ack messages (meta.kind='ack') — those are
 * "estoy revisando" placeholders that go to the user but shouldn't appear
 * in Claude's view of the conversation. We over-fetch by ~10 to keep the
 * limit honest after filtering.
 */
export async function listConversationMessages(conversationId, excludeMsgId, limit = 30) {
    const exclude = excludeMsgId ? `&id=neq.${excludeMsgId}` : '';
    const rows = await rest(
        `/messages?conversation_id=eq.${conversationId}${exclude}`
        + `&select=direction,content,created_at,meta`
        + `&order=created_at.desc&limit=${limit + 10}`,
        { headers: headers() },
    );
    const filtered = rows.filter((m) => !(m.meta && m.meta.kind === 'ack'));
    // Pulled newest-first; take top N then reverse to chronological replay.
    return filtered.slice(0, limit).reverse();
}

export async function logMessage({ conversationId, direction, content, waMessageId, meta }) {
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
        // processed it. Surface a sentinel for callers.
        if (String(e.message).includes('23505')) return { duplicate: true };
        throw e;
    }
}
