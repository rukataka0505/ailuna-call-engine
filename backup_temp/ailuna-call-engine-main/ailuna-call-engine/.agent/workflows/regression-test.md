---
description: Regression test for call engine changes using ngrok and Twilio
---

# Regression Test Procedure

Test call engine changes by running a manual call through ngrok/Twilio.

## Prerequisites

1. ngrok running and PUBLIC_URL in .env pointing to your tunnel
2. Twilio phone number configured to point to your ngrok URL
3. A working phone to make test calls

## Test Script

// turbo-all

### 1. Start the server

```bash
npm run dev
```

### 2. Make a test call

Call your Twilio number and follow this script:

1. Wait for greeting: "お電話ありがとうございます。ご予約のお電話でしょうか？"
2. Answer: "はい、予約したいです"
3. Provide name: "山田太郎です"
4. Provide date: "明日の19時"
5. Provide party size: "2名です"
6. Confirm: "はい、お願いします"

### 3. Expected Results

- [ ] Greeting plays within 3 seconds
- [ ] AI responds to each input quickly
- [ ] finalize_reservation tool is called
- [ ] Call ends cleanly

### 4. Check Logs

Look for:
- `⏱️ [Timing Summary]` if DEBUG_TIMING=1
- No `response_cancel_not_active` errors
- `✅ Reservation created via tool`

## Rollback Testing

To test rollback switches:

```bash
# Disable base64 passthrough
ENABLE_BASE64_PASSTHROUGH=0 npm run dev

# Disable smart cancel
ENABLE_SMART_CANCEL=0 npm run dev
```
