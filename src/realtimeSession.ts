import WebSocket from 'ws';
import fs from 'fs/promises';
import path from 'path';
import { config } from './config';
import { writeLog } from './logging';
import { RealtimeLogEvent } from './types';

export interface RealtimeSessionOptions {
  streamSid: string;
  callSid: string;
  logFile: string;
  onAudioToTwilio: (base64Mulaw: string) => void;
  onClearTwilio: () => void;
}

/**
 * OpenAI Realtime API との WebSocket セッションを管理するクラス。
 * Twilio Media Streams から受け取った音声を OpenAI に送り、逆方向の音声 delta を Twilio へ返す。
 */
export class RealtimeSession {
  private ws?: WebSocket;

  private readonly options: RealtimeSessionOptions;

  private connected = false;
  private isUserSpeaking = false;
  private turnCount = 0;
  private currentSystemPrompt: string = config.openAiRealtimeSystemPrompt;
  private isInitialGreetingSent = false;

  constructor(options: RealtimeSessionOptions) {
    this.options = options;
  }

  private async loadSystemPrompt(): Promise<string> {
    const mdPath = path.join(process.cwd(), 'system_prompt.md');
    try {
      const content = await fs.readFile(mdPath, 'utf-8');
      if (content) {
        console.log('📄 Loaded system prompt from system_prompt.md');
        return content;
      }
    } catch (error) {
      console.warn('⚠️ Failed to load system_prompt.md, falling back to env var');
    }
    return config.openAiRealtimeSystemPrompt;
  }

  async connect(): Promise<void> {
    this.currentSystemPrompt = await this.loadSystemPrompt();
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
        input_audio_format: 'pcm16',
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
    const itemPayload = {
      type: 'conversation.item.create',
      item: {
        type: 'message',
        role: 'system',
        content: [{ type: 'input_text', text: 'ユーザーが電話に出ました。設定されたキャラクターになりきって、最初の挨拶を行ってください。' }]
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

  sendAudio(pcm16_16k: Buffer) {
    if (!this.connected || !this.ws) return;
    const payload = {
      type: 'input_audio_buffer.append',
      audio: pcm16_16k.toString('base64'),
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
          console.log(`🤖 AI応答 #${this.turnCount}: ${text}`);
        }
      }

      if (event.type === 'input_audio_buffer.speech_started') {
        this.isUserSpeaking = true;
        this.options.onClearTwilio();
        this.logEvent({ event: 'user_utterance', text: '[speech detected]' });
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

  close() {
    if (this.ws) {
      this.ws.close();
    }
  }
}
