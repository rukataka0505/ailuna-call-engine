# Stripe Webhook 環境変数

Stripe Webhook API ルート (`app/api/webhooks/stripe/route.ts`) で使用する環境変数の一覧です。

## 必須環境変数

### Stripe 関連

| 変数名 | 説明 | 取得方法 | 例 |
|--------|------|----------|-----|
| `STRIPE_SECRET_KEY` | Stripe API シークレットキー | [Stripe Dashboard](https://dashboard.stripe.com/apikeys) の「Secret key」 | `sk_test_...` (テスト環境)<br>`sk_live_...` (本番環境) |
| `STRIPE_WEBHOOK_SECRET` | Webhook 署名検証用シークレット | [Stripe Dashboard](https://dashboard.stripe.com/webhooks) で Webhook エンドポイント作成時に発行される | `whsec_...` |

### Supabase 関連

| 変数名 | 説明 | 取得方法 | 例 |
|--------|------|----------|-----|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase プロジェクト URL | [Supabase Dashboard](https://app.supabase.com/) の「Project Settings」→「API」 | `https://xxxxx.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase Service Role キー（RLS バイパス用） | [Supabase Dashboard](https://app.supabase.com/) の「Project Settings」→「API」→「service_role (secret)」 | `eyJhbGci...` |

## 環境変数の設定方法

### ローカル開発環境

`.env.local` ファイルに以下を追加:

```bash
# Stripe
STRIPE_SECRET_KEY=sk_test_xxxxxxxxxxxxxxxxxxxxx
STRIPE_WEBHOOK_SECRET=whsec_xxxxxxxxxxxxxxxxxxxxx

# Supabase
NEXT_PUBLIC_SUPABASE_URL=https://xxxxx.supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJhbGci...
```

### 本番環境 (Vercel)

1. Vercel Dashboard を開く
2. プロジェクトを選択
3. 「Settings」→「Environment Variables」
4. 上記の環境変数を追加

## Stripe Webhook エンドポイントの設定

### 1. Webhook エンドポイントの作成

1. [Stripe Dashboard](https://dashboard.stripe.com/webhooks) にアクセス
2. 「Add endpoint」をクリック
3. エンドポイント URL を入力:
   - **ローカル開発**: `http://localhost:3000/api/webhooks/stripe` (Stripe CLI 使用時)
   - **本番環境**: `https://your-domain.com/api/webhooks/stripe`

### 2. 監視するイベントの選択

以下のイベントを選択:

- ✅ `checkout.session.completed` - 初回支払い完了時
- ✅ `invoice.payment_succeeded` - 継続課金成功時

### 3. Webhook シークレットの取得

エンドポイント作成後、「Signing secret」が表示されます。この値を `STRIPE_WEBHOOK_SECRET` 環境変数に設定してください。

## ローカル開発での Webhook テスト

Stripe CLI を使用してローカル環境で Webhook をテストできます。

### 1. Stripe CLI のインストール

```bash
# macOS (Homebrew)
brew install stripe/stripe-cli/stripe

# Windows (Scoop)
scoop bucket add stripe https://github.com/stripe/scoop-stripe-cli.git
scoop install stripe

# または公式サイトからダウンロード
# https://stripe.com/docs/stripe-cli
```

### 2. Stripe CLI でログイン

```bash
stripe login
```

### 3. Webhook のフォワーディング

```bash
# Next.js 開発サーバーを起動 (別ターミナル)
npm run dev

# Webhook をローカルにフォワード
stripe listen --forward-to localhost:3000/api/webhooks/stripe
```

このコマンドを実行すると、Webhook シークレット (`whsec_...`) が表示されます。これを `.env.local` の `STRIPE_WEBHOOK_SECRET` に設定してください。

### 4. テストイベントのトリガー

```bash
# checkout.session.completed イベントをトリガー
stripe trigger checkout.session.completed

# invoice.payment_succeeded イベントをトリガー
stripe trigger invoice.payment_succeeded
```

## セキュリティ上の注意

> [!CAUTION]
> **`SUPABASE_SERVICE_ROLE_KEY` は絶対に公開しないでください**
> 
> この鍵は Row Level Security (RLS) をバイパスするため、漏洩すると全てのデータにアクセスされる危険があります。
> 
> - Git にコミットしない (`.env.local` は `.gitignore` に含める)
> - クライアントサイドのコードで使用しない
> - 環境変数として安全に管理する

> [!WARNING]
> **`STRIPE_SECRET_KEY` と `STRIPE_WEBHOOK_SECRET` も機密情報です**
> 
> - テスト環境と本番環境で異なる鍵を使用する
> - 定期的にローテーションする
> - 漏洩した場合は即座に無効化して再発行する

## トラブルシューティング

### Webhook 署名検証エラー

**症状**: `Webhook signature verification failed` エラーが発生する

**原因と対処法**:
- `STRIPE_WEBHOOK_SECRET` が正しく設定されているか確認
- Stripe Dashboard の Webhook エンドポイント設定を確認
- ローカル開発の場合、Stripe CLI の `stripe listen` で表示されたシークレットを使用しているか確認

### Supabase 接続エラー

**症状**: `Failed to update profile` や `Failed to claim phone number` エラーが発生する

**原因と対処法**:
- `NEXT_PUBLIC_SUPABASE_URL` と `SUPABASE_SERVICE_ROLE_KEY` が正しく設定されているか確認
- Supabase プロジェクトが稼働しているか確認
- `profiles` テーブルと `phone_number_pool` テーブルが存在するか確認
- `claim_phone_number` RPC 関数が作成されているか確認 (`sql/phone_number_pool.sql` を実行)

### 電話番号が割り当てられない

**症状**: サブスクリプションは有効になるが、電話番号が割り当てられない

**原因と対処法**:
- `phone_number_pool` テーブルに `status = 'available'` の電話番号が存在するか確認
- ログに「No available phone numbers in pool」エラーが出ていないか確認
- 既にユーザーが電話番号を持っている場合はスキップされます (仕様通り)

## 参考リンク

- [Stripe Webhooks ドキュメント](https://stripe.com/docs/webhooks)
- [Stripe CLI ドキュメント](https://stripe.com/docs/stripe-cli)
- [Supabase Service Role ドキュメント](https://supabase.com/docs/guides/api/api-keys)
