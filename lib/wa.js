// Meta WhatsApp Cloud API helpers.
//   - verifySignature: HMAC-SHA256 on the raw POST body using WA_APP_SECRET.
//   - sendText:        POST a free-form text message to a wa_id.
//   - parseInbound:    extract { from, text, waMessageId } from Meta's payload.
//
// All values from process.env — never hardcoded.

const crypto = require('crypto');

const GRAPH_VERSION = 'v20.0';

function env(name) {
    const raw = process.env[name] || '';
    const v = raw.replace(/^﻿/, '').trim();
    if (!v) throw new Error(`${name} not set`);
    return v;
}

/**
 * Meta signs the raw POST body with HMAC-SHA256 using your App Secret and
 * sends it as `x-hub-signature-256: sha256=<hex>`. Reject anything that
 * doesn't match — otherwise anyone on the internet can post to our webhook.
 */
function verifySignature(rawBody, signatureHeader) {
    if (!signatureHeader || typeof signatureHeader !== 'string') return false;
    const expected = signatureHeader.startsWith('sha256=')
        ? signatureHeader.slice(7)
        : signatureHeader;

    const secret = env('WA_APP_SECRET');
    const hmac = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');

    // Constant-time compare to dodge timing attacks. Length check first because
    // timingSafeEqual throws on mismatched lengths.
    if (expected.length !== hmac.length) return false;
    return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(hmac, 'hex'));
}

/**
 * Send a free-form text message. Only works inside the 24h customer service
 * window (i.e., the user messaged us first within the last 24h). Outside
 * that window Meta requires a pre-approved template — we'll add that in P3
 * for follow-ups.
 */
async function sendText(toWaId, text) {
    const phoneId = env('WA_PHONE_NUMBER_ID');
    const token = env('WA_ACCESS_TOKEN');

    const resp = await fetch(
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
function parseInbound(body) {
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

module.exports = { verifySignature, sendText, parseInbound };
