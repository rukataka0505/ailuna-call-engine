-- ============================================================
-- Phone Number Pool Migration
-- ============================================================
-- Purpose: Manage Twilio phone number inventory and automatic assignment
-- Created: 2025-11-22
-- ============================================================

-- ============================================================
-- 1. Create phone_number_pool table
-- ============================================================
CREATE TABLE IF NOT EXISTS phone_number_pool (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  phone_number TEXT UNIQUE NOT NULL,
  status TEXT NOT NULL DEFAULT 'available' CHECK (status IN ('available', 'assigned')),
  assigned_user_id UUID REFERENCES profiles(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- 2. Create index on status column for fast availability lookup
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_phone_number_pool_status 
  ON phone_number_pool(status);

-- ============================================================
-- 3. Create stored function for atomic phone number assignment
-- ============================================================
CREATE OR REPLACE FUNCTION claim_phone_number(target_user_id UUID)
RETURNS TEXT
LANGUAGE plpgsql
AS $$
DECLARE
  claimed_number TEXT;
BEGIN
  -- Lock and retrieve one available phone number
  -- SKIP LOCKED prevents concurrent transactions from blocking
  SELECT phone_number INTO claimed_number
  FROM phone_number_pool
  WHERE status = 'available'
  ORDER BY created_at ASC  -- FIFO assignment
  LIMIT 1
  FOR UPDATE SKIP LOCKED;

  -- Check if a number was found
  IF claimed_number IS NULL THEN
    RAISE EXCEPTION 'No available phone numbers in pool';
  END IF;

  -- Update the record to mark it as assigned
  UPDATE phone_number_pool
  SET 
    status = 'assigned',
    assigned_user_id = target_user_id,
    updated_at = now()
  WHERE phone_number = claimed_number;

  -- Return the claimed phone number
  RETURN claimed_number;
END;
$$;

-- ============================================================
-- 4. Enable Row Level Security (RLS)
-- ============================================================
ALTER TABLE phone_number_pool ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- 5. RLS Policies: Service Role Only
-- ============================================================
-- Drop existing policies if they exist
DROP POLICY IF EXISTS "Service role can read phone_number_pool" ON phone_number_pool;
DROP POLICY IF EXISTS "Service role can insert phone_number_pool" ON phone_number_pool;
DROP POLICY IF EXISTS "Service role can update phone_number_pool" ON phone_number_pool;
DROP POLICY IF EXISTS "Service role can delete phone_number_pool" ON phone_number_pool;

-- Allow service role full access
CREATE POLICY "Service role can read phone_number_pool"
  ON phone_number_pool
  FOR SELECT
  TO service_role
  USING (true);

CREATE POLICY "Service role can insert phone_number_pool"
  ON phone_number_pool
  FOR INSERT
  TO service_role
  WITH CHECK (true);

CREATE POLICY "Service role can update phone_number_pool"
  ON phone_number_pool
  FOR UPDATE
  TO service_role
  USING (true)
  WITH CHECK (true);

CREATE POLICY "Service role can delete phone_number_pool"
  ON phone_number_pool
  FOR DELETE
  TO service_role
  USING (true);

-- Deny all access to anon and authenticated users
CREATE POLICY "Deny anon access to phone_number_pool"
  ON phone_number_pool
  FOR ALL
  TO anon
  USING (false);

CREATE POLICY "Deny authenticated access to phone_number_pool"
  ON phone_number_pool
  FOR ALL
  TO authenticated
  USING (false);

-- ============================================================
-- 6. Comments for documentation
-- ============================================================
COMMENT ON TABLE phone_number_pool IS 'Inventory of Twilio phone numbers available for assignment to users';
COMMENT ON COLUMN phone_number_pool.phone_number IS 'E.164 format phone number (e.g., +819012345678)';
COMMENT ON COLUMN phone_number_pool.status IS 'Current status: available or assigned';
COMMENT ON COLUMN phone_number_pool.assigned_user_id IS 'User ID to whom this number is assigned (NULL if available)';
COMMENT ON FUNCTION claim_phone_number IS 'Atomically claim an available phone number for a user. Returns the claimed number or raises an exception if none available.';
