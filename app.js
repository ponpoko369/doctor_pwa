// Auto-refresh cadence. Doctors typically leave the dashboard open all day;
// 60 s is frequent enough that the visible window stays accurate without
// hammering Supabase.
const REFRESH_INTERVAL_MS = 60_000;

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

const WEEKDAY_KO = ['일','월','화','수','목','금','토'];

// Time-column text. For today/tomorrow keep the friendly "오늘/내일" prefix
// the old dashboard used; for other days surface the weekday + date so the
// doctor can scan the timeline without doing arithmetic in their head.
function formatTimeLabel(dt, now) {
    const sameDay = dt.getFullYear() === now.getFullYear()
        && dt.getMonth() === now.getMonth()
        && dt.getDate() === now.getDate();
    const hhmm = `${pad2(dt.getHours())}:${pad2(dt.getMinutes())}`;
    if (sameDay) return `오늘 (${WEEKDAY_KO[dt.getDay()]})  ${hhmm}`;

    const tomorrow = new Date(now); tomorrow.setDate(tomorrow.getDate() + 1);
    if (dt.getFullYear() === tomorrow.getFullYear()
        && dt.getMonth() === tomorrow.getMonth()
        && dt.getDate() === tomorrow.getDate()) {
        return `내일 (${WEEKDAY_KO[dt.getDay()]})  ${hhmm}`;
    }
    const yesterday = new Date(now); yesterday.setDate(yesterday.getDate() - 1);
    if (dt.getFullYear() === yesterday.getFullYear()
        && dt.getMonth() === yesterday.getMonth()
        && dt.getDate() === yesterday.getDate()) {
        return `어제 (${WEEKDAY_KO[dt.getDay()]})  ${hhmm}`;
    }
    // Year-prefixed only when it differs from "now" — keeps in-year dates
    // compact ("05/21 (목) 09:00") while older history stays unambiguous.
    if (dt.getFullYear() !== now.getFullYear()) {
        return `${dt.getFullYear()}/${pad2(dt.getMonth() + 1)}/${pad2(dt.getDate())} (${WEEKDAY_KO[dt.getDay()]})  ${hhmm}`;
    }
    return `${pad2(dt.getMonth() + 1)}/${pad2(dt.getDate())} (${WEEKDAY_KO[dt.getDay()]})  ${hhmm}`;
}

// ---------- clock ----------
function tickClock() {
    document.getElementById('clock').textContent = hms(new Date());
}

// ---------- data ----------
// Pulls every confirmed appointment + every AI diagnosis, joins them
// in-memory. No date filtering — the doctor wants the whole timeline,
// scrollable in both directions.
async function fetchAppointments() {
    const client = await initSupabase();

    // 1. AI diagnoses — only the latest per patient is needed for the
    //    "row is clickable → 3D viewer" check.
    const { data: diagRows, error: eDiag } = await client
        .from('ai_diagnoses')
        .select('id, patient_id, created_at')
        .order('created_at', { ascending: false });
    if (eDiag) throw eDiag;

    const latestDiagByPatient = new Map();
    (diagRows || []).forEach(d => {
        if (!latestDiagByPatient.has(d.patient_id)) {
            latestDiagByPatient.set(d.patient_id, d);
        }
    });

    // 2. ALL confirmed appointments, joined with patient name/symptoms.
    //    Past visits without a diagnosis still surface so the doctor can
    //    review the symptom history of every patient who ever booked.
    const { data: appts, error: eAppts } = await client
        .from('appointments')
        .select('id, patient_id, date, time, patients(name, symptoms)')
        .eq('status', 'confirmed')
        .order('date', { ascending: true })
        .order('time', { ascending: true });
    if (eAppts) throw eAppts;

    let rows = appts || [];
    if (rows.length === 0) return { rows: [] };

    // 3. Attach diagnosis info to each row.
    rows.forEach(a => { a.latestDiag = latestDiagByPatient.get(a.patient_id) || null; });

    // 4. Visit number = 1-indexed position in the patient's confirmed
    //    history. We already have every confirmed appointment for every
    //    patient (step 2 had no filter), so we can compute this without
    //    a second round trip.
    const byPatient = new Map();
    rows.forEach(a => {
        if (!byPatient.has(a.patient_id)) byPatient.set(a.patient_id, []);
        byPatient.get(a.patient_id).push(a);
    });
    rows.forEach(a => {
        const list = byPatient.get(a.patient_id) || [];
        a.visitNumber = list.findIndex(x => x.id === a.id) + 1;
    });

    return { rows };
}

// ---------- render ----------
function viewerUrl(row) {
    const params = new URLSearchParams({
        patientId: row.patient_id,
        name: (row.patients && row.patients.name) ? row.patients.name : '환자',
        diagnosisId: row.latestDiag ? row.latestDiag.id : '',
    });
    return `viewer/index.html?${params.toString()}`;
}

// Today's row index — used after render() to anchor the initial scroll
// position. Reset on every render so a manual refresh re-centers.
let _todayRowIndex = -1;
let _firstRender = true;

function render({ rows }) {
    const tbody = document.getElementById('appt-body');

    if (!rows || rows.length === 0) {
        tbody.innerHTML = '<tr><td colspan="4" class="empty">표시할 예약이 없습니다.</td></tr>';
        _todayRowIndex = -1;
        return;
    }

    const now = new Date();
    const todayStr = ymd(now);

    // First row with a date >= today (so we can scroll there).
    _todayRowIndex = rows.findIndex(a => a.date >= todayStr);
    if (_todayRowIndex < 0) _todayRowIndex = rows.length - 1;   // all past → last

    // "Next up" = first row whose datetime is >= now. Highlighted in yellow.
    const nextIdx = rows.findIndex(a => combineDt(a.date, a.time) >= now);

    tbody.innerHTML = rows.map((a, idx) => {
        const dt = combineDt(a.date, a.time);
        const isPast = dt < now;
        const isNextUp = idx === nextIdx;
        const isToday = a.date === todayStr;
        const hasDiag = !!a.latestDiag;
        const cls = [];
        if (isPast)   cls.push('past');
        if (isNextUp) cls.push('next-up');
        if (isToday)  cls.push('today');
        if (hasDiag)  cls.push('has-diag');
        const name = (a.patients && a.patients.name) ? a.patients.name : '(이름 없음)';
        const symptomsRaw = (a.patients && a.patients.symptoms) ? a.patients.symptoms.trim() : '';
        const symptomCell = symptomsRaw
            ? `<div class="symptoms-row">
                 <span class="symptoms-text" title="${escapeHtml(symptomsRaw)}">${escapeHtml(symptomsRaw)}</span>
                 <button type="button" class="btn-symptom"
                         data-symptom="${escapeHtml(symptomsRaw)}"
                         data-name="${escapeHtml(name)}"
                         title="전체 증상 보기">📋</button>
               </div>`
            : '<span class="muted">—</span>';
        const nameCell = `<div class="name-row">
                 <span class="name-text">${escapeHtml(name)}</span>
                 <button type="button" class="btn-delete"
                         data-appt-id="${escapeHtml(a.id)}"
                         data-name="${escapeHtml(name)}"
                         title="예약 삭제">🗑</button>
               </div>`;
        // data-* lets the delegated click handler open the right viewer.
        const viewerHref = hasDiag ? escapeHtml(viewerUrl(a)) : '';
        return `<tr class="${cls.join(' ')}" data-viewer-url="${viewerHref}">
            <td class="time-col">${formatTimeLabel(dt, now)}</td>
            <td class="name-col">${nameCell}</td>
            <td class="visit-col"><span class="visit-badge">${a.visitNumber}회</span></td>
            <td class="symptoms-col">${symptomCell}</td>
        </tr>`;
    }).join('');
}

function scrollToToday(behavior) {
    if (_todayRowIndex < 0) return;
    const rows = document.querySelectorAll('#appt-body tr');
    const target = rows[_todayRowIndex];
    if (!target) return;
    target.scrollIntoView({ behavior: behavior || 'auto', block: 'start' });
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
        // On the very first load only — auto-park the viewport on today.
        // Later refreshes preserve the doctor's current scroll position.
        if (_firstRender) {
            _firstRender = false;
            // Defer past the layout pass so scrollIntoView sees real offsets.
            requestAnimationFrame(() => scrollToToday('auto'));
        }
    } catch (e) {
        console.error(e);
        const msg = (e && e.message) ? e.message : String(e);
        document.getElementById('appt-body').innerHTML =
            `<tr><td colspan="4" class="error">데이터를 불러오지 못했습니다.\n${escapeHtml(msg)}</td></tr>`;
    } finally {
        btn.disabled = false;
    }
}

// ---------- row click → 3D viewer ----------
function onTableClick(e) {
    // Don't hijack the in-row buttons — each handles its own click below.
    if (e.target.closest('.btn-symptom')) return;
    if (e.target.closest('.btn-delete'))  return;
    const tr = e.target.closest('tr');
    if (!tr) return;
    const url = tr.dataset.viewerUrl;
    if (!url) return;     // no diagnosis → row is not clickable
    window.open(url, '_blank', 'noopener');
}

// ---------- delete-an-appointment modal ----------
// The doctor picks between two semantics:
//   * hard  → DELETE the row (physical, irreversible)
//   * soft  → UPDATE status='cancelled' (row stays in DB, hidden by the
//             dashboard's status='confirmed' filter)
// Both are allowed by current RLS on the appointments table (probed
// with insert+delete and patch round-trips before shipping this UI).
const deleteModal = {
    el: null, subtitleEl: null, errEl: null,
    softBtn: null, hardBtn: null, cancelBtn: null, closeBtn: null,
    apptId: '', name: '',
};

function deleteModalInit() {
    deleteModal.el         = document.getElementById('delete-modal');
    deleteModal.subtitleEl = document.getElementById('delete-modal-subtitle');
    deleteModal.errEl      = document.getElementById('delete-modal-error');
    deleteModal.softBtn    = document.getElementById('btn-soft-delete');
    deleteModal.hardBtn    = document.getElementById('btn-hard-delete');
    deleteModal.cancelBtn  = document.getElementById('btn-delete-cancel');
    deleteModal.closeBtn   = document.getElementById('delete-modal-close');

    deleteModal.softBtn.addEventListener('click',   () => performDelete('soft'));
    deleteModal.hardBtn.addEventListener('click',   () => performDelete('hard'));
    deleteModal.cancelBtn.addEventListener('click', closeDeleteModal);
    deleteModal.closeBtn.addEventListener('click',  closeDeleteModal);
    deleteModal.el.addEventListener('click', (e) => {
        if (e.target === deleteModal.el) closeDeleteModal();
    });
}

function openDeleteModal(apptId, name) {
    if (!apptId) return;
    deleteModal.apptId = apptId;
    deleteModal.name = name || '';
    deleteModal.subtitleEl.textContent = deleteModal.name;
    deleteModal.errEl.hidden = true;
    deleteModal.errEl.textContent = '';
    setDeleteButtonsDisabled(false);
    deleteModal.el.hidden = false;
}

function closeDeleteModal() {
    deleteModal.el.hidden = true;
    deleteModal.apptId = '';
}

function setDeleteButtonsDisabled(disabled) {
    [deleteModal.softBtn, deleteModal.hardBtn, deleteModal.cancelBtn]
        .forEach(b => b.disabled = !!disabled);
}

async function performDelete(kind) {
    const apptId = deleteModal.apptId;
    if (!apptId) return;
    setDeleteButtonsDisabled(true);
    // Visual hint that something is happening — the user picked irreversible
    // and we don't want a confusing pause without feedback.
    const targetBtn = kind === 'hard' ? deleteModal.hardBtn : deleteModal.softBtn;
    const originalLabel = targetBtn.textContent;
    targetBtn.textContent = '처리 중…';
    try {
        const client = await initSupabase();
        let error;
        if (kind === 'hard') {
            ({ error } = await client.from('appointments').delete().eq('id', apptId));
        } else {
            ({ error } = await client.from('appointments').update({ status: 'cancelled' }).eq('id', apptId));
        }
        if (error) throw error;
        closeDeleteModal();
        await refresh();
    } catch (e) {
        console.error(e);
        deleteModal.errEl.hidden = false;
        deleteModal.errEl.textContent = '삭제 실패: ' + ((e && e.message) ? e.message : e);
        targetBtn.textContent = originalLabel;
        setDeleteButtonsDisabled(false);
    }
}

// ---------- symptom modal + translation ----------
const modal = {
    el: null, textEl: null, langEl: null, errEl: null,
    subtitleEl: null, translateBtn: null,
    original: '', translated: '', mode: 'original', // 'original' | 'translated'
};

function modalInit() {
    modal.el           = document.getElementById('symptom-modal');
    modal.textEl       = document.getElementById('symptom-modal-text');
    modal.langEl       = document.getElementById('symptom-modal-lang');
    modal.errEl        = document.getElementById('symptom-modal-error');
    modal.subtitleEl   = document.getElementById('symptom-modal-subtitle');
    modal.translateBtn = document.getElementById('btn-translate');

    document.getElementById('symptom-modal-close').addEventListener('click', closeModal);
    modal.el.addEventListener('click', (e) => { if (e.target === modal.el) closeModal(); });
    document.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape') return;
        if (!modal.el.hidden)       closeModal();
        if (!deleteModal.el.hidden) closeDeleteModal();
    });
    modal.translateBtn.addEventListener('click', toggleTranslation);
}

function openModal(symptom, name) {
    modal.original   = symptom;
    modal.translated = '';
    modal.mode       = 'original';
    modal.subtitleEl.textContent = name || '';
    modal.langEl.textContent     = '스페인어 원문';
    modal.textEl.textContent     = symptom;
    modal.errEl.hidden  = true;
    modal.errEl.textContent = '';
    modal.translateBtn.disabled  = false;
    modal.translateBtn.textContent = '🌐 한글 번역';
    modal.el.hidden = false;
}

function closeModal() {
    modal.el.hidden = true;
}

async function toggleTranslation() {
    if (modal.mode === 'translated') {
        // Swap back to original — already cached, no API call.
        modal.mode = 'original';
        modal.langEl.textContent = '스페인어 원문';
        modal.textEl.textContent = modal.original;
        modal.translateBtn.textContent = '🌐 한글 번역';
        modal.errEl.hidden = true;
        return;
    }
    // mode === 'original' → translate
    if (modal.translated) {
        // Translation already fetched once in this open session — reuse.
        modal.mode = 'translated';
        modal.langEl.textContent = '한국어 번역';
        modal.textEl.textContent = modal.translated;
        modal.translateBtn.textContent = '🔁 원문 보기';
        return;
    }

    modal.translateBtn.disabled = true;
    modal.translateBtn.textContent = '번역 중…';
    modal.errEl.hidden = true;
    try {
        const resp = await fetch('/api/translate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: modal.original }),
        });
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);
        modal.translated = (data.translation || '').trim();
        if (!modal.translated) throw new Error('빈 번역 응답');

        modal.mode = 'translated';
        modal.langEl.textContent = '한국어 번역';
        modal.textEl.textContent = modal.translated;
        modal.translateBtn.disabled = false;
        modal.translateBtn.textContent = '🔁 원문 보기';
    } catch (e) {
        modal.errEl.hidden = false;
        modal.errEl.textContent = '번역 실패: ' + (e.message || e);
        modal.translateBtn.disabled = false;
        modal.translateBtn.textContent = '🌐 한글 번역';
    }
}

// ---------- init ----------
document.addEventListener('DOMContentLoaded', () => {
    tickClock();
    setInterval(tickClock, 1000);
    modalInit();
    deleteModalInit();

    document.getElementById('btn-refresh').addEventListener('click', refresh);
    document.getElementById('btn-today').addEventListener('click', () => scrollToToday('smooth'));

    // Delegated click handlers on the table body.
    const tbody = document.getElementById('appt-body');
    tbody.addEventListener('click', onTableClick);
    tbody.addEventListener('click', (e) => {
        const btn = e.target.closest('.btn-symptom');
        if (!btn) return;
        e.stopPropagation();
        openModal(btn.dataset.symptom || '', btn.dataset.name || '');
    });
    tbody.addEventListener('click', (e) => {
        const btn = e.target.closest('.btn-delete');
        if (!btn) return;
        e.stopPropagation();
        openDeleteModal(btn.dataset.apptId || '', btn.dataset.name || '');
    });

    refresh();
    setInterval(refresh, REFRESH_INTERVAL_MS);
});
