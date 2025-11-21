-- Create call_logs table
create table public.call_logs (
  id uuid not null default gen_random_uuid (),
  user_id uuid null,
  call_sid text not null,
  caller_number text not null,
  recipient_number text not null,
  transcript jsonb null,
  summary text null,
  status text null,
  duration_seconds integer default 0,
  created_at timestamp with time zone not null default now(),
  constraint call_logs_pkey primary key (id),
  constraint call_logs_user_id_fkey foreign key (user_id) references profiles (id) on delete set null
) tablespace pg_default;

-- Enable RLS
alter table public.call_logs enable row level security;

-- Create policy for users to view their own logs
create policy "Users can view their own call logs" on public.call_logs
  for select
  using (auth.uid() = user_id);

-- Create policy for service role to insert logs (since the server uses service role key)
-- Note: If you are using the service role key in the backend, it bypasses RLS by default.
-- However, if you want to be explicit or if you use a different role:
-- create policy "Service role can insert call logs" on public.call_logs
--   for insert
--   with check (true);
