-- Add duration_seconds column to call_logs table
ALTER TABLE public.call_logs ADD COLUMN duration_seconds INTEGER DEFAULT 0;

-- Comment on the column
COMMENT ON COLUMN public.call_logs.duration_seconds IS 'Duration of the call in seconds';
