import WebSocket from 'ws';
import fs from 'fs/promises';
import path from 'path';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import OpenAI from 'openai';
import Stripe from 'stripe';
import { config } from './config';
import { writeLog, closeLogStream } from './logging';
import { RealtimeLogEvent, ReservationField } from './types';
import { SUMMARY_SYSTEM_PROMPT } from './prompts';
import { notificationService } from './notifications';
import { DebugObserver } from './debugObserver';

// Source constants for reservation_requests.source column
// Must match CHECK constraint: reservation_requests_source_check
const RESERVATION_SOURCE = {
  REALTIME_TOOL: 'phone_call_realtime_tool',
  REALTIME_FALLBACK: 'phone_call_realtime_fallback',
} as const;

/**
 * Default reservation fields used when no DB configuration is found.
 * Keys match the canonical columns in reservation_requests table.
 */
const DEFAULT_RESERVATION_FIELDS: ReservationField[] = [
  { field_key: 'customer_name', label: 'お名前', field_type: 'text', required: true, display_order: 1, enabled: true },
  { field_key: 'party_size', label: '人数', field_type: 'number', required: true, display_order: 2, enabled: true },
  { field_key: 'requested_date', label: '希望日', field_type: 'date', required: true, display_order: 3, enabled: true },
  { field_key: 'requested_time', label: '希望時間', field_type: 'time', required: true, display_order: 4, enabled: true },
];

export interface RealtimeSessionOptions {
  streamSid: string;
  callSid: string;
  logFile: string;
  toPhoneNumber?: string;
  fromPhoneNumber?: string;
  userId?: string;
  debugObserver: DebugObserver;
  onAudioToTwilio: (base64Mulaw: string) => void;
  onClearTwilio: () => void;
  onMarkToTwilio: (name: string) => void;
  /** Callback for transcript events (user/AI speech to text) */
  onTranscript?: (text: string, speaker: 'user' | 'ai', isFinal: boolean, turn: number) => void;
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
  private turnCount = 0;

  private currentSystemPrompt: string = 'あなたは電話応対AIエージェントです。丁寧で簡潔な応答を心がけてください。';
  private initialGreeting: string = 'お電話ありがとうございます。ご予約のお電話でしょうか？';
  private hasRequestedInitialResponse = false;
  private reservationFields: ReservationField[] = DEFAULT_RESERVATION_FIELDS;

  private reservationCreated = false; // Prevent duplicate reservations
  private audioDeltaCount = 0; // Counter for audio_delta sampling
  private mediaCount = 0; // Counter for twilio_media sampling
  private sessionUpdateTimeout?: ReturnType<typeof setTimeout>; // B対策: session.update ACK timeout

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

  // PlaybackTracker state for audio position tracking
  private currentAssistantItemId?: string;
  private sentMsTotal = 0;
  private playedMsTotal = 0;
  private markMap = new Map<string, { endMs: number }>();
  private markSeq = 0;
  private lastMarkSentMs = 0; // Track when last mark was sent
  private clearing = false; // Phase3: for truncate handling
  private bargeInDebounceTimer?: ReturnType<typeof setTimeout>;
  private isBargeInPending = false;  // Debounce pending flag
  private conversationPhase: 'greeting' | 'normal' = 'greeting';  // Greeting phase control
  private greetingAudioEndMs = 0;  // Track greeting audio length for playback-complete detection

  constructor(options: RealtimeSessionOptions) {
    this.startTime = Date.now();
    this.timings.callStart = this.startTime;
    this.options = options;
    this.callerNumber = options.fromPhoneNumber;
    this.userId = options.userId; // Pre-populated from subscription check
    this.supabase = createClient(config.supabaseUrl, config.supabaseServiceRoleKey);
    this.openai = new OpenAI({ apiKey: config.openAiApiKey });

    // Use shared debug observer from index.ts
    this.debugObserver = options.debugObserver;
    this.debugObserver.startSummaryInterval();

    if (config.stripeSecretKey) {
      this.stripe = new Stripe(config.stripeSecretKey, {
        apiVersion: '2025-02-24.acacia',
      });
    }
  }

  private async loadSystemPrompt(): Promise<void> {
    // Skip profile lookup if userId was already passed from subscription check
    if (this.userId) {
      console.log(`✅ Using pre-validated userId: ${this.userId}`);
      // userId がある場合は、直接 user_prompts を取得
      try {
        const { data: promptData, error: promptError } = await this.supabase
          .from('user_prompts')
          .select('system_prompt, config_metadata')
          .eq('user_id', this.userId)
          .single();

        if (promptError || !promptData) {
          console.warn('⚠️ User prompt settings not found:', promptError?.message);
        } else {
          await this.applyPromptSettings(promptData);
          return;
        }
      } catch (err) {
        console.error('❌ Failed to fetch user_prompts:', err);
      }
      // Fall through to file-based prompt if DB fetch fails
    } else if (this.options.toPhoneNumber) {
      // Fallback: Lookup profile by phone number (legacy path)
      try {
        console.log(`🔍 Looking up profile for phone number: ${this.options.toPhoneNumber}`);

        const { data: profile, error: profileError } = await this.supabase
          .from('profiles')
          .select('id, is_subscribed')
          .eq('phone_number', this.options.toPhoneNumber)

        if (profile && profile[0]) {
          console.log(`🔍 [Debug] Profile Found: ID=${profile[0].id}`);
        } else {
          console.log(`⚠️ [Debug] No profile found for phone number: ${this.options.toPhoneNumber}`);
        }

        if (profileError || !profile || profile.length === 0) {
          console.warn('⚠️ Profile not found or error:', profileError?.message);
        } else {
          this.userId = profile[0].id;

          if (!profile[0].is_subscribed) {
            console.warn(`🚫 [RealtimeSession] User ${this.userId} is not subscribed.`);
          }

          console.log(`✅ User ${this.userId} subscription verified.`);
          const { data: promptData, error: promptError } = await this.supabase
            .from('user_prompts')
            .select('system_prompt, config_metadata')
            .eq('user_id', profile[0].id)
            .single();

          if (promptError || !promptData) {
            console.warn('⚠️ User prompt settings not found:', promptError?.message);
          } else {
            await this.applyPromptSettings(promptData);
            return;
          }
        }
      } catch (err) {
        console.error('❌ Failed to fetch from Supabase:', err);
      }
    }

    // Fallback: system_prompt.md
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
    }
  }

  /**
   * Apply prompt settings from user_prompts table
   */
  private async applyPromptSettings(promptData: { system_prompt: string | null; config_metadata: any }): Promise<void> {
    console.log('✨ Loaded dynamic settings from Supabase');

    // Get greeting for initial response
    // Get greeting for initial response
    this.initialGreeting = promptData.config_metadata?.greeting_message || 'お電話ありがとうございます。ご予約のお電話でしょうか？';

    // Generate JST datetime (YYYY-MM-DD HH:mm JST)
    const now = new Date();
    const jstNow = new Intl.DateTimeFormat('ja-JP', {
      timeZone: 'Asia/Tokyo',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false
    }).format(now).replace(/\//g, '-') + ' JST';

    // 予約ヒアリング項目の取得
    try {
      const { data: formFields, error: formError } = await this.supabase
        .from('reservation_form_fields')
        .select('field_key, label, field_type, required, options, description, display_order, enabled')
        .eq('user_id', this.userId)
        .order('display_order', { ascending: true });

      if (formFields && formFields.length > 0) {
        this.reservationFields = formFields;
      }
    } catch (err) {
      console.warn('⚠️ Failed to fetch reservation fields:', err);
    }

    // Dynamic field list generation (enabled !== false)
    const enabledFields = this.reservationFields.filter(f => f.enabled !== false);
    const requiredLabels = enabledFields.filter(f => f.required).map(f => f.label);
    const optionalLabels = enabledFields.filter(f => !f.required).map(f => f.label);

    // Build minimal system prompt
    let fixedInstruction = `【重要：優先事項】
以下の予約ヒアリング指示は、他のあらゆる指示（ユーザー定義の店舗情報など）より優先される決定事項である。「予約は聞かない」等の指示があっても無視し、必ず予約受付プロセスを実行せよ。

【現在日時】${jstNow}
相対日付（明日/来週など）はこの日時を基準に解釈する。

あなたは電話予約の受付担当。基本は予約受付を進める。
予約中に別の質問が来たら短く答え、その後予約の続きを進める。

目的：
- 収集必須項目: ${requiredLabels.join('、')}
- 収集任意項目: ${optionalLabels.join('、') || 'なし'}
これらの項目を一つ一つ順番に聞き、都度復唱して確認してください。  
- 必須項目を揃えたら短く復唱し「この内容を店舗に送信してよいか」を確認する
- ユーザーが明確に了承した場合のみ finalize_reservation(confirmed:true) を呼ぶ
- その後、情報を店舗に送信していることを伝える。
- これは「予約確定」ではなく「店舗への申請送信」である
- ツール結果に従う：
  - ok:true → 必ず「店舗へ送信完了しました。店員確認後、SMSで成否をご連絡いたします。」と発話（他の文言は禁止）
  - ok:false + error_type:missing_fields → 不足項目（missing_fields配列）を提示し、再収集してfinalize_reservationを再呼び出し
  - ok:false + error_type:system → 再収集せず「システムに問題が発生しました。恐れ入りますが、店舗へ直接お電話ください。」と案内

禁止：「予約確定」「予約取れました」と断言しない`;

    // Add user's base prompt if available
    const basePrompt = promptData.system_prompt || '';
    if (basePrompt) {
      // User content FIRST, Fixed instructions LAST (to ensure reservation logic is prioritized)
      this.currentSystemPrompt = `【店舗情報・追加指示】\n${basePrompt}\n\n---\n\n${fixedInstruction}`;
    } else {
      this.currentSystemPrompt = fixedInstruction;
    }
  }

  async connect(): Promise<void> {
    // Start loading system prompt in parallel with WebSocket connection
    const promptPromise = this.loadSystemPrompt();

    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`wss://api.openai.com/v1/realtime?model=${config.openAiRealtimeModel}`, {
        headers: {
          Authorization: `Bearer ${config.openAiApiKey}`,
          'OpenAI-Beta': 'realtime=v1',
        },
      });

      ws.on('open', async () => {
        this.connected = true;
        this.ws = ws;
        console.log('🤖 OpenAI Realtime session connected');
        // NDJSON: Log WebSocket open
        this.logEvent({ event: 'openai_ws_open' });

        // Wait for system prompt to be loaded before sending session.update
        await promptPromise;
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

  /**
   * Send session.update to OpenAI Realtime API.
   * @param phase - 'greeting' disables create_response/interrupt_response to prevent AI-to-AI loops
   */
  private sendSessionUpdate(phase: 'greeting' | 'normal' = 'greeting') {
    const isGreeting = phase === 'greeting';
    this.conversationPhase = phase;
    console.log(`🔄 [Session] Sending session.update (phase: ${phase}, create_response: ${!isGreeting}, interrupt_response: ${!isGreeting})`);

    // Build dynamic schema from reservation_form_fields
    const answersProperties: Record<string, any> = {};
    const requiredKeys: string[] = [];
    const enabledFields = this.reservationFields.filter(f => f.enabled !== false);

    for (const f of enabledFields) {
      // Map field_type to JSON Schema type
      let schemaType: any = { type: 'string', description: f.label };
      if (f.field_type === 'number') {
        schemaType = { type: 'integer', description: f.label };
      } else if (f.field_type === 'date') {
        schemaType = { type: 'string', description: `${f.label} (YYYY-MM-DD)` };
      } else if (f.field_type === 'time') {
        schemaType = { type: 'string', description: `${f.label} (HH:mm)` };
      } else if (f.field_type === 'select' && f.options) {
        schemaType = { type: 'string', enum: f.options, description: f.label };
      }
      answersProperties[f.field_key] = schemaType;
      if (f.required) {
        requiredKeys.push(f.field_key);
      }
    }

    const toolsConfig = {
      tools: [{
        type: 'function',
        name: 'finalize_reservation',
        description: 'ユーザーが必須項目を全て伝え、送信の意思を示した場合に呼び出す。',
        parameters: {
          type: 'object',
          properties: {
            answers: {
              type: 'object',
              description: '収集した予約情報',
              properties: answersProperties,
              required: requiredKeys
            },
            confirmed: {
              type: 'boolean',
              description: 'ユーザーが口頭で「はい」と明確に了承した場合のみ true'
            }
          },
          required: ['answers', 'confirmed']
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
          silence_duration_ms: config.vadSilenceDurationMs,
          create_response: !isGreeting,     // Disable during greeting to prevent AI-to-AI loops
          interrupt_response: !isGreeting,  // Disable during greeting to ensure full playback
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
    this.logEvent({ event: 'session_update_sent', phase });
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
        } else if (errorCode === 'insufficient_quota' || errorCode === 'billing_hard_limit_reached') {
          // Critical: API credits exhausted
          console.error('🚨💳 [OpenAI API] クレジット切れです！APIの支払い状況を確認してください。');
          console.error('🚨💳 [OpenAI API] Billing URL: https://platform.openai.com/account/billing');
          console.error('❌ [OpenAI Realtime Error]', errorDetails);
        } else if (errorCode === 'rate_limit_exceeded') {
          // Rate limit hit
          console.error('⚠️🔄 [OpenAI API] レート制限に達しました。しばらく待ってから再試行してください。');
          console.error('❌ [OpenAI Realtime Error]', errorDetails);
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
          console.log('✨ Session updated, requesting initial response with greeting');
          this.sendJson({
            type: 'response.create',
            response: {
              modalities: ['text', 'audio'],
              instructions: `次の挨拶を行ってください：${this.initialGreeting}`
            },
          });
          // NDJSON: Log response.create sent (initial greeting)
          this.logEvent({ event: 'response_create_sent', trigger: 'initial' });
          this.hasRequestedInitialResponse = true;
        }
      }

      // response.created is tracked for logging purposes only (smart cancel removed)

      // Capture assistant item_id for playback tracking (truncate preparation)
      if (event.type === 'response.output_item.added') {
        const item = event.item;
        if (item?.type === 'message' && item?.role === 'assistant') {
          this.currentAssistantItemId = item.id;
          // Reset playback tracker for new assistant message
          this.sentMsTotal = 0;
          this.playedMsTotal = 0;
          this.lastMarkSentMs = 0;
          this.markSeq = 0;
          this.markMap.clear();
          // Clear the clearing state when new assistant response starts
          this.clearing = false;
          console.log(`🎯 [PlaybackTracker] New assistant item: ${item.id}`);
        }
      }

      if (event.type?.startsWith?.('response.audio.delta') || event.type === 'response.output_audio.delta') {
        // Note: Audio is always forwarded to Twilio. Barge-in is handled via clear + truncate.

        const base64Mulaw = event.delta ?? event.audio?.data;
        if (base64Mulaw) {
          // Timing: Record first audio delta
          if (!this.timings.firstAudioDelta) {
            this.timings.firstAudioDelta = Date.now();
          }
          this.forwardAudioToTwilioFromBase64(base64Mulaw);

          // PlaybackTracker: Calculate deltaMs from audio bytes (mulaw 8kHz = 8 bytes/ms)
          const bytes = Buffer.from(base64Mulaw, 'base64').length;
          const deltaMs = Math.round((bytes * 1000) / 8000);
          this.sentMsTotal += deltaMs;

          // Send mark every 300ms for playback position tracking
          if (this.currentAssistantItemId && (this.sentMsTotal - this.lastMarkSentMs) >= 300) {
            this.markSeq++;
            const markName = `a:${this.currentAssistantItemId}:ms:${this.sentMsTotal}:seq:${this.markSeq}`;
            this.markMap.set(markName, { endMs: this.sentMsTotal });
            this.options.onMarkToTwilio(markName);
            this.lastMarkSentMs = this.sentMsTotal;
          }

          // NDJSON: Log audio_delta (sampled every 100 frames)
          this.audioDeltaCount++;
          if (this.audioDeltaCount === 1 || this.audioDeltaCount % 100 === 0) {
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
        // Extract text from assistant messages only (skip function_call items)
        const textParts = output
          .filter((item: any) => item.type === 'message' && item.role === 'assistant')
          .flatMap((item: any) => item.content || [])
          .map((c: any) => c.text || c.transcript || '')
          .filter((t: string) => t.trim());
        const text = textParts.join(' ');

        // Only process if we have actual assistant text (not tool-only responses)
        if (text.trim()) {
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

          // Emit transcript to WebSocket client (max 2000 chars)
          this.options.onTranscript?.(text.slice(0, 2000), 'ai', true, this.turnCount);

          // Greeting phase: defer mode switch until playback completes
          if (this.conversationPhase === 'greeting') {
            // Record greeting audio length for playback-complete detection
            this.greetingAudioEndMs = this.sentMsTotal;
            console.log(`🎯 Greeting response.done received, waiting for playback (sentMsTotal: ${this.sentMsTotal}ms)`);
            // Mode switch will happen in onTwilioMark when playedMsTotal catches up
          }
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

        // Response lifecycle logging (smart cancel removed)
      }

      if (event.type === 'input_audio_buffer.speech_started') {
        console.log('🎙️ ユーザー発話開始 (Barge-in検出)');
        // NDJSON: Log VAD speech started
        this.logEvent({ event: 'vad_event', action: 'start' });

        // Skip barge-in entirely during greeting phase to prevent self-pickup
        if (this.conversationPhase === 'greeting') {
          console.log('⏸️ Barge-in skipped: still in greeting phase');
          this.logEvent({ event: 'barge_in_ignored', reason: 'greeting_phase' });
          return;
        }

        // Check if AI is still actively speaking (has remaining audio to play)
        const remainingMs = this.sentMsTotal - this.playedMsTotal;
        if (remainingMs < config.bargeInMinRemainMs) {
          console.log(`⏸️ Barge-in ignored: audio almost finished (${remainingMs}ms remaining < ${config.bargeInMinRemainMs}ms threshold)`);
          this.logEvent({ event: 'barge_in_ignored', reason: 'audio_almost_finished', remaining_ms: remainingMs });
          return;
        }

        // Start debounce timer - don't immediately truncate
        // Cancel any existing timer first
        if (this.bargeInDebounceTimer) {
          clearTimeout(this.bargeInDebounceTimer);
        }
        this.isBargeInPending = true;
        console.log(`⏳ Barge-in debounce started (${config.bargeInDebounceMs}ms)`);

        this.bargeInDebounceTimer = setTimeout(() => {
          if (this.isBargeInPending) {
            console.log('✅ Barge-in confirmed after debounce');
            this.logEvent({ event: 'barge_in_confirmed' });
            this.confirmBargeIn();
          }
          this.isBargeInPending = false;
        }, config.bargeInDebounceMs);
      }

      if (event.type === 'input_audio_buffer.speech_stopped') {
        // NDJSON: Log VAD speech stopped
        this.logEvent({ event: 'vad_event', action: 'stop' });

        // Cancel barge-in debounce timer if speech stopped before debounce completed (noise)
        if (this.isBargeInPending && this.bargeInDebounceTimer) {
          clearTimeout(this.bargeInDebounceTimer);
          this.bargeInDebounceTimer = undefined;
          this.isBargeInPending = false;
          console.log('🔇 Barge-in cancelled: speech stopped before debounce (likely noise)');
          this.logEvent({ event: 'barge_in_cancelled', reason: 'speech_stopped_before_debounce' });
        }
      }

      if (event.type === 'conversation.item.input_audio_transcription.completed') {
        const text = event.transcript;
        // Skip empty transcripts to avoid UI empty lines
        if (!text?.trim()) return;

        this.turnCount++;
        this.logEvent({
          event: 'user_utterance',
          role: 'user',
          text,
          turn: this.turnCount
        });
        this.transcript.push({ role: 'user', text, timestamp: new Date().toISOString() });
        console.log(`🗣️ ユーザー発話 #${this.turnCount}: ${text}`);

        // Emit transcript to WebSocket client (max 2000 chars)
        this.options.onTranscript?.(text.slice(0, 2000), 'user', true, this.turnCount);
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

    let result: {
      ok: boolean;
      reservation_id?: string;
      deduped?: boolean;
      error_type?: string;
      error_code?: string;
      missing_fields?: string[];
    };

    // Parse args with error handling
    let args: any;
    try {
      args = JSON.parse(argsJson);
    } catch (parseErr) {
      console.error('❌ Failed to parse finalize_reservation args:', parseErr);
      const errorResult = { ok: false, error_type: 'system', error_code: 'PARSE_ERROR' };
      this.sendJson({
        type: 'conversation.item.create',
        item: { type: 'function_call_output', call_id: callId, output: JSON.stringify(errorResult) }
      });
      this.sendJson({ type: 'response.create', response: { modalities: ['text', 'audio'] } });
      return;
    }

    // 0. Filter enabled fields only (Handle undefined as enabled)
    const enabledFields = this.reservationFields.filter(f => f.enabled !== false);
    const requiredFields = enabledFields.filter(f => f.required);

    // Server Guard: Reject if no required fields are configured
    if (requiredFields.length === 0) {
      console.error('🚨 [Alert] No required fields configured - rejecting finalize_reservation');
      this.logEvent({ event: 'config_error', reason: 'no_required_fields' });
      result = { ok: false, error_type: 'system', error_code: 'NO_REQUIRED_FIELDS' };
      this.sendJson({
        type: 'conversation.item.create',
        item: { type: 'function_call_output', call_id: callId, output: JSON.stringify(result) }
      });
      this.sendJson({ type: 'response.create', response: { modalities: ['text', 'audio'] } });
      return;
    }

    // 1. Check answers type STRICTLY (Wait for valid object)
    const rawAnswers = args.answers;
    if (!rawAnswers || typeof rawAnswers !== 'object' || Array.isArray(rawAnswers)) {
      console.log('❌ Validation failed: answers is not an object');
      result = { ok: false, error_type: 'system', error_code: 'INVALID_ANSWERS_FORMAT' };
      this.sendJson({
        type: 'conversation.item.create',
        item: { type: 'function_call_output', call_id: callId, output: JSON.stringify(result) }
      });
      this.sendJson({ type: 'response.create', response: { modalities: ['text', 'audio'] } });
      return;
    }

    // 2. Check confirmed flag STRICTLY
    if (args.confirmed !== true) {
      console.log('❌ Rejected: confirmed is not true');
      result = {
        ok: false,
        error_type: 'not_confirmed'
      };
      // function_call_output + response.create で会話を継続
      this.sendJson({
        type: 'conversation.item.create',
        item: { type: 'function_call_output', call_id: callId, output: JSON.stringify(result) }
      });
      this.sendJson({ type: 'response.create', response: { modalities: ['text', 'audio'] } });
      return;
    }

    try {
      // 3. Coercion & Validation
      const missingFields: string[] = [];
      const cleanAnswers: Record<string, any> = {};

      for (const f of enabledFields) {
        let val = rawAnswers[f.field_key];

        // Coercion (Best Effort)
        if (f.field_type === 'number') {
          // "5" -> 5, "大人3名" -> 3 (simple parse)
          const num = parseInt(String(val).replace(/[^\d]/g, ''), 10);
          if (!isNaN(num)) val = num;
        }

        // Store cleaned value
        if (val !== undefined && val !== null && String(val).trim() !== '') {
          cleanAnswers[f.field_key] = val;
        }

        // Validation (Required check)
        if (f.required) {
          const isEmpty = val === undefined || val === null || String(val).trim() === '';
          if (isEmpty) {
            missingFields.push(f.label);
            continue; // Skip type check if empty
          }
        }

        // Validation (Type check) - only if value exists
        if (val !== undefined && val !== null && String(val).trim() !== '') {
          if (f.field_type === 'number' && typeof val !== 'number') {
            missingFields.push(`${f.label} (数値形式)`);
          } else if (f.field_type === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(String(val))) {
            missingFields.push(`${f.label} (YYYY-MM-DD形式)`);
          } else if (f.field_type === 'time' && !/^\d{2}:\d{2}$/.test(String(val))) {
            missingFields.push(`${f.label} (HH:mm形式)`);
          }
        }
      }

      if (missingFields.length > 0) {
        console.log('❌ Validation failed, missing fields:', missingFields);
        result = {
          ok: false,
          missing_fields: missingFields,
          error_type: 'missing_fields'
        };
      } else {
        // 4. DB Insert (with clean answers)
        // Pass a merged object to insertReservation (keep args for fallback, but prefer answers)
        const insertResult = await this.insertReservationFromTool({ ...args, answers: cleanAnswers });
        // Timing: Record DB done
        this.timings.reservationDbDone = Date.now();
        result = insertResult;

        if (result.ok) {
          // Success: reservation_id and deduped are set by insertReservationFromTool
        }
      }
    } catch (err) {
      console.error('❌ finalize_reservation error:', err);
      result = { ok: false, error_type: 'system', error_code: 'INTERNAL_ERROR' };
    }

    // Log tool call for debugging and audit
    this.logEvent({
      event: 'tool_call',
      tool: 'finalize_reservation',
      call_id: callId,
      args: argsJson,
      result: JSON.stringify(result)
    });

    // 5. Send function_call_output back to the model
    this.sendJson({
      type: 'conversation.item.create',
      item: {
        type: 'function_call_output',
        call_id: callId,
        output: JSON.stringify(result)
      }
    });

    // Trigger the model to generate next response based on tool result
    this.sendJson({
      type: 'response.create',
      response: { modalities: ['text', 'audio'] }
    });

    console.log('📤 function_call_output sent, response.create triggered');
  }

  /**
   * Insert reservation into DB from tool call.
   * Uses call_sid as unique key with conflict handling.
   */
  private async insertReservationFromTool(args: any): Promise<{
    ok: boolean;
    reservation_id?: string;
    deduped?: boolean;
    error_type?: string;
    error_code?: string;
  }> {
    if (!this.userId) {
      return { ok: false, error_type: 'system', error_code: 'USER_NOT_IDENTIFIED' };
    }

    const callSid = this.options.callSid;

    // Build answers object (field_key -> value for DB, label -> value for notifications)
    // Note: args.answers is already 'cleanAnswers' if coming from handleFinalizeReservation
    const answers = args.answers || {};
    const dbAnswers: Record<string, any> = {};
    const notificationAnswers: Record<string, any> = {};

    // Helper to get value from clean answers or top-level args (fallback)
    const getValue = (key: string) => answers[key] || args[key] || null;

    // Use reservationFields to map keys and labels
    for (const f of this.reservationFields) {
      // Prioritize answers object, fallback to top-level for unknown fields
      const val = answers[f.field_key] || args[f.field_key] || '';
      if (val !== '') {
        dbAnswers[f.field_key] = val;
        notificationAnswers[f.label] = val;
      }
    }

    // Canonical columns derived from dynamic fields (or direct args)
    const customerName = getValue('customer_name') || 'Unknown';
    // party_size may be number or string, DB expects integer (or NULL). 
    // It should be coerced already by handleFinalizeReservation if it was in fields.
    const partySize = getValue('party_size');
    const requestedDate = getValue('requested_date');
    const requestedTime = getValue('requested_time');

    // Insert directly - rely on unique constraint (23505) for duplicate detection
    try {
      const { data: newRes, error: insertErr } = await this.supabase
        .from('reservation_requests')
        .insert({
          user_id: this.userId,
          call_sid: callSid,
          customer_phone: this.callerNumber || 'Unknown',
          customer_name: customerName,
          requested_date: requestedDate, // Can be NULL
          requested_time: requestedTime, // Can be NULL
          party_size: partySize,         // Can be NULL
          status: 'pending',
          answers: dbAnswers,            // Store full structure
          source: RESERVATION_SOURCE.REALTIME_TOOL
        })
        .select('id')
        .single();

      if (insertErr) {
        if (insertErr.code === '23505') {
          // Unique constraint violation - already exists (race condition)
          console.log('⚠️ Race condition detected, reservation already exists');
          return { ok: true, deduped: true };
        }
        throw insertErr;
      }

      console.log('✅ Reservation created via tool:', newRes.id);
      this.reservationCreated = true;

      // Send notification asynchronously (don't block tool output)
      console.log('📨 Notification queued');
      void notificationService.notifyReservation({
        user_id: this.userId,
        customer_name: args.customer_name || 'Unknown',
        customer_phone: this.callerNumber || 'Unknown',
        party_size: args.party_size,
        requested_date: args.requested_date,
        requested_time: args.requested_time,
        requested_datetime_text: `${args.requested_date} ${args.requested_time}`,
        answers: notificationAnswers
      })
        .then(() => console.log('✅ Notification sent'))
        .catch((err) => console.error('❌ Notification failed', err));

      return { ok: true, reservation_id: newRes.id, deduped: false };
    } catch (dbErr: any) {
      console.error('❌ DB error in insertReservationFromTool:', {
        code: dbErr?.code,
        message: dbErr?.message,
        details: dbErr?.details,
        hint: dbErr?.hint,
        source: RESERVATION_SOURCE.REALTIME_TOOL,
      });
      // Don't ask user to retry - DB errors won't be fixed by retry
      return { ok: false, error_type: 'system', error_code: 'DB_INSERT_FAILED' };
    }
  }

  // =========================================================================

  /**
   * Execute actual barge-in after debounce delay has passed.
   * Sets clearing state, clears Twilio buffer, and truncates OpenAI response.
   */
  private confirmBargeIn(): void {
    // Set clearing state BEFORE sending clear to Twilio
    // This prevents mark events during clearing from updating playedMsTotal
    this.clearing = true;

    // Clear Twilio's audio buffer immediately
    this.options.onClearTwilio();

    // Send truncate to OpenAI if we have an active assistant response
    if (this.currentAssistantItemId) {
      const endMs = this.playedMsTotal;
      console.log(`✂️ [Truncate] item_id: ${this.currentAssistantItemId}, audio_end_ms: ${endMs}`);
      this.sendJson({
        type: 'conversation.item.truncate',
        item_id: this.currentAssistantItemId,
        content_index: 0,
        audio_end_ms: endMs
      });
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

        // Reservation already saved via finalize_reservation tool
        // Just link the call_log_id to the existing reservation (if any)
        await this.linkCallLogToReservation(callLog.id);

        // Fallback removed - just log warning if no reservation was created
        if (!this.reservationCreated) {
          console.warn('⚠️ [Alert] Call ended without reservation being created via tool');
          this.logEvent({
            event: 'reservation_not_created',
            transcript_length: this.transcript.length
          });
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

  /**
   * Handle incoming mark event from Twilio.
   * This is called when Twilio acknowledges a mark we sent.
   * Updates playedMsTotal to track actual playback position.
   */
  onTwilioMark(name?: string): void {
    if (!name) {
      if (config.debugMarkEvents) {
        console.log('ℹ️ [Mark] Received undefined mark name, ignoring');
      }
      return;
    }

    const markInfo = this.markMap.get(name);
    if (markInfo) {
      // Only update playedMsTotal if not in clearing state (Phase3: truncate handling)
      if (!this.clearing) {
        this.playedMsTotal = Math.max(this.playedMsTotal, markInfo.endMs);
        if (config.debugMarkEvents) {
          console.log(`🏷️ [Mark] Acknowledged: ${name}, playedMsTotal: ${this.playedMsTotal}ms`);
        }

        // Check if greeting playback is complete - switch to normal mode
        if (this.conversationPhase === 'greeting' && this.greetingAudioEndMs > 0) {
          // Allow some margin (90% played) to account for mark timing variations
          if (this.playedMsTotal >= this.greetingAudioEndMs * 0.9) {
            console.log(`✨ Greeting playback completed (${this.playedMsTotal}ms / ${this.greetingAudioEndMs}ms), switching to normal mode`);
            this.sendSessionUpdate('normal');
            this.greetingAudioEndMs = 0;  // Reset to avoid re-triggering
          }
        }
      } else {
        if (config.debugMarkEvents) {
          console.log(`🏷️ [Mark] Ignored during clearing: ${name}`);
        }
      }
      // Clean up processed mark
      this.markMap.delete(name);
    } else {
      if (config.debugMarkEvents) {
        console.log(`⚠️ [Mark] Unknown mark received: ${name}`);
      }
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

    // Close the log file WriteStream
    closeLogStream(this.options.logFile);
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
