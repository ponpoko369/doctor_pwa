// Same Supabase project as the patient-facing PWA — same anon key.
// RLS allows anon SELECT on patients + appointments, so this read-only
// dashboard works with no extra policy changes.
const SUPABASE_URL = 'https://cojzdjajwrzzyqxzljgq.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_nx3OwIicQ0TcvHQvf1xSsA_akcvr4vB';

let supabaseClient = null;

async function initSupabase() {
    if (supabaseClient) return supabaseClient;
    const { createClient } = await import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm');
    supabaseClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    return supabaseClient;
}
