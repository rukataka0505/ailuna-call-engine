-- Migration: Add summary column to call_logs table
-- This migration adds support for AI-generated call summaries

-- Add summary column if it doesn't exist
ALTER TABLE public.call_logs 
ADD COLUMN IF NOT EXISTS summary text;

-- Optional: Add a comment to document the column
COMMENT ON COLUMN public.call_logs.summary IS '通話内容の要約（40文字以内のタイトル形式、OpenAI APIで自動生成）';
