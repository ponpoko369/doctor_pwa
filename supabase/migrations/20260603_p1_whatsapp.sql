-- ============================================================================
-- P1: WhatsApp 봇용 최소 스키마
--   - conversations: 환자별 현재 대화 상태 (1 row per phone, state machine)
--   - messages:      모든 in/out 메시지 로그 (감사 + 멀티턴 컨텍스트 재구성)
--
-- doctors / visit_notes / appointments 컬럼 확장은 P3에서.
-- 두 테이블 모두 service_role 전용 — anon 키로는 접근 불가.
-- ============================================================================

-- 1) conversations -----------------------------------------------------------
create table if not exists conversations (
  id uuid primary key default gen_random_uuid(),
  patient_phone text not null unique,         -- WhatsApp wa_id (E.164 without '+')
  patient_id uuid references patients(id) on delete set null,
  state text not null default 'idle'
    check (state in ('idle','identifying','triage','booking','confirmed')),
  context jsonb not null default '{}'::jsonb, -- 누적 증상 슬롯·유도질문 답변
  last_message_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists conversations_patient_id_idx
  on conversations(patient_id);

create index if not exists conversations_state_idx
  on conversations(state) where state <> 'idle';

-- updated_at 자동 갱신
create or replace function set_updated_at() returns trigger as $$
begin
  new.updated_at := now();
  return new;
end $$ language plpgsql;

drop trigger if exists conversations_set_updated_at on conversations;
create trigger conversations_set_updated_at
  before update on conversations
  for each row execute function set_updated_at();

-- 2) messages ----------------------------------------------------------------
create table if not exists messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references conversations(id) on delete cascade,
  direction text not null check (direction in ('in','out')),
  content text not null,
  wa_message_id text,                          -- Meta 메시지 id (idempotency)
  meta jsonb not null default '{}'::jsonb,     -- raw payload, tool_calls 등
  created_at timestamptz not null default now()
);

-- 인바운드 중복 차단 (Meta가 같은 메시지를 재시도해도 한 번만 처리)
create unique index if not exists messages_wa_message_id_uniq
  on messages(wa_message_id) where wa_message_id is not null;

create index if not exists messages_conversation_id_created_at_idx
  on messages(conversation_id, created_at desc);

-- 3) RLS ---------------------------------------------------------------------
-- 둘 다 RLS 켜고 정책은 추가 안 함 → anon/authenticated 모두 차단.
-- 서버 사이드(MCP, 웹훅)는 service_role 키를 쓰므로 RLS 우회됨.
alter table conversations enable row level security;
alter table messages enable row level security;

-- (확인용) 어떤 정책도 없음을 명시:
-- create policy ... 절을 일부러 추가하지 않음.
