import WebSocket from 'ws';
import fs from 'fs/promises';
import path from 'path';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import OpenAI from 'openai';
import Stripe from 'stripe';
import { config } from './config';
import { writeLog } from './logging';
import { RealtimeLogEvent } from './types';
import { SUMMARY_SYSTEM_PROMPT } from './prompts';

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
  private stripe: Stripe;

  private readonly options: RealtimeSessionOptions;

  private connected = false;
  private isUserSpeaking = false;
  private turnCount = 0;
  private currentSystemPrompt: string = 'あなたは電話応対AIエージェントです。丁寧で簡潔な応答を心がけてください。';
  private hasRequestedInitialResponse = false;

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
    this.stripe = new Stripe(config.stripeSecretKey, {
      apiVersion: '2025-02-24.acacia',
    });
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
            console.warn(`🚫 User ${this.userId} is not subscribed. Rejecting call.`);
            throw new Error('User subscription is not active. Call rejected.');
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

            // config_metadata から greeting_message を取得（デフォルト値あり）
            const greeting = promptData.config_metadata?.greeting_message || 'お電話ありがとうございます。';

            // 固定の挨拶指示ブロックを作成
            const fixedInstruction = `
【重要：第一声の指定】
通話が開始された際、AIの「最初の発話」は必ず以下の文言を一言一句変えずに読み上げてください。
挨拶文：${greeting}

【厳守事項】
- 挨拶文の直後に「ご用件はいかがでしょうか」「どうされましたか」などの問いかけを**絶対に**付け足さないでください。
- 挨拶文のみを発話し、一度ターンを終了して、相手（ユーザー）の発言を待ってください。
`;

            // 既存のプロンプトと結合
            if (promptData.system_prompt) {
              this.currentSystemPrompt = `${fixedInstruction}\n\n${promptData.system_prompt}`;
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
          threshold: 0.6,
          prefix_padding_ms: 300,
          silence_duration_ms: 800,
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
    try {
      if (this.transcript.length > 0) {
        console.log(`🤖 Generating call summary... (Model: ${config.openAiSummaryModel})`);
        const formattedTranscript = this.formatTranscriptForSummary();

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

        // Report usage to Stripe for billing
        await this.reportUsageToStripe(this.userId, durationSeconds);
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
