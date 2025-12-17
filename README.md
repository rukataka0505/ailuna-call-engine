# ailuna-call-engine（最新版 / 2025-12-17）

AiLuna の **電話応答エンジン**です。  
Twilio Media Streams の音声を OpenAI Realtime API にブリッジし、通話ログを Supabase に保存します。

---

## 1. 主要技術
- Node.js / TypeScript
- Express
- WebSocket（Twilio Media Streams / OpenAI Realtime）
- Supabase（Service Role Keyで書き込み）
- Stripe（従量課金を使う場合：usage record）

---

## 2. 必須の環境変数（.env）
`.env.example` をコピーして作成してください。

```bash
PORT=3100
PUBLIC_URL=https://xxxx.ngrok-free.dev

OPENAI_API_KEY=sk-...
OPENAI_REALTIME_MODEL=gpt-realtime  # 実際に使用するmodel名
OPENAI_MODEL_MINI=gpt-5-mini

LOG_DIR=call_logs

SUPABASE_URL=https://xxxx.supabase.co
SUPABASE_SERVICE_ROLE_KEY=xxxx

# Stripe（通話時間のusage recordを使う場合）
STRIPE_SECRET_KEY=sk_test_...
STRIPE_USAGE_PRICE_ID=price_...

# Twilio（現状コードでは署名検証などに未使用だが、将来用）
TWILIO_ACCOUNT_SID=AC...
TWILIO_AUTH_TOKEN=...
```

---

## 3. 起動方法
```bash
npm install
npm run dev
```

---

## 4. Twilio設定
Twilio Voice Number の Webhook を以下に設定します（POST）：

- `https://<PUBLIC_URL>/incoming-call-realtime`

---

## 5. エンドポイント
- `POST /incoming-call-realtime`  
  Twilio に TwiML を返し、`/twilio-media` へ音声Streamさせます。

- `WS /twilio-media`  
  Twilio Media Streams のWebSocket接続を受け付けます。

---

## 6. Supabaseに保存される内容
- `call_logs`
  - `call_sid`
  - `caller_number`
  - `recipient_number`
  - `transcript`（jsonb）
  - `summary`（要約）
  - `duration_seconds`

---

## 7. 重要な注意（仕様/バグ）
### 7.1 未契約ユーザーの拒否が効かない可能性
`src/realtimeSession.ts` で `is_subscribed` を見て throw していますが、catch で fallback prompt に流れてしまうため、結果として通話が継続する可能性があります。

推奨：
- `/incoming-call-realtime` の時点で `profiles` を参照し、
  - 該当ユーザーなし / is_subscribed=false の場合は `<Hangup/>` で終了（Streamを開始しない）

### 7.2 Stripe Webhook のコードがNext Routeとして同梱されている
`app/api/webhooks/stripe/route.ts` は Next.js の Route Handler 形式ですが、call-engine 本体は Express です。  
このままでは実行されないため、Webhookは **ailuna-web側へ移植**するのが推奨です。

---

## 8. デプロイ（例）
- Cloud Run / Fly.io / ECS など、WebSocketを扱える環境にデプロイしてください。
- `PUBLIC_URL` は外部公開URLに合わせます。

---

## 9. Reservation Logic Stability Work Memo (Phase 0)
**Current Issues**:
- `reservation_requests` can be double-created in a single call.
- `answers` column is mixed (array vs object). Web UI breaks.
- `requested_date`/`time` formats are inconsistent with DB types.
- `call-engine` inserts non-existent `transcription` column.
- Strict `env` checks prevent startup.
- `claim_phone_number` RPC argument mismatch possible.

### Acceptance Criteria
- [ ] 1 call (same `call_sid`) = Max 1 `reservation_requests` record.
- [ ] `answers` is ALWAYS an object (array prohibited).
- [ ] `requested_date` inserted as `YYYY-MM-DD` (date type).
- [ ] `requested_time` inserted as `HH:mm` (time type).
- [ ] Store notifications (Email/LINE) sent exactly once.
- [ ] `transcription` column removed from insert payload.
- [ ] `sms_body_sent` and `sms_sent_at` are properly recorded on approval/rejection.
- [ ] Environment variable validation allows flexible startup.

