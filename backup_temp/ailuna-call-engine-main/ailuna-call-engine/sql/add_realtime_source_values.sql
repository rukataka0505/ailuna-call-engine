-- Migration: Add new source values to reservation_requests_source_check constraint
-- Run this in Supabase SQL Editor

-- Step 1: Drop the existing constraint
ALTER TABLE reservation_requests 
DROP CONSTRAINT IF EXISTS reservation_requests_source_check;

-- Step 2: Re-create with new allowed values
-- (Preserving existing values and adding new ones)
ALTER TABLE reservation_requests
ADD CONSTRAINT reservation_requests_source_check
CHECK (source IN (
  'phone_call',
  'phone_call_realtime_tool',
  'phone_call_realtime_fallback',
  'web_form',
  'manual'
));

-- Note: Adjust the list above if your existing constraint has different values
-- Run: SELECT constraint_name, check_clause FROM information_schema.check_constraints 
--      WHERE table_name = 'reservation_requests';
-- to see current allowed values before running this migration.
