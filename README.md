# 飲食店向け電話応答AIサーバー（AiLuna Call Engine）

Twilio Media Streams と OpenAI Realtime API を用いて、  
**電話着信に応じて双方向音声で会話できる飲食店向けAI応答サーバー**です。

- 通話エンジン部分（このリポジトリ）
- SaaS 管理画面（`ailuna-web` / Next.js + Supabase）

という構成のうち、ここは **通話エンジン（コア）** を担当します。

- Node.js / TypeScript / Express / WebSocket ベース
- Twilio Media Streams（μ-law 8kHz）と OpenAI Realtime API をブリッジ
- 8kHz / mono 前提で音声パイプラインを統一
- 会話ログを NDJSON として保存（将来の要約・分析のための土台）

---

## 前提条件

- Node.js (LTS) / npm
- OpenAI API キー
- Twilio アカウントと電話番号（音声通話有効・Media Streams 利用可能）
- ngrok などの HTTPS トンネルツール

---

## セットアップ手順

1. 任意のディレクトリでリポジトリを取得します。

   ```bash
   git clone https://github.com/rukataka0505/ailuna-call-engine.git
   cd ailuna-call-engine
   ```

2. 依存関係をインストールします。

   ```bash
   npm install
   ```

3. `.env.example` をコピーして `.env` を作成し、各値を設定します。

   ```bash
   cp .env.example .env
   ```

4. 開発サーバーを起動します。（デフォルトでポート 3100 で起動します）

   ```bash
   npm run dev
   ```

---

---

## デプロイ手順（Railway への本番デプロイ）

本番環境では **Railway** を使用して `ailuna-call-engine` を常駐させ、ngrok に依存しない運用を行います。

### 前提条件

- GitHub アカウント（このリポジトリを push 済み）
- Railway アカウント（[railway.app](https://railway.app) で無料登録可能）
- Twilio アカウントと電話番号
- Supabase プロジェクト（通話ログ保存用）
- OpenAI API キー

### 1. Railway プロジェクトの作成

1. [Railway ダッシュボード](https://railway.app/dashboard) にログインします
2. 「New Project」をクリックします
3. 「Deploy from GitHub repo」を選択します
4. `ailuna-call-engine` リポジトリを選択します
5. Railway が自動的にリポジトリを検出し、デプロイを開始します

### 2. ビルド・起動コマンドの設定

Railway は `package.json` の scripts を自動検出しますが、念のため以下を確認してください：

- **Build Command**: `npm run build`
- **Start Command**: `npm start`

これらは `package.json` で既に定義されています：

```json
{
  "scripts": {
    "build": "tsc",
    "start": "node dist/index.js"
  }
}
```

### 3. 環境変数の設定

Railway のダッシュボードで「Variables」タブを開き、以下の環境変数を設定します。  
`.env.production.example` を参考にしてください。

#### 必須環境変数一覧

| 変数名 | 説明 | 例 | 備考 |
|--------|------|-----|------|
| `PORT` | サーバーポート番号 | `3100` | Railway が自動設定するため通常は不要 |
| `PUBLIC_URL` | Railway のドメイン | `https://ailuna-call-engine-production.up.railway.app` | **デプロイ後に発行される URL を設定** |
| `OPENAI_API_KEY` | OpenAI API キー | `sk-proj-xxx...` | **必須** |
| `OPENAI_REALTIME_MODEL` | Realtime API モデル | `gpt-realtime` | **必須** |
| `OPENAI_SUMMARY_MODEL` | 要約生成モデル | `gpt-4o-mini` | **必須** |
| `OPENAI_REALTIME_SYSTEM_PROMPT` | システムプロンプト（フォールバック） | `"あなたは..."` | `system_prompt.md` が無い場合に使用 |
| `LOG_DIR` | ログ保存ディレクトリ | `call_logs` | Railway は永続ストレージ無し、Supabase 保存を推奨 |
| `TWILIO_ACCOUNT_SID` | Twilio アカウント SID | `ACxxxxxxxxxx` | **必須** |
| `TWILIO_AUTH_TOKEN` | Twilio Auth Token | `xxxxxxxxxx` | **必須** |
| `SUPABASE_URL` | Supabase プロジェクト URL | `https://xxx.supabase.co` | **必須** - 通話ログ保存用 |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase Service Role Key | `eyJhbGci...` | **必須** - RLS バイパス用 |

> [!IMPORTANT]
> `PUBLIC_URL` は Railway デプロイ完了後に「Settings」→「Domains」で確認できる URL を設定してください。  
> 例: `https://ailuna-call-engine-production.up.railway.app`

### 4. デプロイの確認

1. Railway が自動的にビルド・デプロイを実行します
2. 「Deployments」タブでビルドログを確認します
3. デプロイ成功後、「Settings」→「Domains」で公開 URL を確認します
4. ヘルスチェックエンドポイントにアクセスして動作確認：
   ```
   https://{your-railway-domain}/health
   ```
   レスポンス例：
   ```json
   {"status":"ok","timestamp":"2025-11-22T08:00:00.000Z"}
   ```

### 5. Twilio の設定変更

Railway デプロイ完了後、Twilio の Webhook URL を Railway のドメインに変更します。

#### 5-1. Twilio Console にアクセス

1. [Twilio Console](https://console.twilio.com/) にログインします
2. 「Phone Numbers」→「Manage」→「Active numbers」を選択します
3. AiLuna で使用する電話番号をクリックします

#### 5-2. Webhook URL の更新

「Voice Configuration」セクションで以下を設定します：

- **A CALL COMES IN**:
  - `Webhook` を選択
  - URL: `https://{your-railway-domain}/incoming-call-realtime`
  - HTTP Method: `POST`

例：
```
https://ailuna-call-engine-production.up.railway.app/incoming-call-realtime
```

#### 5-3. 設定の保存

「Save Configuration」をクリックして保存します。

### 6. 動作確認

1. Twilio の電話番号に発信します
2. AI が応答し、双方向音声で会話できることを確認します
3. Supabase の `call_logs` テーブルに通話ログが保存されていることを確認します

---

## 環境変数の詳細

`.env` に設定する環境変数の詳細です。ローカル開発用は `.env.example`、本番用は `.env.production.example` を参考にしてください。

### サーバー設定

| 変数名 | 説明 | デフォルト値 | 必須 |
|--------|------|-------------|------|
| `PORT` | HTTP ポート番号 | `3100` | ○ |
| `PUBLIC_URL` | 公開ベース URL（ngrok または Railway） | - | ○ |

### OpenAI 設定

| 変数名 | 説明 | デフォルト値 | 必須 |
|--------|------|-------------|------|
| `OPENAI_API_KEY` | OpenAI API キー | - | ○ |
| `OPENAI_REALTIME_MODEL` | Realtime API モデル | `gpt-realtime` | ○ |
| `OPENAI_REALTIME_SYSTEM_PROMPT` | システムプロンプト（フォールバック） | - | △ |
| `OPENAI_SUMMARY_MODEL` | 通話要約生成モデル | `gpt-4o-mini` | ○ |

> [!NOTE]
> `system_prompt.md` ファイルが存在する場合、そちらが優先されます。  
> `OPENAI_REALTIME_SYSTEM_PROMPT` はファイルが無い場合のフォールバックとして使用されます。

### ログ設定

| 変数名 | 説明 | デフォルト値 | 必須 |
|--------|------|-------------|------|
| `LOG_DIR` | 通話ログ保存ディレクトリ | `call_logs` | ○ |

> [!WARNING]
> Railway などのエフェメラル環境では、ファイルシステムへのログ保存は再起動時に消失します。  
> 本番運用では Supabase への保存を主に使用してください。

### Twilio 設定

| 変数名 | 説明 | デフォルト値 | 必須 |
|--------|------|-------------|------|
| `TWILIO_ACCOUNT_SID` | Twilio アカウント SID | - | ○ |
| `TWILIO_AUTH_TOKEN` | Twilio Auth Token | - | ○ |

### Supabase 設定

| 変数名 | 説明 | デフォルト値 | 必須 |
|--------|------|-------------|------|
| `SUPABASE_URL` | Supabase プロジェクト URL | - | ○ |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase Service Role Key | - | ○ |

> [!IMPORTANT]
> `SUPABASE_SERVICE_ROLE_KEY` は RLS をバイパスするため、絶対に公開しないでください。  
> Railway の環境変数として安全に管理してください。

---

## 運用モード（本番 vs 開発）

### 本番モード（Railway）

- **環境**: Railway 上で常時起動
- **URL**: `https://{railway-domain}`
- **Twilio 設定**: Railway の URL を向ける
- **メリット**: 
  - ngrok 不要
  - 常時稼働
  - 自動デプロイ（GitHub push で更新）
- **用途**: 実際の店舗運用

### 開発モード（ローカル + ngrok）

- **環境**: ローカルマシンで `npm run dev`
- **URL**: `https://{ngrok-domain}` (一時的)
- **Twilio 設定**: ngrok の URL を向ける（テスト時のみ）
- **メリット**:
  - コード変更が即座に反映
  - デバッグが容易
- **用途**: 機能開発・テスト

#### ローカル開発の手順

1. サーバーを起動：
   ```bash
   npm run dev
   ```

2. ngrok で公開（別ターミナル）：
   ```bash
   ngrok http 3100
   ```

3. `.env` の `PUBLIC_URL` を ngrok の URL に更新：
   ```
   PUBLIC_URL=https://xxxx-xx-xx-xxx-xxx.ngrok-free.app
   ```

4. （必要に応じて）Twilio の Webhook URL を ngrok の URL に一時変更

> [!CAUTION]
> 開発終了後は、Twilio の Webhook URL を必ず Railway の URL に戻してください。  
> ngrok の URL は一時的なものであり、ngrok を停止すると使用できなくなります。

---

## Railway デプロイのトラブルシューティング

### ビルドが失敗する

**症状**: Railway のビルドログにエラーが表示される

**確認ポイント**:
- `package.json` の `build` スクリプトが正しいか確認
- TypeScript のコンパイルエラーがないか確認
- ローカルで `npm run build` を実行してエラーを確認

### サーバーが起動しない

**症状**: デプロイ成功後、サービスが起動しない

**確認ポイント**:
- 環境変数が全て設定されているか確認（特に `OPENAI_API_KEY`, `SUPABASE_URL` など必須項目）
- Railway のログで起動エラーを確認
- `PORT` 環境変数が Railway の動的ポートと競合していないか確認（通常は自動設定されるため不要）

### Twilio から接続できない

**症状**: 電話をかけても AI が応答しない

**確認ポイント**:
- Twilio の Webhook URL が正しい Railway のドメインを向いているか確認
- `PUBLIC_URL` 環境変数が Railway のドメインと一致しているか確認
- Railway のログで Twilio からのリクエストが届いているか確認
- ヘルスチェックエンドポイント (`/health`) にアクセスできるか確認

### 通話ログが保存されない

**症状**: 通話は成功するが、Supabase にログが保存されない

**確認ポイント**:
- `SUPABASE_URL` と `SUPABASE_SERVICE_ROLE_KEY` が正しく設定されているか確認
- Supabase の `call_logs` テーブルが存在するか確認（`sql/call_logs.sql` を実行）
- Railway のログで Supabase 接続エラーが出ていないか確認

### ログの確認方法

Railway のログを確認するには：

1. Railway ダッシュボードで該当プロジェクトを開く
2. 「Deployments」タブを選択
3. 最新のデプロイメントをクリック
4. 「View Logs」でリアルタイムログを確認

---

## システムプロンプトのカスタマイズ

システムプロンプト（AI の人格や会話ルール）は、以下の優先順位で読み込まれます。

1. `system_prompt.md`（推奨）

   * プロジェクトルートにあるこのファイルを編集することで、
     **サーバー再起動なし**に（次回通話開始時から）プロンプトを変更可能です。
   * Markdown ファイルとして自然な文章で記述できます。
   * 通話開始（Realtime 接続）ごとに毎回ファイルを読み込みます。

2. 環境変数 `OPENAI_REALTIME_SYSTEM_PROMPT`（フォールバック）

   * `system_prompt.md` が存在しない、または読み込めない場合に使用されます。
   * `.env` に記述します。改行は `\n` を使用してください。

### `system_prompt.md` の書き方

* 通話に使いたいプロンプト本文をそのまま記述します。
* 改行・箇条書きもそのまま反映されます。
* 「飲食店共通ルール」＋「店舗ごとの方針」のように、
  人間が読んで意味が分かる構成にしておくと保守が楽です。

> ⚠️ 注意
> 現在のファイルベース（`.md`）プロンプト管理は、ローカル開発または
> 永続ストレージを持つサーバー向けです。
> Heroku / Cloud Run などのエフェメラル環境では、再起動でファイルが消えるため、
> 本番運用では将来的に DB などへの移行を検討してください。

---

## アーキテクチャ概要

### 全体フロー

1. お客様が Twilio の電話番号に発信
2. Twilio が `A CALL COMES IN` 設定の URL（`/incoming-call-realtime`）に HTTP リクエスト
3. サーバーが `<Start><Stream>` を含む TwiML を返し、Media Streams を開始
4. Twilio から音声ストリーム（μ-law 8kHz）が WebSocket (`/twilio-media`) に送られる
5. サーバー側で OpenAI Realtime API との WebSocket セッションを確立
6. Twilio ⇔ Realtime 間で音声とテキストをリアルタイムでブリッジ
7. 会話ログを NDJSON で保存し、通話終了

### レイヤー構造（責務）

将来の拡張・保守を見据え、次の 3 レイヤーを意識して設計しています。

1. **通話レイヤー（Transport Layer）**

   * 役割：Twilio Media Streams と OpenAI Realtime API 間の「音声 I/O」とセッション管理
   * 主な責務：

     * Twilio からの Media Streams イベント受付（開始／音声／終了）
     * Realtime への音声送信・イベント受信
     * バージイン（お客様が話し始めたら `input_audio_buffer.speech_started` イベントを検知して AI 音声を即停止し、Twilio のバッファもクリア）
     * セッションライフサイクル管理（通話開始〜終了）

2. **シナリオ・設定レイヤー（Scenario / Configuration Layer）**

   * 役割：「この店舗はどう応対するか」を決める頭脳
   * 主な責務：

     * ベースのシステムプロンプト（`system_prompt.md` など）
     * 将来の店舗ごとの設定（挨拶文・事業内容・予約ポリシー等）
       を統合し、Realtime 用の `instructions` と最初の挨拶文 `greeting` を生成する。
   * 現時点では主に `system_prompt.md` ベースで動作し、
     今後 Supabase `user_prompts` と連携することを想定しています。

3. **ログ・分析レイヤー（Logging / Analytics Layer）**

   * 役割：あとから振り返るための記録、および将来の要約・分析機能の土台
   * 主な責務：

     * NDJSON 形式でのイベントログ出力
     * callSid / streamSid 単位での通話ログ管理
     * 将来、Supabase などへの保存・要約生成を行うための拡張ポイント

---

## 音声パイプライン

本サーバーでは、**TwilioとOpenAI Realtime API間を G.711 μ-law 8kHz で統一**しています。
サーバー内部でのトランスコード（変換）やリサンプリングは行わず、音声をそのまま転送することで低遅延を実現しています。

* Twilio Media Streams からの入力：
  * フォーマット：μ-law 8kHz mono
* サーバー内部：
  * 変換なし（パススルー）
* Realtime API とのやり取り：
  * `input_audio_format`: `g711_ulaw`
  * `output_audio_format`: `g711_ulaw`

この方針により、処理のシンプルさとレイテンシの低さを最優先しています。

---

## Realtime セッション仕様（声質・バージイン・挨拶）

このリポジトリでは、すでに以下の会話仕様でチューニングされています。

* **声質・話速**

  * 飲食店向けの「女性寄り・自然なスピード」の声を採用
  * お客様にとって聞き取りやすいトーンを前提にしています

* **バージイン（割り込み）**

  * お客様が話し始めたタイミングで、AI の音声をできるだけ即座に停止します
  * Realtime の VAD（`server_vad`）＋ Twilio のイベントを組み合わせ、
    「かぶり」を最小限に抑えるよう調整済みです

* **最初の挨拶**

  * 通話開始時の「最初の一言」は GREETING メッセージとして固定し、
    意図どおりの文言を読み上げます
  * 2 ターン目以降は、通常の Realtime 会話ロジックに従います

これらの仕様は今後の開発における「前提条件」として扱い、
店舗ごとのプロンプト差し替えや SaaS 側の設定反映をこの上に乗せていきます。

---

## Twilio 側の設定

> [!NOTE]
> Twilio の詳細な設定手順は、上記の「デプロイ手順（Railway への本番デプロイ）」→「5. Twilio の設定変更」セクションを参照してください。

本番運用では Railway のドメインを、開発時は ngrok のドメインを Twilio の Webhook URL に設定します。

### 本番環境（Railway）

- **A CALL COMES IN**: `https://{railway-domain}/incoming-call-realtime`

### 開発環境（ローカル + ngrok）

- **A CALL COMES IN**: `https://{ngrok-domain}/incoming-call-realtime`

※ Media Streams の有効化手順は Twilio の公式ドキュメントを参照してください。

---

## 動作確認

### 本番環境（Railway）での確認

1. Railway デプロイが完了していることを確認
2. ヘルスチェックエンドポイントにアクセス: `https://{railway-domain}/health`
3. Twilio の電話番号に発信
4. AI が応答し、双方向音声で自然な会話ができることを確認
5. Supabase の `call_logs` テーブルに通話ログが保存されていることを確認

### 開発環境（ローカル）での確認

1. サーバーを起動:
   ```bash
   npm run dev
   ```

2. ngrok でポート 3100 を公開:
   ```bash
   ngrok http 3100
   ```

3. `.env` の `PUBLIC_URL` を ngrok の URL に更新

4. Twilio の電話番号に発信して動作確認

5. `LOG_DIR`（デフォルト: `call_logs/`）ディレクトリに  
   `call_YYYYMMDD_HHmmss_xxx.ndjson` 形式で会話ログが保存されていることを確認

---

## ログ仕様（NDJSON）

通話ログは NDJSON (Newline Delimited JSON) 形式で保存されます。
各行は次のフィールドを持つ JSON オブジェクトです。

### 共通フィールド

* `timestamp`: ISO8601 形式のタイムスタンプ
* `event`: イベント種別（`start`, `stop`, `user_utterance`, `assistant_response` など）
* `streamSid`: Twilio Stream SID
* `callSid`: Twilio Call SID

### 会話ログ（`user_utterance` / `assistant_response`）

* `role`: `'user'` または `'assistant'`
* `text`: 発話または応答のテキスト内容
* `turn`: ターン番号（1から始まる連番）

### ログサンプル

```json
{"timestamp":"2025-11-19T05:14:21.193Z","event":"start","streamSid":"...","callSid":"..."}
{"timestamp":"2025-11-19T05:14:22.825Z","streamSid":"...","callSid":"...","event":"user_utterance","role":"user","text":"こんにちは","turn":1}
{"timestamp":"2025-11-19T05:14:24.100Z","streamSid":"...","callSid":"...","event":"assistant_response","role":"assistant","text":"こんにちは。ご予約でしょうか？","turn":2}
{"timestamp":"2025-11-19T05:14:42.869Z","event":"stop","streamSid":"...","callSid":"..."}
```

---

## 文字起こし（Transcription）

OpenAI Realtime API の `input_audio_transcription` 機能（`whisper-1`）を利用しています。

* ユーザーの発話は `conversation.item.input_audio_transcription.completed` イベント経由で取得し、
  `user_utterance` としてログに記録します。
* ユーザーの発話は `conversation.item.input_audio_transcription.completed` イベント経由で取得し、
  `user_utterance` としてログに記録します。
* 取得した文字起こし（ユーザー発話・AI応答）は Supabase の `call_logs` テーブルへ保存され、
  ダッシュボード側で一覧表示・要約表示に利用されます。

---

## 今後の拡張（メモ）

この通話エンジンは、AiLuna の SaaS 管理画面（Next.js + Supabase）と連携して、
次のような機能追加を行うことを想定しています。

* Supabase の `user_prompts` / `profiles` から店舗ごとの設定を取得し、
  Realtime の `instructions` / GREETING に反映する（実装済み）
* 通話終了時に transcript / 要約を Supabase に保存し、
  Web ダッシュボードで「いつ・誰から・どんな要件だったか」を一覧できるようにする（実装済み）
  - 要約は OpenAI API（`OPENAI_SUMMARY_MODEL`）を使用して自動生成されます
  - 20文字以内の簡潔なタイトル形式で、履歴一覧での表示に最適化されています
* 通話時間・利用回数・トークン使用量などのメトリクスを集計し、請求や分析に活用する

これらは順次拡張していきます。

### データベース (Supabase)

以下のテーブルを使用します。

#### `call_logs` テーブル
通話履歴を保存します。通話終了時に自動的に会話内容の要約も生成され、履歴一覧での表示に活用されます。

- `id`: UUID (PK)
- `user_id`: UUID (FK to `profiles.id`) - 店舗ID
- `call_sid`: Text - Twilio Call SID
- `caller_number`: Text - 発信者番号
- `recipient_number`: Text - 着信番号
- `transcript`: JSONB - 会話履歴（`[{role, text, timestamp}, ...]`）
- `summary`: Text - 通話内容の要約（20文字以内のタイトル形式、OpenAI APIで自動生成）
- `status`: Text - ステータス（`completed` 等）
- `duration_seconds`: Integer - 通話時間（秒単位）。過去のログなど値がない場合は NULL または 0 となる場合があります。
- `created_at`: Timestamp

RLSポリシーにより、各店舗（ユーザー）は自分の店舗の通話ログのみ参照可能です。

---

## トラブルシューティング

### 通話要約が生成されない・表示されない場合

最新の推論モデル（`gpt-5.1` や `o1` シリーズ）を使用する場合、従来の `system` ロールの代わりに `developer` ロールを使用し、`max_tokens` の代わりに `max_completion_tokens` を指定する必要があります。
本リポジトリでは最新の OpenAI SDK 仕様に合わせてこれらの対応を行っています。

#### 確認ポイント
* **要約モデル設定**: `.env` の `OPENAI_SUMMARY_MODEL` が正しく設定されているか（例: `gpt-5.1`）。
* **SDKバージョン**: `openai` パッケージが最新（v4.70.0以上 または v6系）であることを確認してください。
* **ログ確認**: 要約生成時のエラーや使用モデルはコンソールログに出力されます（`🤖 Generating call summary... (Model: ...)`）。
* **パラメータ仕様**: `gpt-5.1` などの推論モデルは `developer` ロールを推奨するため、ソースコード（`src/realtimeSession.ts`）で `role: 'developer'` を使用しています。
