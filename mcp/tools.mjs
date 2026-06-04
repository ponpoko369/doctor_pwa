// MCP tool definitions for the Clinica bot.
//
// Each tool has:
//   - JSON-Schema `inputSchema` (Anthropic's MCP connector passes these to Claude)
//   - `handler(args)` returning a JS value; the transport wraps it as
//     content: [{type: 'text', text: JSON.stringify(...)}].
//
// Tools are scoped down to what P2 needs: triage + booking. Doctors and
// follow-ups land in P3 alongside the schema for those.

import {
    findPatientByPhone,
    registerPatient,
    listAvailableSlots,
    createAppointment,
    listPatientAppointments,
    appendSymptomNote,
} from '../lib/db.mjs';

export const TOOLS = [
    {
        name: 'find_patient_by_phone',
        description:
            'Look up an existing patient by their phone number (WhatsApp wa_id, '
            + 'digits only, no plus sign). Returns the patient record or null. '
            + 'Use this only if you need to re-confirm the phone — the webhook '
            + 'already passes the identified patient_id in the conversation context.',
        inputSchema: {
            type: 'object',
            properties: {
                phone: { type: 'string', description: 'wa_id format, e.g. "521552123456"' },
            },
            required: ['phone'],
        },
        handler: async ({ phone }) => {
            const p = await findPatientByPhone(String(phone));
            return p ? { found: true, patient: p } : { found: false };
        },
    },

    {
        name: 'register_patient',
        description:
            'Register a brand-new patient. Use only when the patient is not in '
            + 'the database AND you have collected their full name.',
        inputSchema: {
            type: 'object',
            properties: {
                phone: { type: 'string' },
                name: { type: 'string', description: 'Patient full name in natural form' },
            },
            required: ['phone', 'name'],
        },
        handler: async ({ phone, name }) => {
            const p = await registerPatient(String(phone), String(name));
            return { ok: true, patient: p };
        },
    },

    {
        name: 'list_available_slots',
        description:
            'List free 1-hour appointment slots in a date range. Clinic hours '
            + 'are 09:00-20:00 every day. Returns up to 14 days of slots, with '
            + 'already-booked times excluded. Use this BEFORE proposing times '
            + 'to the patient — never invent slots.',
        inputSchema: {
            type: 'object',
            properties: {
                date_from: { type: 'string', description: 'YYYY-MM-DD (inclusive)' },
                date_to: { type: 'string', description: 'YYYY-MM-DD (inclusive)' },
            },
            required: ['date_from', 'date_to'],
        },
        handler: async ({ date_from, date_to }) => {
            const slots = await listAvailableSlots(String(date_from), String(date_to));
            return { slots, count: slots.length };
        },
    },

    {
        name: 'create_appointment',
        description:
            'Book the appointment. Only call this AFTER the patient has '
            + 'explicitly confirmed both date and time you proposed. '
            + 'Returns the created appointment record.',
        inputSchema: {
            type: 'object',
            properties: {
                patient_id: { type: 'string', description: 'UUID from the patient record' },
                date: { type: 'string', description: 'YYYY-MM-DD' },
                time: { type: 'string', description: 'HH:MM in 24h (e.g. "14:00")' },
            },
            required: ['patient_id', 'date', 'time'],
        },
        handler: async ({ patient_id, date, time }) => {
            const appt = await createAppointment(
                String(patient_id),
                String(date),
                String(time),
            );
            return { ok: true, appointment: appt };
        },
    },

    {
        name: 'list_patient_appointments',
        description:
            "List the patient's existing confirmed appointments. Default to "
            + 'upcoming-only. Use when the patient asks "what do I have booked?" '
            + 'or before suggesting a new slot, to avoid double-booking the '
            + 'same person on the same day.',
        inputSchema: {
            type: 'object',
            properties: {
                patient_id: { type: 'string' },
                only_upcoming: { type: 'boolean', default: true },
            },
            required: ['patient_id'],
        },
        handler: async ({ patient_id, only_upcoming = true }) => {
            const rows = await listPatientAppointments(
                String(patient_id),
                Boolean(only_upcoming),
            );
            return { appointments: rows, count: rows.length };
        },
    },

    {
        name: 'append_symptom_note',
        description:
            "Record a short triage summary to the patient's medical record. "
            + 'Call this once you have enough triage info — typically right '
            + 'before creating the appointment. Note should be 1-2 sentences in '
            + 'Spanish, clinical-style.',
        inputSchema: {
            type: 'object',
            properties: {
                patient_id: { type: 'string' },
                note: { type: 'string' },
            },
            required: ['patient_id', 'note'],
        },
        handler: async ({ patient_id, note }) => {
            await appendSymptomNote(String(patient_id), String(note));
            return { ok: true };
        },
    },
];

// Lookup map for transport-layer dispatch.
export const TOOL_INDEX = Object.fromEntries(TOOLS.map((t) => [t.name, t]));
