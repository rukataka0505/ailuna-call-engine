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
  port: parseInt(requiredEnv('PORT', '3000'), 10),
  publicUrl: requiredEnv('PUBLIC_URL'),
  openAiApiKey: requiredEnv('OPENAI_API_KEY'),
  openAiRealtimeModel: requiredEnv('OPENAI_REALTIME_MODEL', 'gpt-realtime'),
  openAiRealtimeSystemPrompt: requiredEnv('OPENAI_REALTIME_SYSTEM_PROMPT'),
  logDir: requiredEnv('LOG_DIR', path.join(process.cwd(), 'call_logs')),
  twilioAuthToken: requiredEnv('TWILIO_AUTH_TOKEN', ''),
  twilioAccountSid: requiredEnv('TWILIO_ACCOUNT_SID', ''),
  supabaseUrl: requiredEnv('SUPABASE_URL', ''),
  supabaseServiceRoleKey: requiredEnv('SUPABASE_SERVICE_ROLE_KEY', ''),
};

type Config = typeof config;
export type ConfigKey = keyof Config;
