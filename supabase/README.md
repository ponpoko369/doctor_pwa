# Supabase migrations

기존 `clinica_app` 백엔드(`cojzdjajwrzzyqxzljgq.supabase.co`)에 적용할 SQL.

## 적용 방법

1. https://supabase.com/dashboard/project/cojzdjajwrzzyqxzljgq/sql
2. 새 쿼리 탭에서 `migrations/20260603_p1_whatsapp.sql` 내용 붙여넣기
3. **Run**
4. 좌측 **Table Editor** 에서 `conversations`, `messages` 두 테이블이 생겼는지 확인

## P1 마이그레이션 무엇이 들어 있나

- `conversations` — phone당 1행, 현재 상태머신(`idle/identifying/triage/booking/confirmed`)과 누적 컨텍스트 보관
- `messages` — 모든 in/out 메시지, `wa_message_id` 유니크 인덱스로 Meta 재시도 멱등성

## 다음 마이그레이션 (P3에서 실행 예정)

- `doctors`, `visit_notes` 추가
- `appointments`에 `doctor_id`, `reason`, `source` 컬럼 추가

## 권한

두 테이블 모두 **RLS 켜져 있고 정책 없음** → anon 키로는 0행만 보임.
WhatsApp 봇/MCP 서버는 `SUPABASE_SERVICE_ROLE_KEY`로 접근 (RLS 우회).

서비스 롤 키 위치: Supabase Dashboard → Settings → API → `service_role` `secret`.
**절대 클라이언트 코드/Git에 커밋 금지**, Vercel 환경변수에만.
