import dotenv from 'dotenv';
import path from 'path';
import crypto from 'crypto';

dotenv.config();


const requiredEnv = (key: string, defaultValue?: string): string => {
  const value = process.env[key] ?? defaultValue;
  if (!value) {
    throw new Error(`Environment variable ${key} is required`);
  }
  return value;
};

const optionalEnv = (key: string, defaultValue?: string): string | undefined => {
  return process.env[key] || defaultValue;
};

export const config = {
  // PORT: Cloud Run が自動的に注入する環境変数を優先
  // ローカル開発時は未設定の場合のみ 3100 にフォールバック
  port: parseInt(requiredEnv('PORT', '3100'), 10),
  publicUrl: requiredEnv('PUBLIC_URL'), // Required for callback URLs
  webAppUrl: requiredEnv('WEB_APP_URL'), // Required for dashboard link
  openAiApiKey: requiredEnv('OPENAI_API_KEY'),
  openAiRealtimeModel: requiredEnv('OPENAI_REALTIME_MODEL', 'gpt-realtime'),
  openAiSummaryModel: requiredEnv('OPENAI_MODEL_MINI', 'gpt-5-mini'),
  openAiRealtimeVoice: requiredEnv('OPENAI_REALTIME_VOICE', 'alloy'),
  logDir: requiredEnv('LOG_DIR', path.join(process.cwd(), 'call_logs')),
  twilioAuthToken: requiredEnv('TWILIO_AUTH_TOKEN', ''), // Used? If empty, make sure it doesn't break unless used. Kept as required-ish with default empty for now if code depends on it being string.
  twilioAccountSid: requiredEnv('TWILIO_ACCOUNT_SID', ''),
  supabaseUrl: requiredEnv('SUPABASE_URL'),
  supabaseServiceRoleKey: requiredEnv('SUPABASE_SERVICE_ROLE_KEY'),

  // Optional / Future
  stripeSecretKey: optionalEnv('STRIPE_SECRET_KEY'),
  stripeUsagePriceId: optionalEnv('STRIPE_USAGE_PRICE_ID'),

  // Notification (Email / LINE) - All Optional
  smtpHost: optionalEnv('SMTP_HOST'),
  smtpPort: parseInt(optionalEnv('SMTP_PORT', '587')!, 10),
  smtpUser: optionalEnv('SMTP_USER'),
  smtpPass: optionalEnv('SMTP_PASS'),
  emailFrom: optionalEnv('EMAIL_FROM'),

  lineChannelAccessToken: optionalEnv('LINE_CHANNEL_ACCESS_TOKEN'),
  lineChannelSecret: optionalEnv('LINE_CHANNEL_SECRET'),


  // Debug Observability Flags (default OFF)
  debugRealtimeEvents: optionalEnv('DEBUG_REALTIME_EVENTS') === '1',
  debugTwilioMedia: optionalEnv('DEBUG_TWILIO_MEDIA') === '1',
  debugMediaSamples: parseInt(optionalEnv('DEBUG_MEDIA_SAMPLES', '5')!, 10),
  debugRealtimeSummaryIntervalMs: parseInt(optionalEnv('DEBUG_REALTIME_SUMMARY_INTERVAL_MS', '5000')!, 10),
  debugTiming: optionalEnv('DEBUG_TIMING') === '1',
  debugMarkEvents: optionalEnv('DEBUG_MARK_EVENTS') === '1',

  // Feature Flags (Rollback Switches) - default ON
  enableBase64Passthrough: optionalEnv('ENABLE_BASE64_PASSTHROUGH', '1') === '1',
  enableSmartCancel: optionalEnv('ENABLE_SMART_CANCEL', '1') === '1',

  // VAD tuning (lower = faster response, but more interruptions)
  vadThreshold: parseFloat(optionalEnv('VAD_THRESHOLD', '0.8')!),
  vadSilenceDurationMs: parseInt(optionalEnv('VAD_SILENCE_DURATION_MS', '700')!, 10),

  // Barge-in debounce settings (noise filtering)
  bargeInDebounceMs: parseInt(optionalEnv('BARGE_IN_DEBOUNCE_MS', '1000')!, 10),
  bargeInMinRemainMs: parseInt(optionalEnv('BARGE_IN_MIN_REMAIN_MS', '2000')!, 10),

  // Web Demo Authentication
  webDemoSharedSecret: optionalEnv('WEB_DEMO_SHARED_SECRET'),
  webDemoTokenExpirySeconds: parseInt(optionalEnv('WEB_DEMO_TOKEN_EXPIRY_SECONDS', '300')!, 10),
  webDemoMaxSessionMinutes: parseInt(optionalEnv('WEB_DEMO_MAX_SESSION_MINUTES', '5')!, 10),
};

type Config = typeof config;
export type ConfigKey = keyof Config;

// Startup debug: Log sha256 of WEB_DEMO_SHARED_SECRET for env mismatch debugging (never log actual secret)
const secret = config.webDemoSharedSecret ?? '';
const secretHash = crypto.createHash('sha256').update(secret, 'utf8').digest('hex');
console.log(`WEB_DEMO_SHARED_SECRET sha256=${secretHash} len=${secret.length}`);
