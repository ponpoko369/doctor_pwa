// Meta WhatsApp Cloud API helpers — Edge Runtime (ESM, Web Crypto).
//   - verifySignature: HMAC-SHA256 over the raw POST body using WA_APP_SECRET.
//   - sendText:        POST a free-form text message to a wa_id.
//   - parseInbound:    extract { from, text, waMessageId } from Meta's payload.
//
// All values from process.env — never hardcoded.
// Edge runtime gives us WebCrypto + fetch globals, no Node 'crypto' module.

import { fetchWithTimeout, TIMEOUTS } from './http.mjs';

const GRAPH_VERSION = 'v20.0';

function env(name) {
    const raw = process.env[name] || '';
    // Strip BOM (U+FEFF) that Windows PowerShell can prepend, then trim.
    const v = raw.replace(/^﻿/, '').trim();
    if (!v) throw new Error(`${name} not set`);
    return v;
}

const enc = new TextEncoder();

async function hmacSha256Hex(secret, message) {
    const key = await crypto.subtle.importKey(
        'raw',
        enc.encode(secret),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign'],
    );
    const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
    const bytes = new Uint8Array(sig);
    let hex = '';
    for (let i = 0; i < bytes.length; i++) {
        hex += bytes[i].toString(16).padStart(2, '0');
    }
    return hex;
}

/**
 * Meta signs the raw POST body with HMAC-SHA256 using your App Secret and
 * sends it as `x-hub-signature-256: sha256=<hex>`. Reject anything that
 * doesn't match — otherwise anyone on the internet can post to our webhook.
 */
export async function verifySignature(rawBody, signatureHeader) {
    if (!signatureHeader || typeof signatureHeader !== 'string') return false;
    const expected = signatureHeader.startsWith('sha256=')
        ? signatureHeader.slice(7)
        : signatureHeader;

    const secret = env('WA_APP_SECRET');
    const computed = await hmacSha256Hex(secret, rawBody);

    // Constant-time-ish hex compare. SubtleCrypto.verify could do this with
    // raw bytes but we already have hex on both sides; an XOR-fold is fine.
    if (expected.length !== computed.length) return false;
    let diff = 0;
    for (let i = 0; i < expected.length; i++) {
        diff |= expected.charCodeAt(i) ^ computed.charCodeAt(i);
    }
    return diff === 0;
}

/**
 * Send a free-form text message. Only works inside the 24h customer service
 * window (the user messaged us first within the last 24h). Outside that
 * window Meta requires a pre-approved template — we'll wire that in P3
 * for follow-ups.
 */
export async function sendText(toWaId, text) {
    const phoneId = env('WA_PHONE_NUMBER_ID');
    const token = env('WA_ACCESS_TOKEN');

    const resp = await fetchWithTimeout(
        `https://graph.facebook.com/${GRAPH_VERSION}/${phoneId}/messages`,
        {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${token}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                messaging_product: 'whatsapp',
                recipient_type: 'individual',
                to: toWaId,
                type: 'text',
                text: { preview_url: false, body: text },
            }),
        },
        TIMEOUTS.meta,
        'meta graph send',
    );
    if (!resp.ok) {
        const body = await resp.text();
        throw new Error(`Meta send ${resp.status}: ${body.slice(0, 300)}`);
    }
    return resp.json();
}

/**
 * Meta nests messages deep:
 *   entry[].changes[].value.messages[]
 *   entry[].changes[].value.statuses[]   (delivery receipts — we ignore for P1)
 *
 * Returns [] when the payload is a status update or otherwise has no text
 * messages to act on.
 */
export function parseInbound(body) {
    const out = [];
    const entries = Array.isArray(body && body.entry) ? body.entry : [];
    for (const entry of entries) {
        const changes = Array.isArray(entry.changes) ? entry.changes : [];
        for (const change of changes) {
            const value = change && change.value;
            if (!value) continue;
            const messages = Array.isArray(value.messages) ? value.messages : [];
            for (const m of messages) {
                if (m.type !== 'text' || !m.text || !m.text.body) continue;
                out.push({
                    from: m.from,                   // wa_id (digits, no '+')
                    text: m.text.body,
                    waMessageId: m.id,
                    timestamp: m.timestamp,
                });
            }
        }
    }
    return out;
}
