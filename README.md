````markdown
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
````

2. 依存関係をインストールします。

   ```bash
   npm install
   ```

3. `.env.example` をコピーして `.env` を作成し、各値を設定します。

   ```bash
   cp .env.example .env
   ```

4. 開発サーバーを起動します。

   ```bash
   npm run dev
   ```

---

## デプロイ手順（Railway / Render 等）

本番環境（PaaS）へのデプロイ手順です。
GitHub リポジトリと連携することで、簡単にデプロイできます。

### 1. リポジトリの準備
このリポジトリを GitHub にプッシュします。

### 2. PaaS へのデプロイ (例: Railway)
1. Railway で「New Project」→「Deploy from GitHub repo」を選択します。
2. このリポジトリを選択します。
3. **Variables** (環境変数) 設定画面で、`.env.production.example` の内容を設定します。
   - `PUBLIC_URL` には、PaaS から発行されたドメイン（例: `https://xxx.up.railway.app`）を設定してください。
   - `PORT` は PaaS の仕様に従ってください（Railway は自動検出、Render は `PORT` 変数が必要な場合あり）。
4. デプロイが完了するのを待ちます。

### 3. Twilio の設定変更
デプロイ完了後、Twilio の管理画面で Webhook URL を本番用に変更します。

- **A CALL COMES IN**:
  - URL: `[本番URL]/incoming-call-realtime`
  - 例: `https://xxx.up.railway.app/incoming-call-realtime`

---

## 環境変数

`.env` に最低限次の値を設定します。

| 変数名                             | 説明                                                            |
| ------------------------------- | ------------------------------------------------------------- |
| `PORT`                          | HTTP ポート番号（例: `3000`）                                         |
| `PUBLIC_URL`                    | ngrok 等で公開されるベースURL（例: `https://xxxx.ngrok.io`）               |
| `OPENAI_API_KEY`                | OpenAI API キー                                                 |
| `OPENAI_REALTIME_MODEL`         | 利用する Realtime モデル（例: `gpt-realtime`）                          |
| `OPENAI_REALTIME_SYSTEM_PROMPT` | GPT Realtime に渡す電話応対AI向けベースプロンプト（`system_prompt.md` が無い場合に使用） |
| `LOG_DIR`                       | 通話ログ保存ディレクトリ（デフォルト: `call_logs`）                              |
| `TWILIO_ACCOUNT_SID`            | Twilio アカウント SID（Twilio API 利用時に使用）                           |
| `TWILIO_AUTH_TOKEN`             | Twilio Auth Token（Twilio API 利用時に使用）                          |
| `SUPABASE_URL`                  | Supabase プロジェクト URL                                       |
| `SUPABASE_SERVICE_ROLE_KEY`     | Supabase Service Role Key（RLS バイパス用）                     |

※ `SUPABASE_URL` と `SUPABASE_SERVICE_ROLE_KEY` を設定すると、
　着信番号（`profiles.phone_number`）に基づいて `user_prompts` から
　店舗ごとの設定（挨拶文・事業内容）を動的に読み込みます。

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
     * バージイン（お客様が話し始めたら AI 音声を即停止）
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

Twilio コンソールで、対象電話番号の設定を行います。

* **A CALL COMES IN**

  * `Webhook` にチェックを入れ、
  * URL に `https://{ngrokドメイン}/incoming-call-realtime` を設定します。
* 該当電話番号で Media Streams が利用可能であることを確認してください。

※ Media Streams の有効化手順は Twilio の公式ドキュメントを参照してください。

---

## 動作確認

1. サーバーを起動し、ngrok などで `PUBLIC_URL` を取得して `.env` に反映します。
2. Twilio の電話番号に発信します。
3. AI が応答し、双方向音声で自然な会話ができることを確認します。
4. `LOG_DIR`（デフォルト: `call_logs/`）ディレクトリに
   `call_YYYYMMDD_HHmmss_xxx.ndjson` 形式で会話ログが保存されていることを確認します。

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
* 将来的に、この文字起こしをもとに Supabase へ保存し、
  ダッシュボード側で一覧表示・要約表示することを想定しています。

---

## 今後の拡張（メモ）

この通話エンジンは、AiLuna の SaaS 管理画面（Next.js + Supabase）と連携して、
次のような機能追加を行うことを想定しています。

* Supabase の `user_prompts` / `profiles` から店舗ごとの設定を取得し、
  Realtime の `instructions` / GREETING に反映する
* 通話終了時に transcript / 要約を Supabase に保存し、
  Web ダッシュボードで「いつ・誰から・どんな要件だったか」を一覧できるようにする
* 通話時間・利用回数・トークン使用量などのメトリクスを集計し、請求や分析に活用する

これらはまだ実装途中または未着手ですが、
本 README に示したレイヤー構造とログ仕様をベースに順次拡張していきます。

### データベース (Supabase)

以下のテーブルを使用します。

#### `call_logs` テーブル
通話履歴を保存します。

- `id`: UUID (PK)
- `user_id`: UUID (FK to `profiles.id`) - 店舗ID
- `call_sid`: Text - Twilio Call SID
- `caller_number`: Text - 発信者番号
- `recipient_number`: Text - 着信番号
- `transcript`: JSONB - 会話履歴（`[{role, text, timestamp}, ...]`）
- `status`: Text - ステータス（`completed` 等）
- `created_at`: Timestamp

RLSポリシーにより、各店舗（ユーザー）は自分の店舗の通話ログのみ参照可能です。

```
::contentReference[oaicite:0]{index=0}
```
