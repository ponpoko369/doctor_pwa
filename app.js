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
        .select('id, patient_id, date, time, patients(name, phone, symptoms)')
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

// Cached rows keyed by appointment id so the manage modal can read the
// patient's full record without a second round trip when the doctor
// clicks the 수정 button.
const _rowsById = new Map();

function render({ rows }) {
    const tbody = document.getElementById('appt-body');

    if (!rows || rows.length === 0) {
        tbody.innerHTML = '<tr><td colspan="4" class="empty">표시할 예약이 없습니다.</td></tr>';
        _todayRowIndex = -1;
        return;
    }

    const now = new Date();
    const todayStr = ymd(now);

    // Rebuild the per-id cache so the manage modal can look up rows
    // by appointment id without re-querying Supabase.
    _rowsById.clear();
    rows.forEach(r => _rowsById.set(r.id, r));

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
                 <button type="button" class="btn-manage"
                         data-appt-id="${escapeHtml(a.id)}"
                         data-name="${escapeHtml(name)}"
                         title="수정 / 삭제">✏️</button>
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
    if (e.target.closest('.btn-manage'))  return;
    const tr = e.target.closest('tr');
    if (!tr) return;
    const url = tr.dataset.viewerUrl;
    if (!url) return;     // no diagnosis → row is not clickable
    window.open(url, '_blank', 'noopener');
}

// ---------- manage-appointment modal ----------
// Three actions, all gated by current RLS on appointments/patients
// (probed with insert+delete and PATCH round-trips before shipping):
//   * modify → switch to inline form, save edits to patients + appointments
//   * soft   → UPDATE appointments.status='cancelled' (row stays, hidden by filter)
//   * hard   → DELETE appointments row (irreversible)
const manageModal = {
    el: null, titleEl: null, subtitleEl: null,
    viewChoice: null, viewEdit: null, footerChoice: null, footerEdit: null,
    errChoice: null, errEdit: null,
    softBtn: null, hardBtn: null, modifyBtn: null,
    cancelBtn: null, closeBtn: null, saveBtn: null, backBtn: null,
    nameInput: null, phoneInput: null, symptomsInput: null,
    dateInput: null, timeInput: null,
    apptId: '', patientId: '', name: '',
};

function manageModalInit() {
    manageModal.el           = document.getElementById('manage-modal');
    manageModal.titleEl      = document.getElementById('manage-modal-title');
    manageModal.subtitleEl   = document.getElementById('manage-modal-subtitle');
    manageModal.viewChoice   = document.getElementById('manage-view-choice');
    manageModal.viewEdit     = document.getElementById('manage-view-edit');
    manageModal.footerChoice = document.getElementById('manage-footer-choice');
    manageModal.footerEdit   = document.getElementById('manage-footer-edit');
    manageModal.errChoice    = document.getElementById('manage-modal-error');
    manageModal.errEdit      = document.getElementById('manage-edit-error');
    manageModal.softBtn      = document.getElementById('btn-soft-delete');
    manageModal.hardBtn      = document.getElementById('btn-hard-delete');
    manageModal.modifyBtn    = document.getElementById('btn-modify');
    manageModal.cancelBtn    = document.getElementById('btn-manage-cancel');
    manageModal.closeBtn     = document.getElementById('manage-modal-close');
    manageModal.saveBtn      = document.getElementById('btn-edit-save');
    manageModal.backBtn      = document.getElementById('btn-edit-back');
    manageModal.nameInput     = document.getElementById('edit-name');
    manageModal.phoneInput    = document.getElementById('edit-phone');
    manageModal.symptomsInput = document.getElementById('edit-symptoms');
    manageModal.dateInput     = document.getElementById('edit-date');
    manageModal.timeInput     = document.getElementById('edit-time');

    manageModal.modifyBtn.addEventListener('click', enterEditView);
    manageModal.softBtn.addEventListener('click',   () => performDelete('soft'));
    manageModal.hardBtn.addEventListener('click',   () => performDelete('hard'));
    manageModal.saveBtn.addEventListener('click',   saveEdit);
    manageModal.backBtn.addEventListener('click',   enterChoiceView);
    manageModal.cancelBtn.addEventListener('click', closeManageModal);
    manageModal.closeBtn.addEventListener('click',  closeManageModal);
    manageModal.el.addEventListener('click', (e) => {
        if (e.target === manageModal.el) closeManageModal();
    });
}

function openManageModal(apptId, name) {
    if (!apptId) return;
    const row = _rowsById.get(apptId);
    if (!row) {
        // Row was filtered out / stale — refresh and bail.
        refresh();
        return;
    }
    manageModal.apptId    = apptId;
    manageModal.patientId = row.patient_id;
    manageModal.name      = name || (row.patients && row.patients.name) || '';
    manageModal.subtitleEl.textContent = manageModal.name;

    // Pre-populate the edit form straight from the cached row — the
    // doctor can flip to the edit view without waiting for IO.
    const p = row.patients || {};
    manageModal.nameInput.value     = p.name || '';
    manageModal.phoneInput.value    = p.phone || '';
    manageModal.symptomsInput.value = p.symptoms || '';
    manageModal.dateInput.value     = row.date || '';
    // PostgreSQL "time" comes back as "HH:MM:SS"; <input type=time> wants HH:MM.
    manageModal.timeInput.value     = (row.time || '').slice(0, 5);

    // Always start on the 3-button choice view.
    enterChoiceView();
    setManageButtonsDisabled(false);
    manageModal.el.hidden = false;
}

function closeManageModal() {
    manageModal.el.hidden = true;
    manageModal.apptId = '';
    manageModal.patientId = '';
}

function enterChoiceView() {
    manageModal.titleEl.textContent = '환자 정보 관리';
    manageModal.viewChoice.hidden   = false;
    manageModal.viewEdit.hidden     = true;
    manageModal.footerChoice.hidden = false;
    manageModal.footerEdit.hidden   = true;
    manageModal.errChoice.hidden    = true;
    manageModal.errEdit.hidden      = true;
    // Reset any in-flight button label tweaks.
    manageModal.softBtn.textContent = '📦 보관 후 숨기기';
    manageModal.hardBtn.textContent = '🗑 완전 삭제';
}

function enterEditView() {
    manageModal.titleEl.textContent = '환자 정보 수정';
    manageModal.viewChoice.hidden   = true;
    manageModal.viewEdit.hidden     = false;
    manageModal.footerChoice.hidden = true;
    manageModal.footerEdit.hidden   = false;
    manageModal.errEdit.hidden      = true;
    manageModal.saveBtn.textContent = '💾 저장';
    setManageButtonsDisabled(false);
    // Defer focus until after the layout pass so the input is visible.
    requestAnimationFrame(() => manageModal.nameInput.focus());
}

function setManageButtonsDisabled(disabled) {
    [manageModal.softBtn, manageModal.hardBtn, manageModal.modifyBtn,
     manageModal.cancelBtn, manageModal.saveBtn, manageModal.backBtn]
        .forEach(b => { if (b) b.disabled = !!disabled; });
}

async function performDelete(kind) {
    const apptId = manageModal.apptId;
    if (!apptId) return;
    setManageButtonsDisabled(true);
    const targetBtn = kind === 'hard' ? manageModal.hardBtn : manageModal.softBtn;
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
        closeManageModal();
        await refresh();
    } catch (e) {
        console.error(e);
        manageModal.errChoice.hidden = false;
        manageModal.errChoice.textContent = '실패: ' + ((e && e.message) ? e.message : e);
        targetBtn.textContent = originalLabel;
        setManageButtonsDisabled(false);
    }
}

// Build a minimal PATCH body containing only the fields the doctor
// actually changed. Empty values (phone/symptoms) are still sent as
// empty strings — that's the doctor's signal to clear the field. Name
// can't be cleared because the table query/UI relies on it.
function buildPatientPatch(row) {
    const before = row.patients || {};
    const patch = {};
    const name = manageModal.nameInput.value.trim();
    if (name !== (before.name || ''))               patch.name = name;
    const phone = manageModal.phoneInput.value.trim();
    if (phone !== (before.phone || ''))             patch.phone = phone;
    const symptoms = manageModal.symptomsInput.value;
    if (symptoms !== (before.symptoms || ''))       patch.symptoms = symptoms;
    return patch;
}

function buildApptPatch(row) {
    const patch = {};
    const date = manageModal.dateInput.value;
    if (date && date !== row.date)                  patch.date = date;
    const time = manageModal.timeInput.value;       // "HH:MM"
    const beforeTime = (row.time || '').slice(0, 5);
    if (time && time !== beforeTime) {
        // Postgres "time" accepts HH:MM:SS; pad seconds so we round-trip
        // cleanly with what the booking PWA writes.
        patch.time = time.length === 5 ? `${time}:00` : time;
    }
    return patch;
}

async function saveEdit() {
    const apptId    = manageModal.apptId;
    const patientId = manageModal.patientId;
    if (!apptId || !patientId) return;

    const row = _rowsById.get(apptId);
    if (!row) {
        manageModal.errEdit.hidden = false;
        manageModal.errEdit.textContent = '예약 정보가 만료되었습니다. 새로고침 후 다시 시도하세요.';
        return;
    }

    if (!manageModal.nameInput.value.trim()) {
        manageModal.errEdit.hidden = false;
        manageModal.errEdit.textContent = '이름은 비울 수 없습니다.';
        manageModal.nameInput.focus();
        return;
    }

    const patientPatch = buildPatientPatch(row);
    const apptPatch    = buildApptPatch(row);
    if (Object.keys(patientPatch).length === 0 && Object.keys(apptPatch).length === 0) {
        // Nothing actually changed — close without a no-op write.
        closeManageModal();
        return;
    }

    setManageButtonsDisabled(true);
    manageModal.saveBtn.textContent = '저장 중…';
    try {
        const client = await initSupabase();
        const tasks = [];
        if (Object.keys(patientPatch).length > 0) {
            tasks.push(client.from('patients').update(patientPatch).eq('id', patientId));
        }
        if (Object.keys(apptPatch).length > 0) {
            tasks.push(client.from('appointments').update(apptPatch).eq('id', apptId));
        }
        const results = await Promise.all(tasks);
        for (const r of results) {
            if (r.error) throw r.error;
        }
        closeManageModal();
        await refresh();
    } catch (e) {
        console.error(e);
        manageModal.errEdit.hidden = false;
        manageModal.errEdit.textContent = '저장 실패: ' + ((e && e.message) ? e.message : e);
        manageModal.saveBtn.textContent = '💾 저장';
        setManageButtonsDisabled(false);
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
        if (!manageModal.el.hidden) closeManageModal();
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
    manageModalInit();

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
        const btn = e.target.closest('.btn-manage');
        if (!btn) return;
        e.stopPropagation();
        openManageModal(btn.dataset.apptId || '', btn.dataset.name || '');
    });

    refresh();
    setInterval(refresh, REFRESH_INTERVAL_MS);
});
