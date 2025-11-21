# 飲食店向け電話応答AIサーバー

Twilio Media Streams と OpenAI Realtime API を用いて、電話着信に応じて双方向音声で会話できる飲食店向けAI応答サーバーです。Node.js / TypeScript / Express / WebSocket をベースに構築しています。

## 前提条件
- Node.js (LTS) / npm
- OpenAI APIキー
- Twilio アカウントと電話番号（音声通話が有効）
- ngrok などの HTTPS トンネル

## セットアップ手順
1. 任意のディレクトリでリポジトリを取得します（例）：
   ```bash
   git clone https://example.com/restaurant-ai-voice.git
   cd restaurant-ai-voice
   ```
2. 依存関係をインストールします。
   ```bash
   npm install
   ```
3. `.env.example` をコピーして `.env` を作り、各値を設定します。
   ```bash
   cp .env.example .env
   ```
4. 開発サーバーを起動します。
   ```bash
   npm run dev
   ```

## 環境変数
`.env` に最低限以下を設定してください。

| 変数 | 説明 |
| --- | --- |
| PORT | HTTP ポート番号（例: 3000） |
| PUBLIC_URL | ngrok 等で公開されるベースURL（例: `https://xxxx.ngrok.io`） |
| OPENAI_API_KEY | OpenAI APIキー |
| OPENAI_REALTIME_MODEL | 利用するRealtimeモデル（例: `gpt-realtime`） |
| OPENAI_REALTIME_SYSTEM_PROMPT | GPT Realtime に渡す電話応対AI向けベースプロンプト（必ず設定） |
| LOG_DIR | 通話ログの保存ディレクトリ（デフォルト `call_logs`） |
| TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN | Twilio API呼び出しが必要な場合に利用 |

## システムプロンプトのカスタマイズ
システムプロンプト（AIの人格や会話ルール）は、以下の優先順位で読み込まれます。

1. **`system_prompt.md`** (推奨)
   - プロジェクトルートにあるこのファイルを編集することで、再起動なしに（次回通話開始時から）プロンプトを変更できます。
   - Markdownファイルとして自然な文章で記述できます。

2. **環境変数 `OPENAI_REALTIME_SYSTEM_PROMPT`** (フォールバック)
   - `system_prompt.md` が存在しない、または読み込めない場合に使用されます。
   - `.env` に記述します。改行は `\n` を使用してください。

### `system_prompt.md` の編集方法
- ファイル内にプロンプト本文をそのまま記述します。
- 改行もそのまま反映されるため、長文のプロンプト管理が容易です。
- 通話開始（`connect`）のタイミングで毎回ファイルを読み込むため、サーバーを再起動せずにプロンプトの調整・反映が可能です。

> [!WARNING]
> 現在のファイルベース（.md）のプロンプト管理は、ローカル開発または永続ストレージを持つサーバー向けです。Heroku, AWS Lambda, Cloud Run などのエフェメラルな環境（再起動でファイルがリセットされる環境）では、動的な変更は保持されません。本番運用の際はデータベース等への移行を検討してください。

## Twilio 側の設定
- 電話番号設定の **A CALL COMES IN** を `https://{ngrokドメイン}/incoming-call-realtime` に設定します。
- Media Streams が利用できる電話番号であることを確認してください。

## 動作確認
1. サーバーを起動し、ngrok などで PUBLIC_URL を取得して `.env` に反映します。
2. Twilio の電話番号に発信します。
3. AI が応答し、双方向音声で会話できることを確認します。
4. `call_logs/` ディレクトリに `call_YYYYMMDD_HHmmss_xxx.ndjson` 形式で会話ログが保存されていることを確認します。

## ログ仕様 (NDJSON)

通話ログは NDJSON (Newline Delimited JSON) 形式で保存されます。
各行は以下のフィールドを持つ JSON オブジェクトです。

### 共通フィールド
- `timestamp`: ISO8601 形式のタイムスタンプ
- `event`: イベント種別 (`start`, `stop`, `user_utterance`, `assistant_response` など)
- `streamSid`: Twilio Stream SID
- `callSid`: Twilio Call SID

### 会話ログ (user_utterance / assistant_response)
会話内容は以下のフィールドを含みます。
- `role`: `'user'` または `'assistant'`
- `text`: 発話または応答のテキスト内容
- `turn`: ターン番号 (1から始まる連番)

### ログサンプル
```json
{"timestamp":"2025-11-19T05:14:21.193Z","event":"start","streamSid":"...","callSid":"..."}
{"timestamp":"2025-11-19T05:14:22.825Z","streamSid":"...","callSid":"...","event":"user_utterance","role":"user","text":"こんにちは","turn":1}
{"timestamp":"2025-11-19T05:14:24.100Z","streamSid":"...","callSid":"...","event":"assistant_response","role":"assistant","text":"こんにちは。ご予約でしょうか？","turn":2}
{"timestamp":"2025-11-19T05:14:42.869Z","event":"stop","streamSid":"...","callSid":"..."}
```

## 文字起こし (Transcription)
OpenAI Realtime API の `input_audio_transcription` 機能 (`whisper-1` モデル) を有効化しています。
- ユーザーの発話は `conversation.item.input_audio_transcription.completed` イベント経由で取得し、`user_utterance` として記録します。
- VAD 検知時の `[speech detected]` ログはデバッグ用に残していますが、`role` フィールドは持ちません。

## 割り込み (Interruption)
OpenAI Realtime API の `server_vad` と `interrupt_response: true` を利用して、ユーザー発話時のエージェント応答の中断を制御しています。
- 以前はアプリ側で `response.cancel` を送信していましたが、現在は Realtime API 側の自動割り込み機能に任せています。
- アプリ側では `input_audio_buffer.speech_started` イベントを受け取った時点で Twilio 側の音声再生を停止 (`clear` メッセージ送信) し、ユーザーの発話を優先する挙動のみを実装しています。

## AIからの能動的な挨拶 (AI-Initiated Greeting)
接続確立後、ユーザーの発話を待たずにAIから会話を開始します。
- `session.update` 送信後、OpenAI からの `session.updated` イベントを受信したタイミングで `response.create` イベントを送信します。
- `instructions` に「システムプロンプトの定義に従って、ユーザーに最初の挨拶を行ってください。」を指定しています。
- これにより、無音状態が続くのを防ぎ、AI主導で会話がスタートします。

## 変更履歴
- 2025-11-19: `OPENAI_REALTIME_SYSTEM_PROMPT` を追加し、Realtime session.update に `instructions` を付与。README と `.env.example` に設定方法と注意点を追記。
- 2025-11-20: AIから能動的に挨拶を行う機能を追加 (`response.create` 送信)。`session.updated` イベント待機によりプロンプト反映を確実化。
- 2025-11-20: 接続確立時のセッション更新処理が重複実行されていた不具合を修正し、`session.updated` イベント後の挨拶生成タイミングを正常化。

## ライセンス
MIT など任意のライセンスを記述してください。

# Agent Rules (for this project)
- すべての返答は日本語で行うこと。
- コードコメント、説明、推論も日本語で行う。
# AiLuna-project

## リポジトリ情報
このフォルダは、以下の GitHub リポジトリと紐づいています。
- **URL**: https://github.com/rukataka0505/ailuna-call-engine.git

## バックアップ方法
開発者は、以下のコマンドを実行することで、変更内容を GitHub にバックアップ（コミット＆プッシュ）できます。

```bash
npm run backup
```

### バックアップコマンドの動作
このコマンドは内部で以下を行います：
1. 変更があるか確認
2. 全ての変更をステージング (`git add .`)
3. 日付入りのメッセージでコミット (`git commit -m "backup: auto-backup on <timestamp>"`)
4. リモートリポジトリにプッシュ (`git push origin main`)

変更がない場合は何もしません。

