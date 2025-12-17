import dotenv from 'dotenv';
import path from 'path';

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
  openAiRealtimeModel: requiredEnv('OPENAI_REALTIME_MODEL', 'gpt-4o-realtime-preview-2024-10-01'),
  openAiSummaryModel: requiredEnv('OPENAI_MODEL_MINI', 'gpt-4o-mini'),
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
};

type Config = typeof config;
export type ConfigKey = keyof Config;
