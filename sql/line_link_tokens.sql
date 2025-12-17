-- LINE連携用の使い捨てトークンを管理するテーブル
-- Schema: line_link_tokens(token text PK, user_id uuid, expires_at timestamptz, used_at timestamptz, created_at timestamptz)

CREATE TABLE IF NOT EXISTS public.line_link_tokens (
    token TEXT PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    expires_at TIMESTAMPTZ NOT NULL,
    used_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);

-- インデックス
CREATE INDEX IF NOT EXISTS idx_line_link_tokens_user_id ON public.line_link_tokens (user_id);

-- RLS (Row Level Security)
ALTER TABLE public.line_link_tokens ENABLE ROW LEVEL SECURITY;

-- ポリシー (アプリサーバーからのアクセスを想定、必要に応じてユーザー自身のアクセスも許可)
CREATE POLICY "Users can create their own tokens" ON public.line_link_tokens
    FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can view their own tokens" ON public.line_link_tokens
    FOR SELECT USING (auth.uid() = user_id);
