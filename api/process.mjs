// Background worker for WhatsApp message processing — Node runtime.
//
// Why this exists: the webhook (api/whatsapp.js, Edge) must answer Meta in
// <5s, but Claude+MCP takes 10-60s. Running that work under Edge
// ctx.waitUntil proved unreliable — isolates get suspended/reclaimed after
// the response is sent, which surfaced as replies arriving minutes late or
// never. So the webhook now self-invokes THIS endpoint and returns; a Node
// invocation has an honored maxDuration and runs to completion even if the
// dispatching client disconnects mid-flight.
//
// Auth: shares MCP_AUTH_TOKEN with /api/mcp — both are server-to-server
// endpoints guarded by the same high-entropy secret; a second env var would
// just be more ops surface.
//
// Request:  POST { messages: [{ from, text, waMessageId }, ...] }
// Response: 200 when at least one message processed; the reply to the
//           patient goes out via the WhatsApp Graph API, not this response.

// Node runtime — maxDuration IS honored here. 90s covers the worst case:
// Claude+MCP budget (60s, lib/http.mjs) plus the surrounding Supabase and
// WhatsApp sends (10s each, normally <1s combined).
export const config = { maxDuration: 90 };

import { handleInbound } from '../lib/handle.mjs';

export default async function handler(req, res) {
    if (req.method !== 'POST') {
        res.status(405).json({ error: 'method' });
        return;
    }

    // BOM defense, same as everywhere else in this repo.
    const expected = (process.env.MCP_AUTH_TOKEN || '').replace(/^﻿/, '').trim();
    const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '');
    if (!expected || !m || m[1].trim() !== expected) {
        res.status(401).json({ error: 'unauthorized' });
        return;
    }

    let body = req.body;
    if (typeof body === 'string') {
        try { body = JSON.parse(body); } catch { body = {}; }
    }
    const messages = (body && Array.isArray(body.messages)) ? body.messages : [];
    if (!messages.length) {
        res.status(400).json({ error: 'messages required' });
        return;
    }

    // Same isolation contract as the old webhook loop: one failing message
    // must not kill the others. handleInbound already has its own Claude-
    // failure fallback (sends SAFE_FALLBACK to the patient), so a rejection
    // here means even the fallback send failed — log loudly. Retries of the
    // whole batch are safe: the wa_message_id dedup makes them no-ops.
    const results = await Promise.allSettled(messages.map((msg) => handleInbound(msg)));
    const failed = results.filter((r) => r.status === 'rejected');
    for (const f of failed) {
        console.error('[process] handle error',
            f.reason && f.reason.message ? f.reason.message : f.reason);
    }

    res.status(failed.length === messages.length ? 500 : 200).json({
        ok: failed.length === 0,
        processed: messages.length - failed.length,
        failed: failed.length,
    });
}
