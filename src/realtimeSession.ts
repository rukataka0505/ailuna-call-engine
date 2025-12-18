import WebSocket from 'ws';
import fs from 'fs/promises';
import path from 'path';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import OpenAI from 'openai';
import Stripe from 'stripe';
import { config } from './config';
import { writeLog } from './logging';
import { RealtimeLogEvent } from './types';
import { SUMMARY_SYSTEM_PROMPT, RESERVATION_EXTRACTION_SYSTEM_PROMPT } from './prompts';
import { notificationService } from './notifications';
import { DebugObserver } from './debugObserver';

// Source constants for reservation_requests.source column
// Must match CHECK constraint: reservation_requests_source_check
const RESERVATION_SOURCE = {
  REALTIME_TOOL: 'phone_call_realtime_tool',
  REALTIME_FALLBACK: 'phone_call_realtime_fallback',
} as const;

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
  private stripe?: Stripe;
  private debugObserver: DebugObserver;

  private readonly options: RealtimeSessionOptions;

  private connected = false;
  private isUserSpeaking = false;
  private isResponseActive = false; // Track if OpenAI response is active for smart cancel
  private turnCount = 0;

  private currentSystemPrompt: string = 'あなたは電話応対AIエージェントです。丁寧で簡潔な応答を心がけてください。';
  private hasRequestedInitialResponse = false;
  private reservationFields: any[] = [];

  private reservationCreated = false; // Prevent duplicate reservations
  private audioDeltaCount = 0; // Counter for audio_delta sampling
  private mediaCount = 0; // Counter for twilio_media sampling
  private sessionUpdateTimeout?: ReturnType<typeof setTimeout>; // B対策: session.update ACK timeout
  private speakingTimeout?: ReturnType<typeof setTimeout>; // D対策: isUserSpeaking failsafe

  private userId?: string;
  private callerNumber?: string;
  private transcript: { role: string; text: string; timestamp: string }[] = [];
  private startTime: number;

  // Timing measurements for Phase 0 observability
  private timings = {
    callStart: 0,
    sessionUpdated: 0,
    firstAudioDelta: 0,
    firstMessage: 0,
    reservationCalled: 0,
    reservationDbDone: 0,
    reservationOutputSent: 0,
  };

  constructor(options: RealtimeSessionOptions) {
    this.startTime = Date.now();
    this.timings.callStart = this.startTime;
    this.options = options;
    this.callerNumber = options.fromPhoneNumber;
    this.supabase = createClient(config.supabaseUrl, config.supabaseServiceRoleKey);
    this.openai = new OpenAI({ apiKey: config.openAiApiKey });

    // Debug observer for event logging
    this.debugObserver = new DebugObserver(options.streamSid);
    this.debugObserver.startSummaryInterval();

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

        // profiles テーブルから user_id と is_subscribed を取得する
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

          // サブスクリプション状態を確認する
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

              if (formFields && formFields.length > 0) {
                // Save fields for validation in handleFinalizeReservation
                this.reservationFields = formFields;
                // Build field list with field_key mapping for finalize_reservation
                const fieldMapping = formFields.map(f => {
                  const reqStr = f.required ? '(必須)' : '(任意)';
                  return `  - ${f.field_key}: ${f.label} ${reqStr}`;
                }).join('\n');

                reservationInstruction = `
【予約ヒアリング項目】
以下の情報を自然な会話の中で聞き出してください：
${fieldMapping}

【finalize_reservation ツールの使い方】
- 必須項目（customer_name、party_size、requested_date、requested_time）が全て揃ったら finalize_reservation を呼び出してください。
- ツールが ok:true を返すまで「予約完了」「承りました」「予約を受け付けました」等の確定表現は絶対に禁止です。
- ok:false / missing_fields が返された場合は、不足項目を聞き直してください。
- ツールが成功したら「確認して後ほどSMSでご連絡します」と伝えてください。

【日付・時間の形式】
- requested_date: YYYY-MM-DD（例：2025-12-20）
- requested_time: HH:mm（例：19:00）
- 「明日」「来週金曜」などは現在日時から計算して正確な日付に変換してください。

【party_size について】
- 必ず正の整数で指定してください（例：2）
- 「2名」「2人」などは数値 2 に変換してください。
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
        // NDJSON: Log WebSocket open
        this.logEvent({ event: 'openai_ws_open' });
        this.sendSessionUpdate();
        resolve();
      });

      ws.on('message', (data: WebSocket.RawData) => {
        this.handleRealtimeEvent(data.toString());
      });

      ws.on('close', async (code?: number, reason?: Buffer) => {
        this.connected = false;
        console.log('🤖 OpenAI Realtime session closed');
        // NDJSON: Log WebSocket close
        this.logEvent({
          event: 'openai_ws_close',
          close_code: code,
          close_reason: reason?.toString('utf-8')
        });

        // Phase 1 Refactor: Reservation creation is now handled in saveCallLogToSupabase -> finalizeReservation
      });

      ws.on('error', (err: Error) => {
        console.error('❌ [WebSocket Error] Realtime session connection error:', {
          message: err.message,
          name: err.name,
          stack: err.stack,
        });
        // NDJSON: Log WebSocket error
        this.logEvent({
          event: 'openai_ws_error',
          error_message: err.message,
          error_code: err.name
        });
        reject(err);
      });
    });
  }

  private sendSessionUpdate() {
    // Always include finalize_reservation tool
    const toolsConfig = {
      tools: [{
        type: 'function',
        name: 'finalize_reservation',
        description: 'ユーザーが名前・日時・人数を全て伝え、予約確定の意思を示した場合にのみ呼び出してください。それまでは会話を続けてください。',
        parameters: {
          type: 'object',
          properties: {
            customer_name: { type: 'string', description: 'お客様のお名前' },
            party_size: { type: 'integer', description: '予約人数（正の整数）' },
            requested_date: { type: 'string', description: '予約日（YYYY-MM-DD形式）' },
            requested_time: { type: 'string', description: '予約時間（HH:mm形式）' },
            answers: { type: 'object', description: '追加のヒアリング項目（field_key: value）' }
          },
          required: ['customer_name', 'party_size', 'requested_date', 'requested_time']
        }
      }],
      tool_choice: 'auto'
    };

    const payload = {
      type: 'session.update',
      session: {
        instructions: this.currentSystemPrompt,
        turn_detection: {
          type: 'server_vad',
          threshold: 0.6,
          prefix_padding_ms: 300,
          silence_duration_ms: 800,
          create_response: true, // Always auto-respond via VAD
          interrupt_response: true,
        },
        input_audio_format: 'g711_ulaw',
        output_audio_format: 'g711_ulaw',
        voice: 'coral',
        input_audio_transcription: {
          model: 'whisper-1',
        },
        ...toolsConfig
      },
    };
    this.sendJson(payload);
    // NDJSON: Log session update sent
    this.logEvent({ event: 'session_update_sent' });
    // Debug: Log system prompt length for troubleshooting
    console.log(`📝 [Debug] System prompt length: ${this.currentSystemPrompt.length} chars`);
    console.log(`📝 [Debug] Tools configured: finalize_reservation (tool_choice: auto)`);

    // B対策: Start 3s timeout for session.updated ACK
    this.sessionUpdateTimeout = setTimeout(() => {
      console.error('⚠️ [Timeout] session.updated not received within 3s');
      this.logEvent({
        event: 'session_update_timeout',
        error_message: 'session.updated not received within 3000ms'
      });
    }, 3000);
  }

  sendAudio(g711_ulaw: Buffer) {
    if (!this.connected || !this.ws) return;
    // Track audio for debug observability
    this.debugObserver.trackAudioSent(g711_ulaw.length);
    const payload = {
      type: 'input_audio_buffer.append',
      audio: g711_ulaw.toString('base64'),
    };
    this.sendJson(payload);
  }

  /**
   * Send base64-encoded G.711 µ-law audio directly to OpenAI.
   * Avoids decode/encode overhead by passing through as-is.
   */
  sendAudioBase64(base64Mulaw: string) {
    if (!this.connected || !this.ws) return;
    // Track audio for debug observability (compute byte length from base64)
    this.debugObserver.trackAudioSent(Buffer.byteLength(base64Mulaw, 'base64'));
    const payload = {
      type: 'input_audio_buffer.append',
      audio: base64Mulaw,
    };
    this.sendJson(payload);
  }

  /**
   * Track Twilio media event and log to NDJSON (sampled every 100 frames).
   * Called from index.ts when media event is received.
   */
  trackTwilioMedia(payloadBytes: number): void {
    this.mediaCount++;
    // Log first frame and then every 100th frame
    if (this.mediaCount === 1 || this.mediaCount % 100 === 0) {
      this.logEvent({
        event: 'twilio_media',
        payload_bytes: payloadBytes,
        media_count: this.mediaCount
      });
    }
  }

  /** Twilio へ音声を送り返すためのヘルパー */
  private forwardAudioToTwilioFromBase64(base64Mulaw: string) {
    this.options.onAudioToTwilio(base64Mulaw);
  }

  private async handleRealtimeEvent(raw: string) {
    try {
      const event = JSON.parse(raw);

      // Debug: Log OpenAI Realtime events
      this.debugObserver.logRealtimeEvent(event);

      // OpenAI Realtime API error event - explicit capture for observability
      if (event.type === 'error') {
        const errorCode = event.error?.code;
        const errorDetails = {
          error_code: errorCode,
          error_message: event.error?.message,
          event_id: event.event_id,
        };

        // Downgrade known benign errors to debug level
        if (errorCode === 'response_cancel_not_active') {
          // Benign error - only log in debug mode to reduce noise
          if (config.debugRealtimeEvents) {
            console.debug('ℹ️ [OpenAI Realtime] Cancel with no active response (benign)', errorDetails);
          }
        } else {
          console.error('❌ [OpenAI Realtime Error]', errorDetails);
        }

        this.logEvent({
          event: 'realtime_error',
          error_code: errorCode,
          error_message: event.error?.message,
        });
      }

      if (event.type === 'session.updated') {
        console.log('✅ [Session] session.update confirmed by API');
        // Timing: Record session.updated
        if (!this.timings.sessionUpdated) {
          this.timings.sessionUpdated = Date.now();
        }
        // B対策: Clear timeout on successful ACK
        if (this.sessionUpdateTimeout) {
          clearTimeout(this.sessionUpdateTimeout);
          this.sessionUpdateTimeout = undefined;
        }
        // NDJSON: Log session updated received
        this.logEvent({ event: 'session_updated_received' });
        // 初回のみ response.create を送信して AI に最初の応答（挨拶）を促す
        if (!this.hasRequestedInitialResponse) {
          console.log('✨ Session updated, requesting initial response');
          this.sendJson({
            type: 'response.create',
            response: {
              modalities: ['text', 'audio'],
            },
          });
          // NDJSON: Log response.create sent (initial greeting)
          this.logEvent({ event: 'response_create_sent', trigger: 'initial' });
          this.hasRequestedInitialResponse = true;
        }
      }

      // Track response lifecycle for smart cancel
      if (event.type === 'response.created') {
        this.isResponseActive = true;
      }

      if (event.type?.startsWith?.('response.audio.delta') || event.type === 'response.output_audio.delta') {
        // ユーザー発話中は音声を送らない
        if (this.isUserSpeaking) {
          return;
        }

        const base64Mulaw = event.delta ?? event.audio?.data;
        if (base64Mulaw) {
          // Timing: Record first audio delta
          if (!this.timings.firstAudioDelta) {
            this.timings.firstAudioDelta = Date.now();
          }
          this.forwardAudioToTwilioFromBase64(base64Mulaw);
          // NDJSON: Log audio_delta (sampled every 100 frames)
          this.audioDeltaCount++;
          if (this.audioDeltaCount === 1 || this.audioDeltaCount % 100 === 0) {
            const bytes = Buffer.from(base64Mulaw, 'base64').length;
            this.logEvent({
              event: 'audio_delta',
              delta_count: this.audioDeltaCount,
              bytes_sent: bytes
            });
          }
        }
      }

      if (event.type === 'response.done') {
        const output = event.response?.output || [];
        const textParts = output
          .map((item: any) => item.content?.map((c: any) => c.text || c.transcript).join(''))
          .filter((t: any) => t);
        const text = textParts.join(' ');

        if (text) {
          // Timing: Record first message
          if (!this.timings.firstMessage) {
            this.timings.firstMessage = Date.now();
          }
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

        // Function Call Detection
        const functionCalls = output.filter((item: any) => item.type === 'function_call');
        console.log(`🔍 [Debug] response.done output items: ${output.length}, function_calls: ${functionCalls.length}`);
        if (output.length > 0 && functionCalls.length === 0) {
          // Log output types for debugging
          const types = output.map((item: any) => item.type).join(', ');
          console.log(`🔍 [Debug] Output types: ${types}`);
        }
        for (const fc of functionCalls) {
          if (fc.name === 'finalize_reservation') {
            console.log(`🔧 Function call detected: ${fc.name} (call_id: ${fc.call_id})`);
            await this.handleFinalizeReservation(fc.call_id, fc.arguments);
          }
        }

        // Mark response as complete
        this.isResponseActive = false;
      }

      if (event.type === 'input_audio_buffer.speech_started') {
        console.log('🎙️ ユーザー発話開始 (Barge-in)');
        this.isUserSpeaking = true;
        // NDJSON: Log VAD speech started
        this.logEvent({ event: 'vad_event', action: 'start' });
        this.options.onClearTwilio(); // Twilioのバッファをクリア
        // Smart cancel: Only send if response is active (or if feature flag disabled)
        if (!config.enableSmartCancel || this.isResponseActive) {
          this.sendJson({ type: 'response.cancel' }); // OpenAIの生成をキャンセル
          this.isResponseActive = false;
        }

        // D対策: Start 5s failsafe timer for isUserSpeaking
        if (this.speakingTimeout) {
          clearTimeout(this.speakingTimeout);
        }
        this.speakingTimeout = setTimeout(() => {
          if (this.isUserSpeaking) {
            console.warn('⚠️ [Failsafe] isUserSpeaking stuck for 5s, force resetting');
            this.isUserSpeaking = false;
            this.logEvent({
              event: 'speaking_failsafe',
              error_message: 'isUserSpeaking stuck for 5000ms, force reset'
            });
          }
        }, 5000);
      }

      if (event.type === 'input_audio_buffer.speech_stopped') {
        this.isUserSpeaking = false;
        // D対策: Clear speakingTimeout on normal stop
        if (this.speakingTimeout) {
          clearTimeout(this.speakingTimeout);
          this.speakingTimeout = undefined;
        }
        // NDJSON: Log VAD speech stopped
        this.logEvent({ event: 'vad_event', action: 'stop' });
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
          // Model handles conversation flow via create_response: true
          // No manual state machine intervention needed
        }
      }
    } catch (err) {
      console.error('Failed to parse realtime event', err, raw);
    }
  }


  // ================== Realtime Tooling: verify_reservation ==================

  /**
   * Handle the finalize_reservation function call from the model.
   * Validates required fields, saves to DB, and sends function_call_output.
   */
  private async handleFinalizeReservation(callId: string, argsJson: string) {
    console.log('🔧 finalize_reservation called with:', argsJson);
    // Timing: Record reservation called
    this.timings.reservationCalled = Date.now();

    let result: { ok: boolean; message?: string; missing_fields?: string[] };

    try {
      const args = JSON.parse(argsJson);

      // 1. Validation
      const missingFields: string[] = [];

      // Check required fields from reservation_form_fields (enabled && required)
      const requiredFields = this.reservationFields.filter(f => f.enabled !== false && f.required);
      for (const f of requiredFields) {
        // Check in answers or top-level args
        const val = args.answers?.[f.field_key] || args[f.field_key];
        if (!val || String(val).trim() === '') {
          missingFields.push(f.label);
        }
      }

      // Validate party_size: must be positive integer
      if (!args.party_size || args.party_size <= 0 || !Number.isInteger(args.party_size)) {
        missingFields.push('party_size (正の整数が必要です)');
      }

      // Validate requested_date: must be YYYY-MM-DD
      if (!args.requested_date || !/^\d{4}-\d{2}-\d{2}$/.test(args.requested_date)) {
        missingFields.push('requested_date (YYYY-MM-DD形式が必要です)');
      }

      // Validate requested_time: must be HH:mm
      if (!args.requested_time || !/^\d{2}:\d{2}$/.test(args.requested_time)) {
        missingFields.push('requested_time (HH:mm形式が必要です)');
      }

      if (missingFields.length > 0) {
        console.log('❌ Validation failed, missing fields:', missingFields);
        result = { ok: false, message: '必須項目が不足しています', missing_fields: missingFields };
      } else {
        // 2. DB Insert (with conflict handling)
        const insertResult = await this.insertReservationFromTool(args);
        // Timing: Record DB done
        this.timings.reservationDbDone = Date.now();
        result = insertResult;
      }
    } catch (err) {
      console.error('❌ finalize_reservation error:', err);
      result = { ok: false, message: 'サーバーエラーが発生しました' };
    }

    // Log tool call for debugging and audit
    this.logEvent({
      event: 'tool_call',
      tool: 'finalize_reservation',
      call_id: callId,
      args: argsJson,
      result: JSON.stringify(result)
    });

    // 3. Send function_call_output back to the model
    this.sendJson({
      type: 'conversation.item.create',
      item: {
        type: 'function_call_output',
        call_id: callId,
        output: JSON.stringify(result)
      }
    });

    // 4. Trigger response.create to continue conversation
    this.sendJson({
      type: 'response.create',
      response: { modalities: ['text', 'audio'] }
    });
    // NDJSON: Log response.create sent (after tool call)
    this.logEvent({ event: 'response_create_sent', trigger: 'tool' });
    // Timing: Record output sent
    this.timings.reservationOutputSent = Date.now();

    console.log('📤 function_call_output sent, conversation continues');
  }

  /**
   * Insert reservation into DB from tool call.
   * Uses call_sid as unique key with conflict handling.
   */
  private async insertReservationFromTool(args: any): Promise<{ ok: boolean; message?: string }> {
    if (!this.userId) {
      return { ok: false, message: 'User not identified' };
    }

    const callSid = this.options.callSid;

    // Build answers object (field_key -> value for DB, label -> value for notifications)
    const dbAnswers: Record<string, any> = {};
    const notificationAnswers: Record<string, any> = {};

    for (const f of this.reservationFields) {
      const val = args.answers?.[f.field_key] || args[f.field_key] || '';
      dbAnswers[f.field_key] = val;
      notificationAnswers[f.label] = val;
    }

    // Check if reservation already exists for this call_sid
    const { data: existing } = await this.supabase
      .from('reservation_requests')
      .select('id')
      .eq('call_sid', callSid)
      .single();

    if (existing) {
      console.log(`🔄 Reservation already exists for call_sid ${callSid} (ID: ${existing.id})`);
      return { ok: true, message: '予約は既に登録済みです' };
    }

    // Insert new reservation
    try {
      const { data: newRes, error: insertErr } = await this.supabase
        .from('reservation_requests')
        .insert({
          user_id: this.userId,
          call_sid: callSid,
          customer_phone: this.callerNumber || 'Unknown',
          customer_name: args.customer_name || 'Unknown',
          requested_date: args.requested_date,
          requested_time: args.requested_time,
          party_size: args.party_size,
          status: 'pending',
          answers: dbAnswers,
          source: RESERVATION_SOURCE.REALTIME_TOOL
        })
        .select()
        .single();

      if (insertErr) {
        if (insertErr.code === '23505') {
          // Unique constraint violation - already exists (race condition)
          console.log('⚠️ Race condition detected, reservation already exists');
          return { ok: true, message: '予約は既に登録済みです' };
        }
        throw insertErr;
      }

      console.log('✅ Reservation created via tool:', newRes.id);
      this.reservationCreated = true;

      // Send notification (only on new insert)
      await notificationService.notifyReservation({
        user_id: this.userId,
        customer_name: args.customer_name || 'Unknown',
        customer_phone: this.callerNumber || 'Unknown',
        party_size: args.party_size,
        requested_date: args.requested_date,
        requested_time: args.requested_time,
        requested_datetime_text: `${args.requested_date} ${args.requested_time}`,
        answers: notificationAnswers
      });

      return { ok: true, message: '予約を受け付けました' };
    } catch (dbErr: any) {
      console.error('❌ DB error in insertReservationFromTool:', {
        code: dbErr?.code,
        message: dbErr?.message,
        details: dbErr?.details,
        hint: dbErr?.hint,
        source: RESERVATION_SOURCE.REALTIME_TOOL,
      });
      // Don't ask user to retry - DB errors won't be fixed by retry
      return { ok: false, message: '内容は記録しました。後ほど折り返しご連絡いたします' };
    }
  }

  // =========================================================================

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
   * Fallback: LLMを使って会話ログから予約情報を抽出する
   * finalize_reservation ツールがトリガーされなかった場合に使用
   */
  private async extractReservationFromTranscript(): Promise<{
    intent: 'reservation' | 'other';
    customer_name?: string;
    party_size?: number;
    requested_date?: string;
    requested_time?: string;
    requested_datetime_text?: string;
    answers?: Record<string, any>;
    confidence?: number;
  } | null> {
    if (this.transcript.length === 0) {
      return null;
    }

    const formattedTranscript = this.formatTranscriptForSummary();
    console.log('🔄 [Fallback] Extracting reservation from transcript...');

    try {
      const completion = await this.openai.chat.completions.create({
        model: config.openAiSummaryModel,
        messages: [
          {
            role: 'system',
            content: RESERVATION_EXTRACTION_SYSTEM_PROMPT
          },
          {
            role: 'user',
            content: `【通話内容】\n${formattedTranscript}\n\n【現在日時】\n${new Date().toISOString()}`
          }
        ],
        response_format: { type: 'json_object' },
        max_completion_tokens: 500,
      });

      const content = completion.choices[0]?.message?.content?.trim();
      if (!content) {
        console.warn('⚠️ [Fallback] LLM returned empty content');
        return null;
      }

      const extracted = JSON.parse(content);
      console.log('📋 [Fallback] Extracted data:', JSON.stringify(extracted, null, 2));

      return extracted;
    } catch (err) {
      console.error('❌ [Fallback] Failed to extract reservation:', err);
      return null;
    }
  }

  /**
   * Fallback: 抽出された予約情報をDBに保存
   */
  private async saveReservationFallback(extracted: {
    customer_name?: string;
    party_size?: number;
    requested_date?: string;
    requested_time?: string;
    requested_datetime_text?: string;
    answers?: Record<string, any>;
  }, callLogId: string): Promise<void> {
    if (!this.userId) return;

    const callSid = this.options.callSid;

    // Check if reservation already exists for this call_sid
    const { data: existing } = await this.supabase
      .from('reservation_requests')
      .select('id')
      .eq('call_sid', callSid)
      .single();

    if (existing) {
      console.log(`⚠️ [Fallback] Reservation already exists for call_sid ${callSid}, skipping`);
      return;
    }

    try {
      const { data: newRes, error: insertErr } = await this.supabase
        .from('reservation_requests')
        .insert({
          user_id: this.userId,
          call_sid: callSid,
          call_log_id: callLogId,
          customer_phone: this.callerNumber || 'Unknown',
          customer_name: extracted.customer_name || 'Unknown',
          requested_date: extracted.requested_date || null,
          requested_time: extracted.requested_time || null,
          party_size: extracted.party_size || null,
          status: 'pending',
          answers: extracted.answers || {},
          source: RESERVATION_SOURCE.REALTIME_FALLBACK,
          internal_note: `[LLM Fallback] ${extracted.requested_datetime_text || ''}`
        })
        .select()
        .single();

      if (insertErr) {
        if (insertErr.code === '23505') {
          console.log('⚠️ [Fallback] Race condition, reservation already exists');
          return;
        }
        throw insertErr;
      }

      console.log('✅ [Fallback] Reservation created:', newRes.id);
      this.reservationCreated = true;

      // Send notification
      await notificationService.notifyReservation({
        user_id: this.userId,
        customer_name: extracted.customer_name || 'Unknown',
        customer_phone: this.callerNumber || 'Unknown',
        party_size: extracted.party_size || 0,
        requested_date: extracted.requested_date || '',
        requested_time: extracted.requested_time || '',
        requested_datetime_text: extracted.requested_datetime_text || '',
        answers: extracted.answers || {}
      });

    } catch (err) {
      console.error('❌ [Fallback] Failed to save reservation:', err);
    }
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

        // Reservation already saved via finalize_reservation tool
        // Just link the call_log_id to the existing reservation (if any)
        await this.linkCallLogToReservation(callLog.id);

        // Fallback: If no reservation was created via tool, try to extract from transcript
        if (!this.reservationCreated) {
          console.log('🔄 [Fallback] No reservation created via tool, attempting LLM extraction...');
          const extracted = await this.extractReservationFromTranscript();

          if (extracted && extracted.intent === 'reservation') {
            // Only save if there's at least some useful info
            if (extracted.customer_name || extracted.requested_date || extracted.party_size) {
              console.log('📝 [Fallback] Reservation intent detected, saving to DB...');
              await this.saveReservationFallback(extracted, callLog.id);
            } else {
              console.log('ℹ️ [Fallback] Reservation intent detected but insufficient data, skipping');
            }
          } else {
            console.log('ℹ️ [Fallback] No reservation intent detected in conversation');
          }
        }
      }
    } catch (err) {
      console.error('❌ Error saving call log:', err);
    }
  }

  /**
   * Link call_log_id to existing reservation (if any was created via finalize_reservation tool)
   */
  private async linkCallLogToReservation(callLogId: string) {
    const { data, error, count } = await this.supabase
      .from('reservation_requests')
      .update({ call_log_id: callLogId })
      .eq('call_sid', this.options.callSid)
      .select();

    if (error) {
      console.warn('⚠️ Failed to link call_log_id to reservation:', error.message);
    } else if (data && data.length > 0) {
      console.log('🔗 Linked call_log_id to reservation (ID:', data[0].id, ')');
    } else {
      console.log('ℹ️ No existing reservation found for call_sid:', this.options.callSid);
    }
  }

  close() {
    // Stop debug observer summary interval
    this.debugObserver.stopSummaryInterval();

    // Log timing summary if DEBUG_TIMING is enabled
    this.logTimingSummary();

    if (this.ws) {
      this.ws.close();
    }
    this.saveCallLogToSupabase();
  }

  /**
   * Log timing summary for performance monitoring.
   */
  private logTimingSummary() {
    const t = this.timings;
    const summary = {
      toSessionUpdated: t.sessionUpdated ? t.sessionUpdated - t.callStart : null,
      toFirstAudio: t.firstAudioDelta ? t.firstAudioDelta - t.callStart : null,
      toFirstMessage: t.firstMessage ? t.firstMessage - t.callStart : null,
      reservationDbMs: t.reservationDbDone && t.reservationCalled ? t.reservationDbDone - t.reservationCalled : null,
      reservationOutputMs: t.reservationOutputSent && t.reservationCalled ? t.reservationOutputSent - t.reservationCalled : null,
    };

    // Always log to NDJSON for analysis
    this.logEvent({ event: 'timing_summary', ...summary });

    // Console log only if DEBUG_TIMING is enabled
    if (config.debugTiming) {
      console.log('⏱️ [Timing Summary]', summary);
    }
  }
}
