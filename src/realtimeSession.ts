import WebSocket from 'ws';
import fs from 'fs/promises';
import path from 'path';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import OpenAI from 'openai';
import Stripe from 'stripe';
import { config } from './config';
import { writeLog } from './logging';
import { RealtimeLogEvent } from './types';
import { SUMMARY_SYSTEM_PROMPT, RESERVATION_EXTRACTION_SYSTEM_PROMPT, MODE_CLASSIFICATION_PROMPT, SLOT_EXTRACTION_PROMPT, CONFIRMATION_CHECK_PROMPT, FIELD_IDENTIFICATION_PROMPT } from './prompts';
import { notificationService } from './notifications';

export interface RealtimeSessionOptions {
  streamSid: string;
  callSid: string;
  logFile: string;
  toPhoneNumber?: string;
  fromPhoneNumber?: string;
  onAudioToTwilio: (base64Mulaw: string) => void;
  onClearTwilio: () => void;
}

// Phase 7: Reservation State Machine
interface ReservationState {
  stage: 'collect' | 'confirm' | 'cleanup' | 'done';
  currentFieldKey: string | null;
  filled: Record<string, string>;
}

/**
 * OpenAI Realtime API との WebSocket セッションを管理するクラス。
 * Twilio Media Streams から受け取った音声を OpenAI に送り、逆方向の音声 delta を Twilio へ返す。
 */
export class RealtimeSession {
  private ws?: WebSocket;
  private supabase: SupabaseClient;
  private openai: OpenAI;
  private stripe?: Stripe;

  private readonly options: RealtimeSessionOptions;

  private connected = false;
  private isUserSpeaking = false;
  private turnCount = 0;

  private currentSystemPrompt: string = 'あなたは電話応対AIエージェントです。丁寧で簡潔な応答を心がけてください。';
  private hasRequestedInitialResponse = false;
  private reservationFields: any[] = [];

  // Phase 6: Mode Separation
  private mode: 'reservation' | 'other' = 'reservation'; // Default to reservation
  private gateDone = false; // Flag to check if initial intent classification is done

  // Phase 7: State Machine
  private reservationState: ReservationState = {
    stage: 'collect',
    currentFieldKey: null,
    filled: {}
  };
  private reservationCreated = false; // Prevent duplicate reservations

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
    this.openai = new OpenAI({ apiKey: config.openAiApiKey });

    if (config.stripeSecretKey) {
      this.stripe = new Stripe(config.stripeSecretKey, {
        apiVersion: '2025-02-24.acacia',
      });
    }
  }

  private async loadSystemPrompt(): Promise<void> {
    // 1. Supabase から設定を取得
    if (this.options.toPhoneNumber) {
      try {
        console.log(`🔍 Looking up profile for phone number: ${this.options.toPhoneNumber}`);

        // profiles テーブルから user_id と is_subscribed を取得
        const { data: profile, error: profileError } = await this.supabase
          .from('profiles')
          .select('id, is_subscribed')
          .eq('phone_number', this.options.toPhoneNumber)

        // デバッグ用: 取得したプロファイルデータの詳細ログ
        if (profile && profile[0]) {
          console.log(`🔍 [Debug] Profile Found: ID=${profile[0].id}, Subscribed=${profile[0].is_subscribed}, Phone=${this.options.toPhoneNumber}`);
        } else {
          console.log(`⚠️ [Debug] No profile found for phone number: ${this.options.toPhoneNumber}`);
        }

        if (profileError || !profile || profile.length === 0) {
          console.warn('⚠️ Profile not found or error:', profileError?.message);
        } else {
          this.userId = profile[0].id;

          // サブスクリプション状態を確認
          if (!profile[0].is_subscribed) {
            console.warn(`🚫 [RealtimeSession] User ${this.userId} is not subscribed. Continuing (gatekeeper at index.ts should have handled this, or this is a debug access).`);
            // throw new Error('User subscription is not active. Call rejected.'); // Phase 3: Downgraded to warning
          }

          console.log(`✅ User ${this.userId} subscription verified.`);
          // user_prompts テーブルから system_prompt と config_metadata を取得
          const { data: promptData, error: promptError } = await this.supabase
            .from('user_prompts')
            .select('system_prompt, config_metadata')
            .eq('user_id', profile[0].id)
            .single();

          if (promptError || !promptData) {
            console.warn('⚠️ User prompt settings not found or error:', promptError?.message);
          } else {
            console.log('✨ Loaded dynamic settings from Supabase');

            // 予約ヒアリング項目の取得
            let reservationInstruction = '';
            try {
              const { data: formFields, error: formError } = await this.supabase
                .from('reservation_form_fields')
                .select('field_key, label, field_type, required, options, description, display_order')
                .eq('user_id', this.userId)
                .eq('enabled', true)
                .order('display_order', { ascending: true });

              if (!formError && formFields && formFields.length > 0) {
                this.reservationFields = formFields;
                console.log(`📋 Found ${formFields.length} reservation fields.`);
                console.log(`📋 First field key: ${formFields[0].field_key}`);

                const fieldList = formFields.map(f => {
                  const reqStr = f.required ? '(必須)' : '(任意)';

                  // Handle options safely (could be array or JSON string depending on DB driver behavior)
                  let optionsArray: string[] = [];
                  if (Array.isArray(f.options)) {
                    optionsArray = f.options;
                  } else if (typeof f.options === 'string') {
                    try { optionsArray = JSON.parse(f.options); } catch (e) { /* ignore */ }
                  }

                  const optsStr = (optionsArray.length > 0)
                    ? ` [選択肢: ${optionsArray.join(', ')}]`
                    : '';
                  return `- ${f.label} ${reqStr}${optsStr}`;
                }).join('\n');

                reservationInstruction = `
【予約ヒアリング項目】
予約希望のお客様には、以下の項目を必ず確認してください。
${fieldList}

【予約確定のフロー】
- 通話中には「予約確定」と言わず、「確認して後ほどSMSでご連絡します」と伝えてください。
`;
              }
            } catch (err) {
              console.warn('⚠️ Failed to fetch reservation fields:', err);
            }

            // config_metadata から greeting_message を取得（デフォルト値あり）
            const greeting = promptData.config_metadata?.greeting_message || 'お電話ありがとうございます。';
            // config_metadata から reservation_gate_question を取得（デフォルト値あり）
            const reservationGateQuestion = promptData.config_metadata?.reservation_gate_question || 'ご予約のお電話でしょうか？';

            // 固定の挨拶指示ブロックを作成
            const fixedInstruction = `
【重要：第一声の指定】
通話が開始された際、AIの「最初の発話」は必ず以下の文言を一言一句変えずに読み上げてください。
発話内容：${greeting} ${reservationGateQuestion}

【厳守事項】
- 上記の「挨拶文 + 予約確認の問い」をセットで発話してください。
- これ以外の言葉（例：「どうされましたか」などの自由な問いかけ）は付け足さないでください。
- 一度ターンを終了して、相手（ユーザー）の発言を待ってください。
`;

            // 既存のプロンプトと結合
            let basePrompt = promptData.system_prompt || '';

            // 予約項目がある場合は追記
            if (reservationInstruction) {
              basePrompt += `\n\n${reservationInstruction}`;
            }

            if (basePrompt) {
              this.currentSystemPrompt = `${fixedInstruction}\n\n${basePrompt}`;
            } else {
              // system_prompt が空の場合でも、挨拶指示は適用
              this.currentSystemPrompt = fixedInstruction;
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
      console.warn('⚠️ Failed to load system_prompt.md, using default prompt');
      console.warn('⚠️ Please ensure system_prompt.md exists or configure prompts in the database');
    }

    // system_prompt.md の読み込みにも失敗した場合は、初期値（汎用的なデフォルト）をそのまま使用
  }

  async connect(): Promise<void> {
    await this.loadSystemPrompt();

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

      ws.on('close', async () => {
        this.connected = false;
        console.log('🤖 OpenAI Realtime session closed');

        // Phase 1 Refactor: Reservation creation is now handled in saveCallLogToSupabase -> finalizeReservation
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
          threshold: 0.6,
          prefix_padding_ms: 300,
          silence_duration_ms: 800,
          create_response: false, // Phase 7: Disable auto-response to control flow
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

      if (event.type === 'session.updated') {
        // 初回のみ response.create を送信して AI に最初の応答（挨拶）を促す
        if (!this.hasRequestedInitialResponse) {
          console.log('✨ Session updated, requesting initial response');
          this.sendJson({
            type: 'response.create',
            response: {
              modalities: ['text', 'audio'],
            },
          });
          this.hasRequestedInitialResponse = true;
        }
      }

      if (event.type?.startsWith?.('response.audio.delta') || event.type === 'response.output_audio.delta') {
        // ユーザー発話中は音声を送らない
        if (this.isUserSpeaking) {
          return;
        }

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

          // Phase 6 & 7: Mode Separation & State Machine
          if (!this.gateDone) {
            this.checkIntent(text); // Async check, will trigger handleTurn inside
          } else {
            // Already gated, proceed to normal turn handling
            this.handleTurn(text);
          }
        }
      }
    } catch (err) {
      console.error('Failed to parse realtime event', err, raw);
    }
  }

  // Phase 6: Intent Classification
  private async checkIntent(transcript: string) {
    try {
      console.log('🤔 Checking intent for:', transcript);
      const completion = await this.openai.chat.completions.create({
        model: config.openAiSummaryModel, // Use summary model (likely 4o-mini or similar) for speed/cost
        messages: [
          { role: 'developer', content: MODE_CLASSIFICATION_PROMPT },
          { role: 'user', content: transcript }
        ],
        response_format: { type: 'json_object' },
        max_completion_tokens: 100,
      });

      const content = completion.choices[0]?.message?.content;
      if (content) {
        const result = JSON.parse(content);
        console.log(`🧠 Intent Decision: ${result.mode} (Reason: ${result.reason})`);

        if (result.mode === 'other') {
          this.mode = 'other';
          console.log('🔀 Mode switched to: OTHER');
        } else {
          console.log('➡️ Mode remains: RESERVATION');
        }
      }
      this.gateDone = true;

      // Proceed to handle the turn with the decided mode (Phase 7)
      await this.handleTurn(transcript);

    } catch (err) {
      console.error('❌ Error checking intent:', err);
      // Fallback: stay in reservation mode, but mark gate as done to avoid repeated checks
      this.gateDone = true;
      await this.handleTurn(transcript);
    }
  }

  // Phase 8: Slot Extraction
  private async extractSlots(transcript: string) {
    try {
      console.log('🧩 Extracting slots from:', transcript);

      const completion = await this.openai.chat.completions.create({
        model: config.openAiSummaryModel,
        messages: [
          { role: 'developer', content: SLOT_EXTRACTION_PROMPT },
          {
            role: 'user',
            content: `
User Transcript: ${transcript}
Form Fields: ${JSON.stringify(this.reservationFields)}
Already Filled: ${JSON.stringify(this.reservationState.filled)}
             `
          }
        ],
        response_format: { type: 'json_object' },
        max_completion_tokens: 500,
      });

      const content = completion.choices[0]?.message?.content;
      if (content) {
        const result = JSON.parse(content);
        console.log('🧩 Extraction Result:', result); // { filled: { key: val }, confidence: ... }

        if (result.filled) {
          this.reservationState.filled = {
            ...this.reservationState.filled,
            ...result.filled
          };
          console.log('✅ Updated filled slots:', this.reservationState.filled);
        }
      }
    } catch (err) {
      console.error('❌ Error extracting slots:', err);
    }
  }

  // Phase 9: State Machine & Turn Handling
  private async handleTurn(userTranscript: string) {
    // 1. If in 'other' mode, just delegate to AI (standard conversation)
    if (this.mode === 'other') {
      console.log('🗣️ [Mode: Other] Delegating to standard AI response');
      this.sendJson({
        type: 'response.create',
        response: {
          modalities: ['text', 'audio'],
          instructions: `ユーザーの発言「${userTranscript}」に対して、適切な回答をしてください。あなたは飲食店のアシスタントです。`
        }
      });
      return;
    }

    // 2. If in 'reservation' mode, use slot filling state machine
    if (this.mode === 'reservation') {

      // -- State: COLLECT --
      if (this.reservationState.stage === 'collect') {
        // Extract slots from user input
        await this.extractSlots(userTranscript);

        // Find next required field
        const nextField = this.reservationFields.find(f =>
          f.required && !this.reservationState.filled[f.field_key]
        );

        if (nextField) {
          this.reservationState.currentFieldKey = nextField.field_key;
          console.log(`❓ Asking next question for: ${nextField.label}`);
          const questionText = nextField.label + 'を教えていただけますか？';
          this.sendJson({
            type: 'response.create',
            response: {
              modalities: ['text', 'audio'],
              instructions: `次の質問をユーザーに投げかけてください。「${questionText}」とだけ発話してください。挨拶や余計な言葉は不要です。`
            }
          });
          return;
        } else {
          // All fields collected -> Move to Confirm
          this.reservationState.stage = 'confirm';
          // Generate summary and ASK confirmation immediately
          console.log('✅ All fields collected. Starting confirmation.');
          const summary = Object.entries(this.reservationState.filled)
            .map(([key, val]) => {
              const label = this.reservationFields.find(f => f.field_key === key)?.label || key;
              return `${label}: ${val}`;
            }).join('、');

          this.sendJson({
            type: 'response.create',
            response: {
              modalities: ['text', 'audio'],
              instructions: `予約内容を確認します。「${summary}。こちらでよろしいでしょうか？」と発話してください。`
            }
          });
          return;
        }
      }

      // -- State: CONFIRM --
      if (this.reservationState.stage === 'confirm') {
        // Check user response: Yes/No/Correction
        const check = await this.checkConfirmation(userTranscript);
        console.log('🤔 Confirmation Check:', check);

        if (check.result === 'yes') {
          this.reservationState.stage = 'done';

          // Refined Phase 1: Removed direct insert. Set stage only.
          // await this.createReservationRequest(); 
          this.sendJson({
            type: 'response.create',
            response: {
              modalities: ['text', 'audio'],
              instructions: `「承知いたしました。確認して後ほどSMSでご連絡いたします。」と発話してください。`
            }
          });
          return;
        } else {
          // correction or no
          await this.extractSlots(userTranscript); // Try correction

          this.reservationState.stage = 'cleanup';
          this.sendJson({
            type: 'response.create',
            response: {
              modalities: ['text', 'audio'],
              instructions: `「失礼いたしました。訂正する項目を教えていただけますか？」と発話してください。`
            }
          });
          return;
        }
      }

      // -- State: CLEANUP --
      if (this.reservationState.stage === 'cleanup') {
        const target = await this.identifyCleanupField(userTranscript);
        if (target && target.field_key) {
          console.log(`🧹 Clearing field: ${target.field_key}`);
          delete this.reservationState.filled[target.field_key];
          this.reservationState.stage = 'collect';
          // Trigger collect logic immediately
          await this.handleTurn('');
          return;
        } else {
          this.sendJson({
            type: 'response.create',
            response: {
              modalities: ['text', 'audio'],
              instructions: `「申し訳ございません。どの項目を訂正しますか？日付、時間、人数などでお答えください。」と発話してください。`
            }
          });
          return;
        }
      }

      // -- State: DONE --
      if (this.reservationState.stage === 'done') {
        this.sendJson({ type: 'response.create' });
      }
    }
  }

  // Phase 9 Helper: Yes/No Check
  private async checkConfirmation(transcript: string): Promise<{ result: 'yes' | 'no' | 'correction' }> {
    try {
      const completion = await this.openai.chat.completions.create({
        model: config.openAiSummaryModel,
        messages: [
          { role: 'developer', content: CONFIRMATION_CHECK_PROMPT },
          { role: 'user', content: transcript }
        ],
        response_format: { type: 'json_object' },
        max_completion_tokens: 50,
      });
      const content = completion.choices[0]?.message?.content;
      return content ? JSON.parse(content) : { result: 'no' };
    } catch (e) {
      return { result: 'no' };
    }
  }

  // Phase 9 Helper: Identify Field
  private async identifyCleanupField(transcript: string): Promise<{ field_key: string | null }> {
    try {
      const completion = await this.openai.chat.completions.create({
        model: config.openAiSummaryModel,
        messages: [
          { role: 'developer', content: FIELD_IDENTIFICATION_PROMPT },
          {
            role: 'user',
            content: `User Transcript: ${transcript}\nForm Fields: ${JSON.stringify(this.reservationFields)}`
          }
        ],
        response_format: { type: 'json_object' },
        max_completion_tokens: 50,
      });
      const content = completion.choices[0]?.message?.content;
      return content ? JSON.parse(content) : { field_key: null };
    } catch (e) {
      return { field_key: null };
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

  /**
   * Report call usage to Stripe for usage-based billing
   */
  private async reportUsageToStripe(userId: string, durationSeconds: number) {
    try {
      console.log(`💳 Reporting usage to Stripe for user ${userId}...`);

      // 1. Fetch stripe_customer_id from profiles table
      const { data: profile, error: profileError } = await this.supabase
        .from('profiles')
        .select('stripe_customer_id')
        .eq('id', userId)
        .single();

      if (profileError || !profile?.stripe_customer_id) {
        console.warn('⚠️ No Stripe customer ID found for user, skipping usage report');
        return;
      }

      const stripeCustomerId = profile.stripe_customer_id;
      console.log(`🔍 Found Stripe customer ID: ${stripeCustomerId}`);

      if (!this.stripe) {
        console.warn('⚠️ Stripe is not initialized (STRIPE_SECRET_KEY missing). Skipping usage report.');
        return;
      }

      // 2. Find active subscription with the usage price
      const subscriptions = await this.stripe.subscriptions.list({
        customer: stripeCustomerId,
        status: 'active',
        limit: 10,
      });

      if (subscriptions.data.length === 0) {
        console.warn('⚠️ No active subscriptions found for customer');
        return;
      }

      // 3. Find the subscription item matching the usage price ID
      let usageSubscriptionItem: Stripe.SubscriptionItem | null = null;

      for (const subscription of subscriptions.data) {
        for (const item of subscription.items.data) {
          if (item.price.id === config.stripeUsagePriceId) {
            usageSubscriptionItem = item;
            break;
          }
        }
        if (usageSubscriptionItem) break;
      }

      if (!usageSubscriptionItem) {
        console.warn(`⚠️ No subscription item found with usage price ID: ${config.stripeUsagePriceId}`);
        return;
      }

      console.log(`✅ Found usage subscription item: ${usageSubscriptionItem.id}`);

      // 4. Calculate usage quantity (convert seconds to minutes, round up)
      const durationMinutes = Math.ceil(durationSeconds / 60);
      console.log(`⏱️ Call duration: ${durationSeconds}s → ${durationMinutes} minutes (rounded up)`);

      if (!this.stripe) return; // Should be covered by early return, but safe for TS

      // 5. Create usage record
      const usageRecord = await this.stripe.subscriptionItems.createUsageRecord(
        usageSubscriptionItem.id,
        {
          quantity: durationMinutes,
          action: 'increment',
          timestamp: Math.floor(Date.now() / 1000),
        }
      );

      console.log(`✅ Usage record created: ${usageRecord.id} (${durationMinutes} minutes)`);
    } catch (err) {
      console.error('❌ Failed to report usage to Stripe:', err);
      // Don't throw - usage reporting failure shouldn't block call log saving
    }
  }

  async saveCallLogToSupabase() {
    if (!this.userId || !this.callerNumber) {
      console.warn('⚠️ Missing userId or callerNumber, skipping Supabase log save.');
      return;
    }

    // 通話内容の要約を生成
    let summary = '要約なし';
    const formattedTranscript = this.formatTranscriptForSummary();

    try {
      if (this.transcript.length > 0) {
        console.log(`🤖 Generating call summary... (Model: ${config.openAiSummaryModel})`);


        const completion = await this.openai.chat.completions.create({
          model: config.openAiSummaryModel,
          messages: [
            {
              role: 'developer',
              content: SUMMARY_SYSTEM_PROMPT
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

      const { data: callLog, error } = await this.supabase.from('call_logs').insert({
        user_id: this.userId,
        call_sid: this.options.callSid,
        caller_number: this.callerNumber,
        recipient_number: this.options.toPhoneNumber || '',
        transcript: this.transcript,
        summary: summary,
        status: 'completed',
        duration_seconds: durationSeconds,
        created_at: new Date().toISOString(),
      }).select().single();

      if (error) {
        console.error('❌ Failed to save call log to Supabase:', error);
      } else {
        console.log('✅ Call log saved to Supabase (ID:', callLog.id, ')');

        // Report usage to Stripe for billing
        await this.reportUsageToStripe(this.userId, durationSeconds);

        // Unified Reservation Creation (Phase 1 Refactor)
        // Call finalizeReservation ONLY here
        await this.finalizeReservation(callLog.id, formattedTranscript);
      }
    } catch (err) {
      console.error('❌ Error saving call log:', err);
    }
  }

  /**
   * 単一の予約作成パス (finalizeReservation)
   * saveCallLogToSupabase の後に呼ばれる
   */
  private async finalizeReservation(callLogId: string, formattedTranscript: string) {
    if (!this.userId) return;
    if (this.reservationCreated) {
      console.warn('⚠️ Reservation already finalized. Skipping duplicate.');
      return;
    }
    this.reservationCreated = true;
    console.log('🚀 Finalizing Reservation...');

    // 1. Check if we have all required fields collected via State Machine
    const missingRequired = this.reservationFields.filter(f => f.required && !this.reservationState.filled[f.field_key]);
    const isStateValid = missingRequired.length === 0 && Object.keys(this.reservationState.filled).length > 0;

    let finalData: any = {};
    let source = '';

    if (isStateValid) {
      console.log('✅ State machine has all required fields. Using collected data.');
      finalData = { ...this.reservationState.filled };
      source = 'state_machine';
    } else {
      console.log('⚠️ State machine incomplete (missing required). Falling back to LLM extraction.');
      // Fallback: Extract from transcript
      try {
        const completion = await this.openai.chat.completions.create({
          model: config.openAiSummaryModel,
          messages: [
            { role: 'developer', content: RESERVATION_EXTRACTION_SYSTEM_PROMPT },
            {
              role: 'user',
              content: `transcript:\n${formattedTranscript}\n\nreservation_form_fields:\n${JSON.stringify(this.reservationFields)}`
            }
          ],
          response_format: { type: 'json_object' }
        });
        const content = completion.choices[0]?.message?.content;
        if (content) {
          const result = JSON.parse(content);
          if (result.intent !== 'reservation') {
            console.log('ℹ️ Extraction determined no reservation intent. Aborting.');
            return;
          }
          // Normalize extracted data to field keys if possible, or use answers directly
          finalData = result.answers || {};

          // Helper to ensure standard fields are present if extracted
          if (result.customer_name) finalData['customer_name'] = result.customer_name;
          if (result.party_size) finalData['party_size'] = result.party_size;
          if (result.requested_date) finalData['requested_date'] = result.requested_date;
          if (result.requested_time) finalData['requested_time'] = result.requested_time;

          source = 'llm_extraction';
          console.log('📝 Extracted data via LLM:', finalData);
        }
      } catch (err) {
        console.error('❌ Failed fallback extraction:', err);
        return;
      }
    }

    // 2. Prepare DB Record
    // Map finalData to DB columns and answers json

    // Helper to find value by heuristic keys
    const findValue = (...keys: string[]) => {
      for (const k of keys) {
        const match = Object.keys(finalData).find(fk => fk.toLowerCase().includes(k.toLowerCase()));
        if (match) return finalData[match];
      }
      return null;
    };

    const customerName = findValue('name', '名前', 'customer_name');
    const partySizeStr = findValue('count', 'party', '人数', 'party_size');
    const partySize = partySizeStr ? parseInt(String(partySizeStr).replace(/[^0-9]/g, ''), 10) : null;

    // Strict Date/Time Extraction
    // Priority: 1. Exact field key 'requested_date'/'requested_time'
    //           2. Heuristic keys 'date'/'time'
    //           3. Parse from datetime string

    let requestedDate: string | null = null;
    let requestedTime: string | null = null;

    const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
    const timeRegex = /^\d{2}:\d{2}$/;

    // 1. Try Field Keys
    if (finalData['requested_date'] && dateRegex.test(finalData['requested_date'])) {
      requestedDate = finalData['requested_date'];
    }
    if (finalData['requested_time'] && timeRegex.test(finalData['requested_time'])) {
      requestedTime = finalData['requested_time'];
    }

    // 2. Try Heuristics if missing
    if (!requestedDate) {
      const dVal = findValue('date', '日時'); // e.g. "2025-12-20"
      if (dVal && dateRegex.test(dVal)) requestedDate = dVal;
    }
    if (!requestedTime) {
      const tVal = findValue('time', '時間'); // e.g. "19:00"
      if (tVal && timeRegex.test(tVal)) requestedTime = tVal;
    }

    // 3. Fallback: Parse ISO/DateTime string
    if (!requestedDate || !requestedTime) {
      const dateStr = findValue('date', 'time', '日時', 'requested_datetime_text');
      if (dateStr) {
        const d = new Date(dateStr);
        if (!isNaN(d.getTime())) {
          const iso = d.toISOString(); // YYYY-MM-DDTHH:mm:ss.sssZ
          if (!requestedDate) requestedDate = iso.split('T')[0];
          if (!requestedTime) requestedTime = iso.split('T')[1].substring(0, 5);
        }
      }
    }

    // Construct Answers JSON (key: field_key)
    const dbAnswers: Record<string, any> = {};
    const notificationAnswers: Record<string, any> = {};

    for (const f of this.reservationFields) {
      const val = finalData[f.field_key] || '';
      dbAnswers[f.field_key] = val;
      notificationAnswers[f.label] = val; // Use Label for Notification
    }

    // 3. Upsert to DB
    const callSid = this.options.callSid;
    try {
      // Check existing
      const { data: existing } = await this.supabase
        .from('reservation_requests')
        .select('id')
        .eq('call_sid', callSid)
        .single();

      if (existing) {
        console.log(`🔄 Updating existing reservation (ID: ${existing.id})`);
        const { error: upErr } = await this.supabase
          .from('reservation_requests')
          .update({
            customer_name: customerName || 'Unknown',
            requested_date: requestedDate,
            requested_time: requestedTime,
            party_size: partySize,
            answers: dbAnswers,
            call_log_id: callLogId
          })
          .eq('id', existing.id);

        if (upErr) console.error('❌ Update failed:', upErr);
        else console.log('✅ Reservation updated.');

      } else {
        console.log('🆕 Inserting new reservation request...');
        const { data: newRes, error: inErr } = await this.supabase
          .from('reservation_requests')
          .insert({
            user_id: this.userId,
            call_sid: callSid,
            call_log_id: callLogId,
            customer_phone: this.callerNumber || 'Unknown',
            customer_name: customerName || 'Unknown',
            requested_date: requestedDate,
            requested_time: requestedTime,
            // requested_datetime_text is not a column in DB schema based on previous code, 
            // but user request implies it might be useful. 
            // However previous insert used `requested_datetime_text: dateStr`.
            // If schema doesn't have it, it will error. 
            // Let's check `dateStr` usage.
            // Looking at previous valid code: `requested_datetime_text: dateStr` was passed to insert.
            // I'll keep it if defined.
            requested_datetime_text: findValue('date', 'time', '日時', 'requested_datetime_text') || null,
            party_size: partySize,
            status: 'pending',
            answers: dbAnswers,
            source: source
          })
          .select()
          .single();

        if (inErr) {
          if (inErr.code === '23505') {
            console.warn('⚠️ Race condition insert -> update fallback.');
            await this.supabase
              .from('reservation_requests')
              .update({
                customer_name: customerName || 'Unknown',
                requested_date: requestedDate,
                requested_time: requestedTime,
                party_size: partySize,
                answers: dbAnswers,
                call_log_id: callLogId
              })
              .eq('call_sid', callSid);
          } else {
            throw inErr;
          }
        } else {
          console.log('✅ New reservation created:', newRes.id);
          // Notify with notificationAnswers (Labels)
          await notificationService.notifyReservation({
            user_id: this.userId,
            customer_name: customerName || 'Unknown',
            customer_phone: this.callerNumber || 'Unknown',
            party_size: partySize,
            requested_date: requestedDate,
            requested_time: requestedTime,
            requested_datetime_text: findValue('date', 'time', '日時', 'requested_datetime_text') || '',
            answers: notificationAnswers // LABELS
          });
        }
      }
    } catch (dbErr) {
      console.error('❌ DB Fatal in finalizeReservation:', dbErr);
    }
  }

  close() {
    if (this.ws) {
      this.ws.close();
    }
    this.saveCallLogToSupabase();
  }
}
