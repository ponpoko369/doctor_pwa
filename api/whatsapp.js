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
// retries. This function therefore does ONLY verify + parse + dispatch:
// the Claude+MCP work runs in /api/process (Node runtime, real maxDuration),
// which we self-invoke over HTTP. Once that request reaches the Node
// function, its invocation runs to completion even if this Edge isolate is
// reclaimed — which is what used to make replies arrive minutes late or
// never when the heavy work lived in ctx.waitUntil here.

export const config = {
    runtime: 'edge',
    // NO maxDuration here, on purpose. maxDuration is a Node-runtime-only
    // setting — on runtime:'edge' Vercel silently ignores it, which is how
    // we got "Task timed out after 300 seconds" (the platform default
    // ceiling) despite a maxDuration:60 sitting right here. The worker's
    // budget lives in api/process.mjs (maxDuration: 90) where it's honored.
};

import { verifySignature, parseInbound } from '../lib/wa.mjs';
import { fetchWithTimeout } from '../lib/http.mjs';

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

    // ── Dispatch to the Node worker ────────────────────────────────────────
    // Hand the parsed messages to /api/process and return 200 to Meta now.
    // waitUntil only needs to keep us alive long enough for the dispatch
    // request to be DELIVERED (~100ms); after that the Node invocation
    // finishes on its own even if this isolate dies. We still hold the
    // connection for the worker's full run when we can — it's free and the
    // response tells us in the logs whether processing succeeded.
    const inbound = parseInbound(body);
    if (!inbound.length) return json({ ok: true });

    const token = (process.env.MCP_AUTH_TOKEN || '').replace(/^﻿/, '').trim();
    const dispatchOnce = () => fetchWithTimeout(
        `${url.origin}/api/process`,
        {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({ messages: inbound }),
        },
        // Just above the worker's maxDuration (90s) — this should only ever
        // fire if the worker itself was killed without responding.
        95_000,
        'dispatch /api/process',
    );
    // One retry for a transient network failure on the handoff. Retrying
    // after the worker already logged the inbound is harmless — the
    // wa_message_id dedup in handle.mjs turns the rerun into a no-op.
    const dispatch = dispatchOnce()
        .catch((e) => {
            console.warn('[wa] dispatch retry after:', e && e.message ? e.message : e);
            return dispatchOnce();
        })
        .catch((e) => console.error('[wa] dispatch failed twice:', e && e.message ? e.message : e));

    if (ctx && typeof ctx.waitUntil === 'function') {
        ctx.waitUntil(dispatch);
    } else {
        // Risky mode: the isolate may die before the request leaves. The
        // worker + dedup still make an eventual Meta retry safe to process.
        console.warn('[wa] ctx.waitUntil unavailable — fire-and-forget dispatch');
    }
    return json({ ok: true });
}
