// WhatsApp Cloud API webhook.
//
// GET  /api/whatsapp   — Meta verification handshake.
// POST /api/whatsapp   — Inbound messages + status updates.
//
// Meta gives us ~5 seconds before it considers the webhook failed and retries.
// We acknowledge with 200 immediately and do the actual work (signature check,
// Claude call, reply send) under Vercel's `waitUntil` so the function instance
// stays alive after the response. Failures inside that background work are
// logged but don't surface to Meta as failures — that's the point, otherwise
// we'd get duplicate retries.

const { verifySignature, parseInbound } = require('../lib/wa');
const { handleInbound } = require('../lib/handle');

/**
 * Raw body reader — HMAC must be computed over the *exact bytes* Meta signed.
 * Vercel's behavior depends on Content-Type and plan, so try every shape:
 *   1) req.rawBody (newer Vercel runtimes expose this Buffer)
 *   2) req.body as string / Buffer (translate.js shows we sometimes get this)
 *   3) Stream read via 'data' events (raw IncomingMessage)
 * If req.body is already a parsed object, the raw bytes are gone and HMAC
 * will fail — that's why we don't fall back to JSON.stringify(req.body).
 */
async function readRawBody(req) {
    if (req.rawBody) {
        return Buffer.isBuffer(req.rawBody)
            ? req.rawBody.toString('utf8')
            : String(req.rawBody);
    }
    if (typeof req.body === 'string') return req.body;
    if (Buffer.isBuffer(req.body)) return req.body.toString('utf8');
    if (req.body && typeof req.body === 'object') {
        // Body was pre-parsed — raw bytes lost. Signal failure so the caller
        // returns 401 rather than silently mis-verifying.
        return null;
    }
    return new Promise((resolve, reject) => {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        req.on('error', reject);
    });
}

module.exports = async (req, res) => {
    // ── GET: verification handshake ────────────────────────────────────────
    if (req.method === 'GET') {
        const mode = req.query['hub.mode'];
        const token = req.query['hub.verify_token'];
        const challenge = req.query['hub.challenge'];

        const expected = (process.env.WA_VERIFY_TOKEN || '').replace(/^﻿/, '').trim();
        if (mode === 'subscribe' && token && token === expected) {
            res.status(200).send(challenge);
            return;
        }
        res.status(403).send('forbidden');
        return;
    }

    if (req.method !== 'POST') {
        res.status(405).json({ error: 'method' });
        return;
    }

    // ── POST: messages ─────────────────────────────────────────────────────
    let raw;
    try { raw = await readRawBody(req); }
    catch (e) { res.status(400).json({ error: 'body read' }); return; }

    if (raw === null) {
        // Body was pre-parsed by the runtime; we can't HMAC it. Tell ops
        // exactly what to fix in vercel.json / runtime config.
        console.error('[wa] body was pre-parsed; HMAC unavailable');
        res.status(500).json({ error: 'body pre-parsed' });
        return;
    }

    const signature = req.headers['x-hub-signature-256'];
    if (!verifySignature(raw, signature)) {
        // Don't tell the caller why — security hygiene.
        res.status(401).json({ error: 'bad signature' });
        return;
    }

    let body;
    try { body = JSON.parse(raw); }
    catch { res.status(400).json({ error: 'bad json' }); return; }

    // Acknowledge Meta immediately. Anything that takes more than ~5s in here
    // would trigger retries and duplicate replies.
    res.status(200).json({ ok: true });

    // Background: dispatch each inbound text. Wrapped so a single failing
    // message doesn't kill the others.
    const inbound = parseInbound(body);
    const work = Promise.allSettled(
        inbound.map(async (m) => {
            try { await handleInbound(m); }
            catch (e) { console.error('[wa] handle error', m.waMessageId, e); }
        }),
    );

    // Vercel: `waitUntil` keeps the function alive past the response so the
    // background promise can finish. In other Node envs this is a no-op.
    const ctx = (req && req.waitUntil) || (res && res.waitUntil);
    if (typeof ctx === 'function') ctx.call(req || res, work);
    else await work;  // local dev fallback
};
