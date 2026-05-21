// Auto-refresh cadence. Doctors typically leave the dashboard open all day;
// 60 s is frequent enough that the cutoff window stays accurate without
// hammering Supabase.
const REFRESH_INTERVAL_MS = 60_000;
// "Now - this many hours" is the start of the visible window for
// appointments without an AI diagnosis. Past appointments that DO have a
// diagnosis are always shown (regardless of cutoff) so the doctor can
// replay the 3D viewer.
const CUTOFF_HOURS_BACK = 3;

// ---------- helpers ----------
function pad2(n) { return String(n).padStart(2, '0'); }

function ymd(date) {
    return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function hms(date) {
    return `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
}

// Combine the appointment's `date` (YYYY-MM-DD) and `time` (HH:MM or
// HH:MM:SS) into a JS Date in the browser's local timezone — appointments
// are stored as clinic-local time so this matches what the doctor expects.
function combineDt(dateStr, timeStr) {
    const t = (timeStr && timeStr.length === 5) ? `${timeStr}:00` : timeStr;
    return new Date(`${dateStr}T${t}`);
}

function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
}

function formatTimeLabel(dt, now) {
    // Same-day → just HH:MM; otherwise prefix the month/day so multi-day
    // listings stay unambiguous.
    const sameDay = dt.getFullYear() === now.getFullYear()
        && dt.getMonth() === now.getMonth()
        && dt.getDate() === now.getDate();
    const hhmm = `${pad2(dt.getHours())}:${pad2(dt.getMinutes())}`;
    if (sameDay) return `오늘  ${hhmm}`;
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    if (dt.getFullYear() === tomorrow.getFullYear()
        && dt.getMonth() === tomorrow.getMonth()
        && dt.getDate() === tomorrow.getDate()) {
        return `내일  ${hhmm}`;
    }
    // For older past dates, show the year too so it's unambiguous.
    if (dt.getFullYear() !== now.getFullYear()) {
        return `${dt.getFullYear()}/${pad2(dt.getMonth() + 1)}/${pad2(dt.getDate())}  ${hhmm}`;
    }
    return `${pad2(dt.getMonth() + 1)}/${pad2(dt.getDate())}  ${hhmm}`;
}

// ---------- clock ----------
function tickClock() {
    document.getElementById('clock').textContent = hms(new Date());
}

// ---------- data ----------
// Returns rows for the table. Two sources combined:
//   1. Confirmed appointments in the recent/upcoming window (>= cutoff).
//   2. Past appointments belonging to patients who have an AI diagnosis.
// Each row is tagged with the latest diagnosis (if any) for that patient
// so the render layer can show the "AI 진단 결과" button.
async function fetchAppointments() {
    const now = new Date();
    const cutoff = new Date(now.getTime() - CUTOFF_HOURS_BACK * 60 * 60 * 1000);

    const client = await initSupabase();

    // 1. AI diagnoses — one row per analysis run. We only need the latest
    //    per patient for the button + the patient list below.
    const { data: diagRows, error: eDiag } = await client
        .from('ai_diagnoses')
        .select('id, patient_id, created_at')
        .order('created_at', { ascending: false });
    if (eDiag) throw eDiag;

    // Latest diagnosis per patient.
    const latestDiagByPatient = new Map();
    (diagRows || []).forEach(d => {
        if (!latestDiagByPatient.has(d.patient_id)) {
            latestDiagByPatient.set(d.patient_id, d);
        }
    });
    const diagnosedPatientIds = [...latestDiagByPatient.keys()];

    // 2. Confirmed appointments — pull everything for diagnosed patients
    //    (so past visits surface) PLUS everything from the cutoff day
    //    onward. Union'd client-side because PostgREST's OR is awkward
    //    across an IN + GTE combo.
    const cutoffDate = ymd(cutoff);

    const upcomingQ = client
        .from('appointments')
        .select('id, patient_id, date, time, patients(name, symptoms)')
        .gte('date', cutoffDate)
        .eq('status', 'confirmed');

    // Avoid sending IN with an empty array (PostgREST treats `in.()` as a
    // syntax error). Skip the second query entirely when no one has a
    // diagnosis yet — the table will just show upcoming appointments.
    const diagnosedQ = diagnosedPatientIds.length > 0
        ? client
            .from('appointments')
            .select('id, patient_id, date, time, patients(name, symptoms)')
            .in('patient_id', diagnosedPatientIds)
            .eq('status', 'confirmed')
        : null;

    const [upRes, diagRes] = await Promise.all([
        upcomingQ,
        diagnosedQ || Promise.resolve({ data: [], error: null }),
    ]);
    if (upRes.error)   throw upRes.error;
    if (diagRes.error) throw diagRes.error;

    // 3. Merge + dedupe by appointment id, then filter the upcoming half by
    //    the precise datetime cutoff (cutoffDate is whole-day-loose).
    const byId = new Map();
    (upRes.data || []).forEach(a => {
        if (combineDt(a.date, a.time) >= cutoff) byId.set(a.id, a);
    });
    (diagRes.data || []).forEach(a => {
        if (!byId.has(a.id)) byId.set(a.id, a);
    });
    let rows = [...byId.values()];

    // 4. Attach latest diagnosis (if any) to each row.
    rows.forEach(a => { a.latestDiag = latestDiagByPatient.get(a.patient_id) || null; });

    // 5. Sort by datetime (oldest first) so past visits sit at the top and
    //    upcoming ones — including the highlighted "next up" — at the bottom.
    rows.sort((a, b) => combineDt(a.date, a.time) - combineDt(b.date, b.time));

    if (rows.length === 0) return { rows: [], cutoff };

    // 6. Visit number = 1-indexed position of THIS appointment in the
    //    patient's full confirmed history. Fetch each involved patient's
    //    full history once (independently of date filters above), build a
    //    per-patient ordered list, then look up the index for each row.
    const patientIds = [...new Set(rows.map(a => a.patient_id))];
    const { data: history, error: eHist } = await client
        .from('appointments')
        .select('id, patient_id, date, time')
        .in('patient_id', patientIds)
        .eq('status', 'confirmed')
        .order('date', { ascending: true })
        .order('time', { ascending: true });
    if (eHist) throw eHist;

    const byPatient = new Map();
    (history || []).forEach(a => {
        if (!byPatient.has(a.patient_id)) byPatient.set(a.patient_id, []);
        byPatient.get(a.patient_id).push(a);
    });

    rows.forEach(a => {
        const list = byPatient.get(a.patient_id) || [];
        a.visitNumber = list.findIndex(x => x.id === a.id) + 1;
    });

    return { rows, cutoff };
}

// ---------- render ----------
// Build the viewer URL for one diagnosed row. Passes the patient id so the
// viewer can fetch the latest diagnosis; name is included purely so the
// top bar greets the doctor with a familiar label while loading.
function viewerUrl(row) {
    const params = new URLSearchParams({
        patientId: row.patient_id,
        name: (row.patients && row.patients.name) ? row.patients.name : '환자',
        diagnosisId: row.latestDiag ? row.latestDiag.id : '',
    });
    return `viewer/index.html?${params.toString()}`;
}

function render({ rows, cutoff }) {
    const tbody = document.getElementById('appt-body');
    const cutoffLabel = document.getElementById('cutoff-label');

    cutoffLabel.textContent =
        `${CUTOFF_HOURS_BACK}시간 전(${hms(cutoff).slice(0, 5)}) 이후의 예약 · AI 진단 완료 환자`;

    if (!rows || rows.length === 0) {
        tbody.innerHTML = '<tr><td colspan="5" class="empty">표시할 예약 또는 진단이 없습니다.</td></tr>';
        return;
    }

    const now = new Date();
    // First row that is "now or in the future" gets the "next up" highlight.
    const nextIdx = rows.findIndex(a => combineDt(a.date, a.time) >= now);

    tbody.innerHTML = rows.map((a, idx) => {
        const dt = combineDt(a.date, a.time);
        const isPast = dt < now;
        const isNextUp = idx === nextIdx;
        const cls = [];
        if (isPast) cls.push('past');
        if (isNextUp) cls.push('next-up');
        const name = (a.patients && a.patients.name) ? a.patients.name : '(이름 없음)';
        const symptomsRaw = (a.patients && a.patients.symptoms) ? a.patients.symptoms.trim() : '';
        const symptomsHtml = symptomsRaw
            ? escapeHtml(symptomsRaw)
            : '<span class="muted">—</span>';
        const hasDiag = !!a.latestDiag;
        const diagCell = hasDiag
            ? `<a class="btn-diag" target="_blank" rel="noopener" href="${escapeHtml(viewerUrl(a))}">AI 진단 결과 →</a>`
            : '<span class="muted">—</span>';
        return `<tr class="${cls.join(' ')}">
            <td class="time-col">${formatTimeLabel(dt, now)}</td>
            <td class="name-col">${escapeHtml(name)}</td>
            <td class="visit-col"><span class="visit-badge">${a.visitNumber}회</span></td>
            <td class="symptoms-col">${symptomsHtml}</td>
            <td class="diag-col">${diagCell}</td>
        </tr>`;
    }).join('');
}

function setLastRefresh() {
    document.getElementById('last-refresh').textContent = `갱신: ${hms(new Date())}`;
}

async function refresh() {
    const btn = document.getElementById('btn-refresh');
    btn.disabled = true;
    try {
        const result = await fetchAppointments();
        render(result);
        setLastRefresh();
    } catch (e) {
        console.error(e);
        const msg = (e && e.message) ? e.message : String(e);
        document.getElementById('appt-body').innerHTML =
            `<tr><td colspan="5" class="error">데이터를 불러오지 못했습니다.\n${escapeHtml(msg)}</td></tr>`;
    } finally {
        btn.disabled = false;
    }
}

// ---------- init ----------
document.addEventListener('DOMContentLoaded', () => {
    tickClock();
    setInterval(tickClock, 1000);

    document.getElementById('btn-refresh').addEventListener('click', refresh);
    refresh();
    setInterval(refresh, REFRESH_INTERVAL_MS);
});
