import WebSocket from 'ws';
import fs from 'fs/promises';
import path from 'path';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import OpenAI from 'openai';
import { config } from './config';
import { writeLog } from './logging';
import { RealtimeLogEvent } from './types';

export interface RealtimeSessionOptions {
  streamSid: string;
  callSid: string;
  logFile: string;
  toPhoneNumber?: string;
  fromPhoneNumber?: string;
  onAudioToTwilio: (base64Mulaw: string) => void;
  onClearTwilio: () => void;
}

/**
 * OpenAI Realtime API との WebSocket セッションを管理するクラス。
 * Twilio Media Streams から受け取った音声を OpenAI に送り、逆方向の音声 delta を Twilio へ返す。
 */
export class RealtimeSession {
  private ws?: WebSocket;
  private supabase: SupabaseClient;
  private openai: OpenAI;

  private readonly options: RealtimeSessionOptions;

  private connected = false;
  private isUserSpeaking = false;
  private turnCount = 0;
  private currentSystemPrompt: string = config.openAiRealtimeSystemPrompt;
  private currentGreeting: string = 'お電話ありがとうございます。';
  private isInitialGreetingSent = false;

  private userId?: string;
  private callerNumber?: string;
  private transcript: { role: string; text: string; timestamp: string }[] = [];
  private startTime: number;

  constructor(options: RealtimeSessionOptions) {
    this.startTime = Date.now();
    this.options = options;
    this.callerNumber = options.fromPhoneNumber;
    this.supabase = createClient(config.supabaseUrl, config.supabaseServiceRoleKey);
    this.openai = new OpenAI({ apiKey: config.openAiApiKey });
  }

  private async loadSystemPrompt(): Promise<void> {
    // 1. Supabase から設定を取得
    if (this.options.toPhoneNumber) {
      try {
        console.log(`🔍 Looking up profile for phone number: ${this.options.toPhoneNumber}`);

        // profiles テーブルから user_id を取得
        const { data: profile, error: profileError } = await this.supabase
          .from('profiles')
          .select('id')
          .eq('phone_number', this.options.toPhoneNumber)

        if (profileError || !profile || profile.length === 0) {
          console.warn('⚠️ Profile not found or error:', profileError?.message);
        } else {
          this.userId = profile[0].id;
          // user_prompts テーブルから設定を取得
          const { data: promptData, error: promptError } = await this.supabase
            .from('user_prompts')
            .select('greeting_message, business_description')
            .eq('user_id', profile[0].id)
            .single();

          if (promptError || !promptData) {
            console.warn('⚠️ User prompt settings not found or error:', promptError?.message);
          } else {
            console.log('✨ Loaded dynamic settings from Supabase');

            // プロンプト構築
            if (promptData.business_description) {
              this.currentSystemPrompt = `
あなたは電話応対AIエージェントです。
以下の店舗情報に基づき、丁寧に応対してください。

【店舗情報】
${promptData.business_description}

【基本ルール】
- 丁寧で簡潔な応答を心がけてください。
- 不確かな情報は推測せず、専門的な判断や確約は避け、必要に応じて確認を提案してください。
`.trim();
            }

            // 挨拶文設定
            if (promptData.greeting_message) {
              this.currentGreeting = promptData.greeting_message;
            }
            return; // Supabase から取得できた場合はここで終了
          }
        }
      } catch (err) {
        console.error('❌ Failed to fetch from Supabase:', err);
      }
    }

    // 2. フォールバック: system_prompt.md
    const mdPath = path.join(process.cwd(), 'system_prompt.md');
    try {
      const content = await fs.readFile(mdPath, 'utf-8');
      if (content) {
        console.log('📄 Loaded system prompt from system_prompt.md');
        this.currentSystemPrompt = content;
        return;
      }
    } catch (error) {
      console.warn('⚠️ Failed to load system_prompt.md, falling back to env var');
    }

    // 3. フォールバック: 環境変数 (初期値のまま)
  }

  async connect(): Promise<void> {
    await this.loadSystemPrompt();
    this.isInitialGreetingSent = false;

    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`wss://api.openai.com/v1/realtime?model=${config.openAiRealtimeModel}`, {
        headers: {
          Authorization: `Bearer ${config.openAiApiKey}`,
          'OpenAI-Beta': 'realtime=v1',
        },
      });

      ws.on('open', () => {
        this.connected = true;
        this.ws = ws;
        console.log('🤖 OpenAI Realtime session connected');
        this.sendSessionUpdate();
        resolve();
      });

      ws.on('message', (data: WebSocket.RawData) => {
        this.handleRealtimeEvent(data.toString());
      });

      ws.on('close', () => {
        this.connected = false;
        console.log('🤖 OpenAI Realtime session closed');
      });

      ws.on('error', (err: Error) => {
        console.error('Realtime session error', err);
        reject(err);
      });
    });
  }

  private sendSessionUpdate() {
    const payload = {
      type: 'session.update',
      session: {
        instructions: this.currentSystemPrompt,
        turn_detection: {
          type: 'server_vad',
          threshold: 0.5,
          prefix_padding_ms: 300,
          silence_duration_ms: 500,
          create_response: true,
          interrupt_response: true,
        },
        input_audio_format: 'g711_ulaw',
        output_audio_format: 'g711_ulaw',
        voice: 'coral',
        input_audio_transcription: {
          model: 'whisper-1',
        },
      },
    };
    this.sendJson(payload);
  }

  private sendInitialGreeting() {
    const instructionText = `以下のテキストを、一言一句変更せず、そのまま読み上げてください：\n\n${this.currentGreeting}`;
    const itemPayload = {
      type: 'conversation.item.create',
      item: {
        type: 'message',
        role: 'system',
        content: [{ type: 'input_text', text: instructionText }]
      }
    };
    this.sendJson(itemPayload);

    const responsePayload = {
      type: 'response.create',
      response: {
        modalities: ['text', 'audio'],
      },
    };
    this.sendJson(responsePayload);
  }

  sendAudio(g711_ulaw: Buffer) {
    if (!this.connected || !this.ws) return;
    const payload = {
      type: 'input_audio_buffer.append',
      audio: g711_ulaw.toString('base64'),
    };
    this.sendJson(payload);
  }

  /** Twilio へ音声を送り返すためのヘルパー */
  private forwardAudioToTwilioFromBase64(base64Mulaw: string) {
    this.options.onAudioToTwilio(base64Mulaw);
  }

  private async handleRealtimeEvent(raw: string) {
    try {
      const event = JSON.parse(raw);
      if (event.type === 'response.created') {
        // response.created handling if needed
      }

      if (event.type === 'session.updated') {
        if (!this.isInitialGreetingSent) {
          console.log('✨ Session updated, sending initial greeting');
          this.sendInitialGreeting();
          this.isInitialGreetingSent = true;
        }
      }

      if (event.type?.startsWith?.('response.audio.delta') || event.type === 'response.output_audio.delta') {
        // ユーザー発話中は音声を送らない
        if (this.isUserSpeaking) {
          return;
        }

        const responseId = event.response_id;

        const base64Mulaw = event.delta ?? event.audio?.data;
        if (base64Mulaw) {
          this.forwardAudioToTwilioFromBase64(base64Mulaw);
        }
      }

      if (event.type === 'response.done') {
        const output = event.response?.output || [];
        const textParts = output
          .map((item: any) => item.content?.map((c: any) => c.text || c.transcript).join(''))
          .filter((t: any) => t);
        const text = textParts.join(' ');

        if (text) {
          this.turnCount++;
          this.logEvent({
            event: 'assistant_response',
            role: 'assistant',
            text,
            turn: this.turnCount
          });
          this.transcript.push({ role: 'assistant', text, timestamp: new Date().toISOString() });
          console.log(`🤖 AI応答 #${this.turnCount}: ${text}`);
        }
      }

      if (event.type === 'input_audio_buffer.speech_started') {
        console.log('🎤 ユーザー発話開始 (Barge-in)');
        this.isUserSpeaking = true;
        this.options.onClearTwilio(); // Twilioのバッファをクリア
        this.sendJson({ type: 'response.cancel' }); // OpenAIの生成をキャンセル
      }

      if (event.type === 'input_audio_buffer.speech_stopped') {
        this.isUserSpeaking = false;
      }

      if (event.type === 'conversation.item.input_audio_transcription.completed') {
        const text = event.transcript;
        if (text) {
          this.turnCount++;
          this.logEvent({
            event: 'user_utterance',
            role: 'user',
            text,
            turn: this.turnCount
          });
          this.transcript.push({ role: 'user', text, timestamp: new Date().toISOString() });
          console.log(`🗣️ ユーザー発話 #${this.turnCount}: ${text}`);
        }
      }
    } catch (err) {
      console.error('Failed to parse realtime event', err, raw);
    }
  }

  private sendJson(payload: any) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify(payload));
  }

  private async logEvent(partial: Omit<RealtimeLogEvent, 'timestamp' | 'streamSid'>) {
    const event: RealtimeLogEvent = {
      timestamp: new Date().toISOString(),
      streamSid: this.options.streamSid,
      callSid: this.options.callSid,
      ...partial,
    };
    await writeLog(this.options.logFile, event);
  }

  /**
   * トランスクリプトを要約生成用に整形する
   * 例: "user: こんにちは\nassistant: お電話ありがとうございます..."
   */
  private formatTranscriptForSummary(): string {
    return this.transcript
      .map(item => `${item.role}: ${item.text}`)
      .join('\n');
  }

  async saveCallLogToSupabase() {
    if (!this.userId || !this.callerNumber) {
      console.warn('⚠️ Missing userId or callerNumber, skipping Supabase log save.');
      return;
    }

    // 通話内容の要約を生成
    let summary = '要約なし';
    try {
      if (this.transcript.length > 0) {
        console.log(`🤖 Generating call summary... (Model: ${config.openAiSummaryModel})`);
        const formattedTranscript = this.formatTranscriptForSummary();

        const completion = await this.openai.chat.completions.create({
          model: config.openAiSummaryModel,
          messages: [
            {
              role: 'developer',
              content: `あなたは、AI電話オペレーターの通話ログを要約するアシスタントです。
入力として、日本語の通話全文テキスト（発信者・AI両方の発話）が与えられます。

出力は、日本語テキストで次のルールに従ってください：

1. 1行目は「通話内容の本質が一目で分かるタイトル」にします。
   - 最大20文字程度に収めてください。
   - 要件の種類（例：予約／キャンセル／折り返し依頼／クレーム／問い合わせ など）を必ず含めてください。
   - 特に重要な情報があれば可能な範囲で含めてください。
   - 例：「【予約】12/3 19時 2名／コース確認の問い合わせ」
        「【クレーム】ラーメンの味に不満／店長に相談希望」
        「【折り返し希望】担当者不在のため明日午前に連絡依頼」

2. 2行目以降に、通話内容の詳細な要約を書いてください。
   - 箇条書き（「・」から始める）で、次の情報をわかりやすく整理してください：
     ・誰からの電話か（分かる範囲で：例「常連客」「初めての客」「取引先」など）
     ・主な要件／相談内容
     ・希望日時・人数・メニュー・金額などの具体条件（あれば）
     ・店舗側が今後とるべきアクション（折り返し電話、予約確定、確認が必要な点 など）
     ・緊急度や注意点（例：「急ぎ」「トラブル要注意」「感情的になっている」など）

3. あいさつや雑談など、ビジネス上重要でない部分はできるだけ省略し、
   要件・約束事項・対応タスクを中心に要約してください。

4. 出力は純粋な要約テキストのみとし、「要約:」「タイトル:」などのラベルや説明文は付けないでください。
   1行目と2行目以降は、必ず改行で区切ってください。
`
            },
            {
              role: 'user',
              content: formattedTranscript
            }
          ],

          // 要約APIは Responses エンドポイント(Chat Completions) + max_completion_tokens を使う
          max_completion_tokens: 1000,
        });

        console.log('🔍 OpenAI Summary Response:', JSON.stringify(completion, null, 2));

        const generatedSummary = completion.choices[0]?.message?.content?.trim();
        if (generatedSummary) {
          summary = generatedSummary;
          console.log(`✨ Generated summary: "${summary}"`);
        } else {
          console.warn('⚠️ Summary generation returned empty content.');
        }
      }
    } catch (err) {
      console.error('⚠️ Failed to generate summary, using default:', err);
      // エラーが発生してもDB保存は継続する
    }

    // Supabaseへ保存
    try {
      const endTime = Date.now();
      const durationSeconds = Math.round((endTime - this.startTime) / 1000);
      console.log('⏱️ Call duration:', durationSeconds, 'seconds');

      const { error } = await this.supabase.from('call_logs').insert({
        user_id: this.userId,
        call_sid: this.options.callSid,
        caller_number: this.callerNumber,
        recipient_number: this.options.toPhoneNumber || '',
        transcript: this.transcript,
        summary: summary,
        status: 'completed',
        duration_seconds: durationSeconds,
        created_at: new Date().toISOString(),
      });
      if (error) {
        console.error('❌ Failed to save call log to Supabase:', error);
      } else {
        console.log('✅ Call log saved to Supabase');
      }
    } catch (err) {
      console.error('❌ Error saving call log:', err);
    }
  }

  close() {
    if (this.ws) {
      this.ws.close();
    }
    this.saveCallLogToSupabase();
  }
}
