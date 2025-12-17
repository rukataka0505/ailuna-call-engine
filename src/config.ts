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

export const config = {
  // PORT: Cloud Run が自動的に注入する環境変数を優先
  // ローカル開発時は未設定の場合のみ 3100 にフォールバック
  port: parseInt(requiredEnv('PORT', '3100'), 10),
  publicUrl: requiredEnv('PUBLIC_URL'),
  webAppUrl: requiredEnv('WEB_APP_URL'),
  openAiApiKey: requiredEnv('OPENAI_API_KEY'),
  openAiRealtimeModel: requiredEnv('OPENAI_REALTIME_MODEL', 'OPENAI_REALTIME'),
  openAiSummaryModel: requiredEnv('OPENAI_MODEL_MINI', 'gpt-5-mini'),
  logDir: requiredEnv('LOG_DIR', path.join(process.cwd(), 'call_logs')),
  twilioAuthToken: requiredEnv('TWILIO_AUTH_TOKEN', ''),
  twilioAccountSid: requiredEnv('TWILIO_ACCOUNT_SID', ''),
  supabaseUrl: requiredEnv('SUPABASE_URL', ''),
  supabaseServiceRoleKey: requiredEnv('SUPABASE_SERVICE_ROLE_KEY', ''),
  stripeSecretKey: requiredEnv('STRIPE_SECRET_KEY'),
  stripeUsagePriceId: requiredEnv('STRIPE_USAGE_PRICE_ID'),

  // Notification (Email / LINE)
  smtpHost: requiredEnv('SMTP_HOST', ''),
  smtpPort: parseInt(requiredEnv('SMTP_PORT', '587'), 10),
  smtpUser: requiredEnv('SMTP_USER', ''),
  smtpPass: requiredEnv('SMTP_PASS', ''),
  emailFrom: requiredEnv('EMAIL_FROM', ''),

  lineChannelAccessToken: requiredEnv('LINE_CHANNEL_ACCESS_TOKEN', ''),
  lineChannelSecret: requiredEnv('LINE_CHANNEL_SECRET', ''),
};

type Config = typeof config;
export type ConfigKey = keyof Config;
