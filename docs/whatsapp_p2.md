# WhatsApp 봇 P2 — Claude + MCP 연동

P1(echo + 환자 식별)에 이어 **증상 triage → 슬롯 제안 → 예약 확정** 까지.

---

## 아키텍처

```
환자 WhatsApp
  │
  ▼ POST
api/whatsapp.js (Edge)
  │ HMAC verify, persist message
  │ patient_id 확인 (없으면 P1 식별 흐름)
  │
  ▼ identified
lib/handle.mjs → lib/claude.mjs
  │ Anthropic Messages API + mcp_servers 커넥터
  │
  ▼
Anthropic (server-side tool loop)
  │ tools/list, tools/call
  │
  ▼ POST + Authorization: Bearer <MCP_AUTH_TOKEN>
api/mcp.js (Edge, 같은 Vercel 프로젝트)
  │ JSON-RPC 2.0
  │
  ▼
lib/db.mjs → Supabase (service_role)
```

핵심: webhook 코드는 tool-use 루프를 안 본다. Anthropic이 우리 MCP를 직접 호출하고, 최종 텍스트만 우리한테 돌려줌.

---

## 새로 추가된 파일

| 파일 | 역할 |
|---|---|
| `mcp/tools.mjs` | 6개 MCP 도구 정의 + 구현 (find/register patient, list_available_slots, create_appointment, list_patient_appointments, append_symptom_note) |
| `api/mcp.js` | Edge MCP HTTP 서버 (JSON-RPC 2.0, Bearer auth) |
| `lib/claude.mjs` | Anthropic API 래퍼 + 시스템 프롬프트 + 대화 히스토리 |

`lib/db.mjs` 도 확장됨: `listAvailableSlots`, `createAppointment`, `listPatientAppointments`, `appendSymptomNote`, `listConversationMessages`.

`lib/handle.mjs` 가 식별 후 Claude로 dispatch 하도록 교체됨.

---

## 새로 필요한 환경변수

| 키 | 값 | 발급/생성 |
|---|---|---|
| `CLINICA_MCP_URL` | `https://doctorpwa.vercel.app/api/mcp` | 배포 URL 기준 (preview에서 테스트하면 preview URL) |
| `MCP_AUTH_TOKEN` | 임의의 32바이트+ 시크릿 | `openssl rand -base64 32` 또는 본인이 생성 |

> ⚠️ `MCP_AUTH_TOKEN` 이 없거나 빈 문자열이면 `/api/mcp` 가 **fail-closed**: 모든 요청을 401로 거절. 이 secret이 누설되면 누구나 환자 DB에 접근 가능 (service_role 키 뒤편이라), 절대 채팅/Git에 노출 금지.

Vercel 환경변수에 두 키 추가 → Production + Preview + Development 셋 다 체크 → Save → **Redeploy**.

---

## 영구 액세스 토큰 교체 (선행 작업)

P2 시작 전에 `WA_ACCESS_TOKEN` 을 System User 영구 토큰으로 교체해야 합니다 — 24시간 임시 토큰은 곧 만료됨. 절차는 `whatsapp_p1.md` §6 참조.

---

## Anthropic 베타 헤더

`lib/claude.mjs` 가 `anthropic-beta: mcp-client-2025-11-20` 을 자동으로 붙입니다. SDK 없이 raw fetch로 호출하므로 별도 작업 필요 없음.

---

## E2E 테스트 시나리오

### 1. 신규 환자 → 예약 완주

WhatsApp 본인 폰에서 새 번호로 첫 메시지:

```
> hola
< Hola 👋, soy el asistente de la Clínica. Veo que es tu primera vez por aquí. ¿Cómo te llamas?
> Carlos Ramírez
< Mucho gusto, Carlos 👋. Cuéntame qué te trae por aquí — ¿algún síntoma o quieres agendar una cita?
> Me duele la cabeza desde ayer
< (Claude) ¿Qué tan intenso, de 1 a 10? ¿Tienes fiebre o vómito?
> 7. No tengo fiebre
< (Claude llama list_available_slots) Tengo disponibles: martes 9 de junio 10:00, 14:00, o miércoles 10 a las 11:00. ¿Cuál te queda mejor?
> el martes 10 am
< (Claude llama create_appointment + append_symptom_note) ✅ Te confirmo: martes 9 de junio, 10:00. Motivo: cefalea moderada de 2 días. Te esperamos en la clínica.
```

### 2. 데이터 확인

Supabase SQL Editor:

```sql
-- 신규 환자가 잘 등록됐는지
select id, name, phone, symptoms
  from patients order by created_at desc limit 3;

-- 예약이 생성됐는지
select date, time, status, created_at
  from appointments order by created_at desc limit 5;

-- 대화 메시지 흐름 (tool calls는 messages에 안 찍힘 — Anthropic side)
select direction, substring(content, 1, 100) as text, created_at
  from messages
  where conversation_id = (select id from conversations
                           where patient_phone = 'YOUR_PHONE_DIGITS')
  order by created_at;
```

기대:
- `patients.symptoms` 에 `[YYYY-MM-DD HH:MM WA] cefalea ...` 한 줄
- `appointments` 에 신규 행 (status='confirmed')
- `messages` 에 user/assistant 교대 메시지들

### 3. clinica_app + doctor_pwa 에서 확인

- **clinica_app** (Flutter): "내 예약 보기" 에서 본인 번호로 조회 → 새 예약 보임
- **doctor_pwa** dashboard: 자동 새로고침(60초) 후 환자 행 등장, 한국어로 증상 번역 표시

> 현재 스키마엔 `source` 컬럼이 없어서 앱/봇 예약 구분 안 됨. P3에서 추가 예정.

---

## 트러블슈팅

| 증상 | 점검 |
|---|---|
| 봇이 답장 안 함 | Vercel Functions Logs → `[wa] claude error ...` 있는지 확인 |
| `Anthropic 401: ... API key` | `ANTHROPIC_API_KEY` 누락 or 잘못됨 |
| `Anthropic 400: ... mcp_servers` | beta 헤더 `mcp-client-2025-11-20` 가 잘 전달되는지, `mcp_servers[].url` 이 공개 HTTPS인지 |
| MCP 호출이 401 | `MCP_AUTH_TOKEN` 이 webhook env와 MCP env 양쪽에 정확히 같은 값으로 박혔는지 |
| Claude가 슬롯을 안 제안하고 추측 | 시스템 프롬프트 규칙 1번 강조 — `lib/claude.mjs` 에서 수정. 거의 안 일어남. |
| 같은 환자에게 두 번 답장 | `wa_message_id` 멱등성 인덱스 동작 확인 (Supabase에서 messages 행 중복 있는지 SELECT) |

### Claude 호출이 너무 오래 걸려서 Meta가 재시도

`api/whatsapp.js` 는 `ctx.waitUntil(work)` 로 백그라운드 dispatch. 5초 안에 200 OK 반환하고 처리는 별도 lifecycle. Meta 재시도 시에는 같은 `wa_message_id` 라서 멱등성 인덱스가 잡음.

triage 시작 첫 턴이 가장 느림 (cold start + system prompt cache miss). 두 번째 턴부터는 cache hit로 빨라짐 — Vercel 로그에서 응답시간 대략 2~5초.

---

## P2 의도적으로 안 한 것 (P3로)

- 의사 모델(`doctors`), 진료과별 라우팅
- `appointments.doctor_id` / `reason` / `source` 컬럼
- 진료 후 follow-up 자동 발송 (Vercel Cron 또는 pg_cron)
- 24시간 윈도우 밖 발송용 템플릿 등록 + 사용
- 다국어 (현재 100% 스페인어)

---

## 비용 메모

Sonnet 4.6, 평균 입력 ~3K tok, 출력 ~150 tok, MCP tool 호출 1-3회:
- Per inbound 메시지: 약 $0.01-0.03 (cache miss 첫 턴은 $0.05까지)
- 100 환자 x 평균 5 메시지 = ~$10-15

cache hit 이 정상 동작하면 두 번째 턴부터 입력 비용 90% 절감. Vercel 로그에서 Anthropic 응답의 `usage.cache_read_input_tokens` 값으로 확인 가능 — `lib/claude.mjs` 에 로깅 한 줄 추가하면 모니터링 쉬워짐 (P3 작업).
