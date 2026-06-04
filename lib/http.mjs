// Shared fetch-with-timeout (global fetch + AbortController — works on both
// the Edge webhook and the Node worker).
//
// Every outbound call MUST be bounded. A single hung fetch (seen with the
// Anthropic call / MCP loop) used to ride the invocation into Vercel's
// platform ceiling: "Task timed out after 300 seconds". A stalled upstream
// must surface as a thrown Error (→ SAFE_FALLBACK to the patient) instead.
//
// Budgets are sized for the worker (api/process.mjs, maxDuration: 90):
// claude 60s + a handful of supabase/meta calls at 10s each, which are
// normally <1s combined. If you raise claude, raise the worker's
// maxDuration to match.

export const TIMEOUTS = {
    claude: 60_000,   // Anthropic + server-side MCP loop. Multi-tool turns
                      // (triage → list_slots → confirm) legitimately run
                      // 20-40s; the old 25s budget was cutting them off and
                      // causing fallback→re-ask loops.
    meta: 10_000,     // WhatsApp Graph send; normally <1s
    supabase: 10_000, // REST reads/writes; normally <500ms
};

/**
 * fetch() that aborts after `ms`. An abort is rewritten from the generic
 * "The operation was aborted" into `Error("<label> timeout after <ms>ms")`
 * so the logs say WHICH upstream stalled.
 */
export async function fetchWithTimeout(url, init, ms, label) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ms);
    try {
        return await fetch(url, { ...init, signal: ctrl.signal });
    } catch (e) {
        if (ctrl.signal.aborted) {
            throw new Error(`${label || url} timeout after ${ms}ms`);
        }
        throw e;
    } finally {
        clearTimeout(timer);
    }
}
