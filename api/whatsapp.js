// WhatsApp Cloud API webhook — Edge Runtime.
//
// We need Edge specifically because Vercel's Node runtime auto-parses the
// JSON body before our handler runs, which destroys the exact bytes Meta
// signed and makes HMAC-SHA256 verification impossible. Edge gives us a
// standard Request object, so `await req.text()` returns the raw signed
// payload byte-for-byte.
//
// GET  /api/whatsapp   — Meta verification handshake.
// POST /api/whatsapp   — Inbound messages + status updates.
//
// Meta gives us ~5 seconds before it considers the webhook failed and
// retries. The P1 work (Supabase read/write + one Meta API send) runs in
// well under that, so we just await before responding. When Claude lands
// in P2 we'll switch to `waitUntil` from `@vercel/functions`.

export const config = { runtime: 'edge' };

import { verifySignature, parseInbound } from '../lib/wa.mjs';
import { handleInbound } from '../lib/handle.mjs';

function json(obj, status = 200) {
    return new Response(JSON.stringify(obj), {
        status,
        headers: { 'content-type': 'application/json' },
    });
}

export default async function handler(req, ctx) {
    const url = new URL(req.url);

    // ── GET: verification handshake ────────────────────────────────────────
    if (req.method === 'GET') {
        const mode = url.searchParams.get('hub.mode');
        const token = url.searchParams.get('hub.verify_token');
        const challenge = url.searchParams.get('hub.challenge') || '';

        const expected = (process.env.WA_VERIFY_TOKEN || '').replace(/^﻿/, '').trim();
        if (mode === 'subscribe' && token && token === expected) {
            return new Response(challenge, {
                status: 200,
                headers: { 'content-type': 'text/plain' },
            });
        }
        return new Response('forbidden', { status: 403 });
    }

    if (req.method !== 'POST') return json({ error: 'method' }, 405);

    // ── POST: messages ─────────────────────────────────────────────────────
    // req.text() returns the exact bytes Meta signed. Don't req.json() first
    // or any preprocessing — the HMAC must be computed over the original.
    const raw = await req.text();
    const signature = req.headers.get('x-hub-signature-256');

    if (!(await verifySignature(raw, signature))) {
        // Don't tell the caller why — security hygiene.
        return json({ error: 'bad signature' }, 401);
    }

    let body;
    try { body = JSON.parse(raw); }
    catch { return json({ error: 'bad json' }, 400); }

    // Dispatch each inbound text. Wrapped so a single failing message
    // doesn't kill the others.
    const inbound = parseInbound(body);
    const work = Promise.allSettled(
        inbound.map(async (m) => {
            try { await handleInbound(m); }
            catch (e) { console.error('[wa] handle error', m.waMessageId, e); }
        }),
    );

    // P1: the dispatch is fast (1-2 Supabase RTs + 1 Meta send), well inside
    // Meta's 5s ack window — just await. P2 adds Claude and we'll move this
    // under ctx.waitUntil(work) before responding.
    if (ctx && typeof ctx.waitUntil === 'function') {
        ctx.waitUntil(work);
    } else {
        await work;
    }
    return json({ ok: true });
}
