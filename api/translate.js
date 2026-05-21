// Vercel serverless function — proxies Spanish→Korean translation
// through Claude so the Anthropic key never leaves the server. Called by
// the symptom modal's "한글 번역" toggle.
//
// Request:  POST /api/translate   body { text: "Spanish text" }
// Response: 200  { translation: "한국어 번역" }
//           5xx  { error: "..." }
//
// We use a tiny haiku model for cost/latency — translation is a single
// short turn and doesn't need the heavy reasoning models.

const MODEL = 'claude-haiku-4-5-20251001';
const ANTHROPIC_VERSION = '2023-06-01';
const MAX_INPUT_CHARS = 4000;   // refuse pathologically long inputs

module.exports = async (req, res) => {
    // Same-origin only in normal use, but keep CORS open for dev/preview.
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') { res.status(204).end(); return; }
    if (req.method !== 'POST')    { res.status(405).json({ error: 'method' }); return; }

    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) { res.status(500).json({ error: 'ANTHROPIC_API_KEY not set' }); return; }

    let body = req.body;
    // Vercel parses JSON automatically when Content-Type is set; defensive
    // fallback when it isn't.
    if (typeof body === 'string') {
        try { body = JSON.parse(body); } catch { body = {}; }
    }
    const text = (body && typeof body.text === 'string') ? body.text.trim() : '';
    if (!text)                      { res.status(400).json({ error: 'text required' }); return; }
    if (text.length > MAX_INPUT_CHARS) {
        res.status(413).json({ error: `text too long (>${MAX_INPUT_CHARS} chars)` }); return;
    }

    try {
        const resp = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
                'x-api-key': key,
                'anthropic-version': ANTHROPIC_VERSION,
                'content-type': 'application/json',
            },
            body: JSON.stringify({
                model: MODEL,
                max_tokens: 1000,
                // Translation-only system: prevents the model from chatting
                // back or wrapping the output in markdown.
                system:
                    '당신은 의료 통역가입니다. 사용자가 보내는 텍스트(주로 스페인어 환자 증상)를 '
                    + '자연스러운 한국어로 번역하세요. 절대 설명, 머리말, 따옴표, 마크다운 없이 '
                    + '번역된 한국어 본문만 출력합니다. 의학 용어는 임상에서 쓰는 형태로 옮기세요.',
                messages: [
                    { role: 'user', content: text },
                ],
            }),
        });

        if (!resp.ok) {
            const body = await resp.text();
            res.status(502).json({ error: `Anthropic ${resp.status}: ${body.slice(0, 400)}` });
            return;
        }

        const data = await resp.json();
        const translation = (data.content || [])
            .filter((c) => c.type === 'text')
            .map((c) => c.text)
            .join('')
            .trim();
        if (!translation) {
            res.status(502).json({ error: 'empty translation' });
            return;
        }
        res.status(200).json({ translation });
    } catch (e) {
        res.status(500).json({ error: String(e && e.message ? e.message : e) });
    }
};
