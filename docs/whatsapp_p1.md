# WhatsApp 봇 P1 — 배포·테스트 절차

`api/whatsapp.js` 가 활성화되는 데 필요한 인프라 셋업 순서.

---

## 0. Supabase 마이그레이션 실행

이미 안 했다면:

1. https://supabase.com/dashboard/project/cojzdjajwrzzyqxzljgq/sql
2. `supabase/migrations/20260603_p1_whatsapp.sql` 내용 붙여넣고 **Run**
3. Table Editor 에서 `conversations`, `messages` 두 테이블 확인

## 1. Vercel 환경변수 등록

Vercel 프로젝트 (doctor_pwa) → **Settings → Environment Variables**.

| Key | Value 출처 | Environment |
|---|---|---|
| `WA_PHONE_NUMBER_ID` | Meta API Setup → Phone number ID | Production + Preview |
| `WA_ACCESS_TOKEN` | Meta API Setup → Temporary token (24h) | Production + Preview |
| `WA_APP_SECRET` | Meta App settings → Basic → App secret "Show" | Production + Preview |
| `WA_VERIFY_TOKEN` | 본인이 정한 임의 문자열 (예: `clinica_demo_2026_xyz`) | Production + Preview |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase Settings → API → service_role secret | Production + Preview |
| `SUPABASE_URL` | (선택, 기본값 코드 안에) | — |
| `ANTHROPIC_API_KEY` | (기존 translate.js용 이미 있음) | — |

저장 후 **Deployments → Redeploy** 또는 다음 푸시로 반영.

## 2. Meta 웹훅 등록

1. Meta App Dashboard → **WhatsApp → Configuration → Webhook** → **Edit**
2. **Callback URL**: `https://doctorpwa.vercel.app/api/whatsapp`
3. **Verify token**: 위 `WA_VERIFY_TOKEN` 과 **완전히 동일**
4. **Verify and save** → 초록 체크 뜨면 성공 (= GET 핸들러가 challenge를 그대로 반환했다는 뜻)
5. 같은 페이지 하단 **Webhook fields** → `messages` 옆 **Subscribe**

> verify 실패 시 점검 순서:
> 1. Vercel 환경변수가 prod 환경에 박혔는지 (Preview만 박힌 채로 prod URL 호출하는 실수 잦음)
> 2. Vercel 배포가 새 env 반영 후 됐는지 (Redeploy 필요)
> 3. URL 끝에 슬래시 없음 확인
> 4. `https://doctorpwa.vercel.app/api/whatsapp?hub.mode=subscribe&hub.verify_token=YOUR_TOKEN&hub.challenge=test` 를 브라우저에 직접 쳐서 `test` 가 그대로 보이는지 확인

## 3. End-to-end 테스트

### 3.1 신규 환자 시나리오
1. Meta API Setup → "To" 셀렉터에서 본인 WhatsApp 번호 추가/선택 (테스트 번호는 화이트리스트만 허용)
2. WhatsApp 앱에서 본인의 테스트 번호로 `hola` 전송
3. 봇이 `Hola 👋, soy el asistente de la Clínica. Veo que es tu primera vez por aquí. ¿Cómo te llamas?` 로 응답
4. `María López` 처럼 이름 입력
5. 봇이 `Mucho gusto, María López 👋. Ya estás registrado/a...` 로 응답

### 3.2 데이터 확인
Supabase SQL Editor:
```sql
select * from patients order by created_at desc limit 5;
select * from conversations order by last_message_at desc limit 5;
select direction, content, created_at from messages
  order by created_at desc limit 20;
```

### 3.3 기존 환자 시나리오
이미 `patients` 테이블에 본인 번호가 있으면 (예: clinica_app 으로 사전 등록), 첫 메시지에 바로 이름으로 인사함.

### 3.4 멱등성 확인
같은 `wa_message_id` 가 두 번 들어와도 (Meta가 5초 안에 200 못 받으면 재시도) `messages` 의 unique 인덱스가 두 번째를 거절 → 봇이 응답을 두 번 보내지 않음. 로그에 `[wa] dup ... — skip` 한 줄.

## 4. 로컬 디버깅

```powershell
# Vercel CLI 로컬 실행 (vercel dev)
npx vercel dev

# 다른 터미널에서 ngrok 같은 걸로 외부 노출
ngrok http 3000

# Meta Webhook Callback URL 을 ngrok URL 로 임시 변경
```

> 빠르게 GET handshake만 확인하려면:
> ```powershell
> curl "http://localhost:3000/api/whatsapp?hub.mode=subscribe&hub.verify_token=clinica_demo_2026_xyz&hub.challenge=test"
> ```
> → `test` 가 돌아오면 GET OK.

## 5. P1 의도적으로 안 한 것

다음 단계(P2)에서 추가됨:
- Claude 호출 (지금은 결정론적 if/else 답장만)
- 증상 triage 유도질문
- 슬롯 제시 + 예약 생성
- MCP 서버 도구화

## 6. 보안 주의

- `WA_ACCESS_TOKEN` 은 **24시간 임시 토큰**. P2 들어가기 전 영구 토큰으로 교체:
  Meta Business Manager → **Users → System Users** → 새 시스템 사용자 생성 → WhatsApp 자산 권한 부여 → **Generate Token** → expiration `Never`
- 시크릿이 실수로 Git 에 들어가면 즉시 Meta App settings 에서 **Reset** + Supabase 키 재발급
- `WA_APP_SECRET` 노출 = 누구나 우리 봇한테 가짜 메시지 주입 가능 → HMAC 무력화
