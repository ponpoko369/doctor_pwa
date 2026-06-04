// MCP server — Streamable HTTP transport (JSON-RPC 2.0), Edge runtime.
//
// Anthropic's Messages API `mcp_servers` connector (beta `mcp-client-2025-11-20`)
// calls this endpoint server-side: Claude decides to invoke a tool, Anthropic
// POSTs JSON-RPC to us, we hit Supabase, return the result, Claude continues.
// We never see the tool-use loop ourselves — that's the whole appeal vs.
// hand-rolling function calling.
//
// Hand-rolled instead of pulling @modelcontextprotocol/sdk because:
//   - doctor_pwa has no package.json / build step; this stays consistent
//   - we only need methods initialize / tools/list / tools/call (no resources,
//     prompts, sampling) — ~80 lines of dispatch
//
// Auth: Anthropic forwards our configured `authorization_token` as
// `Authorization: Bearer <token>`. We compare against MCP_AUTH_TOKEN env.

export const config = { runtime: 'edge' };

import { TOOLS, TOOL_INDEX } from '../mcp/tools.mjs';

const PROTOCOL_VERSION = '2025-03-26';
const SERVER_INFO = { name: 'clinica-mcp', version: '0.1.0' };

function env(name) {
    const raw = process.env[name] || '';
    return raw.replace(/^﻿/, '').trim();
}

function jsonRpc(id, result) {
    return { jsonrpc: '2.0', id, result };
}

function jsonRpcError(id, code, message, data) {
    const error = { code, message };
    if (data !== undefined) error.data = data;
    return { jsonrpc: '2.0', id, error };
}

function jsonResponse(body, status = 200) {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
    });
}

// ── method handlers ─────────────────────────────────────────────────────────

function handleInitialize(params) {
    return {
        protocolVersion: PROTOCOL_VERSION,
        serverInfo: SERVER_INFO,
        capabilities: {
            tools: { listChanged: false },
        },
    };
}

function handleToolsList() {
    return {
        tools: TOOLS.map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
        })),
    };
}

async function handleToolsCall(params) {
    const name = params && params.name;
    const args = (params && params.arguments) || {};
    const tool = TOOL_INDEX[name];
    if (!tool) {
        throw { code: -32602, message: `unknown tool: ${name}` };
    }
    let result;
    try {
        result = await tool.handler(args);
    } catch (e) {
        // Surface tool errors via the MCP "isError" content path so Claude can
        // see them and recover, rather than a transport-level error.
        return {
            content: [{ type: 'text', text: `ERROR: ${e && e.message ? e.message : String(e)}` }],
            isError: true,
        };
    }
    return {
        content: [{ type: 'text', text: JSON.stringify(result) }],
    };
}

// ── transport ───────────────────────────────────────────────────────────────

async function dispatch(req) {
    const { id, method, params } = req || {};
    try {
        switch (method) {
            case 'initialize':
                return jsonRpc(id, handleInitialize(params));
            case 'notifications/initialized':
                // Notification — no response. Caller treats undefined as "skip".
                return null;
            case 'ping':
                return jsonRpc(id, {});
            case 'tools/list':
                return jsonRpc(id, handleToolsList());
            case 'tools/call':
                return jsonRpc(id, await handleToolsCall(params));
            default:
                return jsonRpcError(id, -32601, `method not found: ${method}`);
        }
    } catch (e) {
        if (e && typeof e === 'object' && 'code' in e) {
            return jsonRpcError(id, e.code, e.message, e.data);
        }
        return jsonRpcError(id, -32603, e && e.message ? e.message : String(e));
    }
}

function authOk(req) {
    const expected = env('MCP_AUTH_TOKEN');
    if (!expected) {
        // Fail-closed: refuse to serve if the secret is missing. Otherwise an
        // env-var rename or a bad deploy would silently open the MCP to the
        // public internet, which exposes patient data via Supabase service role.
        return false;
    }
    const got = req.headers.get('authorization') || '';
    const m = /^Bearer\s+(.+)$/i.exec(got);
    if (!m) return false;
    // Length-then-equality is fine here: timing leaks against a high-entropy
    // shared secret aren't a realistic threat for a clinic webhook.
    return m[1].trim() === expected;
}

export default async function handler(req) {
    // Health check / preflight: tolerate GET so Vercel + uptime monitors don't
    // pollute logs with 405s.
    if (req.method === 'GET') {
        return new Response('clinica-mcp ready\n', {
            status: 200,
            headers: { 'content-type': 'text/plain' },
        });
    }
    if (req.method !== 'POST') {
        return jsonResponse({ error: 'method' }, 405);
    }
    if (!authOk(req)) {
        return jsonResponse({ error: 'unauthorized' }, 401);
    }

    const raw = await req.text();
    let body;
    try { body = JSON.parse(raw); }
    catch { return jsonResponse({ error: 'bad json' }, 400); }

    // JSON-RPC permits batching (array of requests). Anthropic's connector
    // sends single objects today, but supporting batches is ~3 lines and
    // shields us if that changes.
    if (Array.isArray(body)) {
        const responses = (await Promise.all(body.map(dispatch))).filter(Boolean);
        return jsonResponse(responses);
    }
    const resp = await dispatch(body);
    if (resp === null) return new Response(null, { status: 204 });
    return jsonResponse(resp);
}
