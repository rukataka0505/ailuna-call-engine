-- LINE連携用の使い捨てトークンを管理するテーブル
CREATE TABLE IF NOT EXISTS public.line_link_tokens (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    token_code TEXT NOT NULL UNIQUE,  -- ランダムな短いコード (例: "123456" や "A1B2C3")
    expires_at TIMESTAMPTZ NOT NULL,
    used_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);

-- インデックス
CREATE INDEX IF NOT EXISTS idx_line_link_tokens_token_code ON public.line_link_tokens (token_code);
CREATE INDEX IF NOT EXISTS idx_line_link_tokens_user_id ON public.line_link_tokens (user_id);

-- RLS (Row Level Security)
ALTER TABLE public.line_link_tokens ENABLE ROW LEVEL SECURITY;

-- ポリシー (アプリサーバーからのアクセスを想定、必要に応じてユーザー自身のアクセスも許可)
CREATE POLICY "Users can create their own tokens" ON public.line_link_tokens
    FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can view their own tokens" ON public.line_link_tokens
    FOR SELECT USING (auth.uid() = user_id);
