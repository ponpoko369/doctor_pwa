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

export const config = {
    runtime: 'edge',
    // Edge Functions on Hobby cap at ~25-30s; setting maxDuration is a no-op
    // beyond the plan limit but signals intent and lets Pro upgrades take
    // effect with no code change. Claude+MCP p50 is 5-10s, p99 (cold start
    // + cache miss + slow MCP) can be 15-20s.
    maxDuration: 60,
};

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

    // Background execution. Meta's webhook deadline is 5s — Claude+MCP can
    // take 10-20s on the slow path, so we MUST return 200 before that work
    // finishes. ctx.waitUntil keeps the Edge isolate alive after the
    // response so the work continues running.
    //
    // Fallback: if ctx isn't passed (some Vercel Edge configs), we fire-
    // and-forget by attaching `.catch` and NOT awaiting. The isolate may
    // still get GC'd mid-flight — that's exactly the failure mode the user
    // saw, and it's why handleInbound now sends an immediate ack so the
    // patient at least knows the message was received.
    if (ctx && typeof ctx.waitUntil === 'function') {
        ctx.waitUntil(work);
    } else {
        console.warn('[wa] ctx.waitUntil unavailable — fire-and-forget mode');
        work.catch((e) => console.error('[wa] background error', e));
    }
    return json({ ok: true });
}
