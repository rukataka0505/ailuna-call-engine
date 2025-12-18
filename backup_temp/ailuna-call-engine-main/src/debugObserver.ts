/**
 * Debug Observer Module for Twilio Media Streams and OpenAI Realtime events.
 * Provides observability logging for diagnosing "no response" issues.
 * 
 * Usage:
 * - Set DEBUG_REALTIME_EVENTS=1 to log OpenAI Realtime events
 * - Set DEBUG_TWILIO_MEDIA=1 to log Twilio media events
 */

import { config } from './config';

// Event types to skip logging (audio data - too verbose)
const SKIP_EVENT_TYPES = [
    'response.audio.delta',
    'response.output_audio.delta',
    'response.audio_transcript.delta',
];

// Event types to always log with full details
const DETAIL_EVENT_TYPES = [
    'input_audio_buffer.speech_started',
    'input_audio_buffer.speech_stopped',
    'input_audio_buffer.committed',
    'conversation.item.input_audio_transcription.completed',
    'response.done',
    'error',
    'session.updated',
];

export interface DebugStats {
    inboundAudioBytes: number;
    lastAudioAt: number | null;
    isUserSpeaking: boolean;
    appendCount: number;
    // Twilio-specific
    mediaCount: number;
    lastMediaAt: number | null;
    trackCounts: Record<string, number>;
}

export class DebugObserver {
    private stats: DebugStats = {
        inboundAudioBytes: 0,
        lastAudioAt: null,
        isUserSpeaking: false,
        appendCount: 0,
        mediaCount: 0,
        lastMediaAt: null,
        trackCounts: {},
    };

    private summaryInterval: ReturnType<typeof setInterval> | null = null;
    private mediaLogCount = 0;
    private readonly streamSid: string;
    private readonly sessionId: string;

    constructor(streamSid: string) {
        this.streamSid = streamSid;
        this.sessionId = streamSid.slice(-8); // Last 8 chars for brevity
    }

    /**
     * Start periodic summary logging
     */
    startSummaryInterval(): void {
        if (!config.debugRealtimeEvents && !config.debugTwilioMedia) return;

        this.summaryInterval = setInterval(() => {
            this.logSummary();
        }, config.debugRealtimeSummaryIntervalMs);
    }

    /**
     * Stop summary interval (call on session close)
     */
    stopSummaryInterval(): void {
        if (this.summaryInterval) {
            clearInterval(this.summaryInterval);
            this.summaryInterval = null;
        }
    }

    /**
     * Log OpenAI Realtime event (call at handleRealtimeEvent entry)
     */
    logRealtimeEvent(event: any): void {
        if (!config.debugRealtimeEvents) return;

        const eventType = event.type as string;
        if (!eventType) return;

        // Skip audio delta events
        if (SKIP_EVENT_TYPES.some(skip => eventType.includes(skip))) {
            return;
        }

        // Update speaking state
        if (eventType === 'input_audio_buffer.speech_started') {
            this.stats.isUserSpeaking = true;
        } else if (eventType === 'input_audio_buffer.speech_stopped') {
            this.stats.isUserSpeaking = false;
        }

        // Log detailed events
        if (DETAIL_EVENT_TYPES.includes(eventType)) {
            const details = this.extractEventDetails(event);
            console.log(`🔍 [RT:${this.sessionId}] ${eventType}`, details);
        } else {
            // Log other events with just the type (sampling: first 20 of each type)
            console.log(`🔍 [RT:${this.sessionId}] ${eventType}`);
        }
    }

    /**
     * Extract relevant details from specific event types
     */
    private extractEventDetails(event: any): Record<string, any> {
        const details: Record<string, any> = {};

        if (event.item_id) {
            details.item_id = event.item_id;
        }

        switch (event.type) {
            case 'conversation.item.input_audio_transcription.completed':
                details.transcript = event.transcript;
                break;

            case 'response.done':
                const output = event.response?.output || [];
                const functionCalls = output.filter((item: any) => item.type === 'function_call');
                if (functionCalls.length > 0) {
                    details.function_calls = functionCalls.map((fc: any) => ({
                        name: fc.name,
                        call_id: fc.call_id,
                        args_length: fc.arguments?.length || 0,
                    }));
                }
                break;

            case 'error':
                details.error_type = event.error?.type;
                details.error_message = event.error?.message;
                details.error_code = event.error?.code;
                break;

            case 'session.updated':
                if (event.session?.turn_detection) {
                    details.turn_detection = event.session.turn_detection;
                }
                break;
        }

        return details;
    }

    /**
     * Track audio sent to OpenAI (call in sendAudio)
     */
    trackAudioSent(payloadBytes: number): void {
        this.stats.inboundAudioBytes += payloadBytes;
        this.stats.lastAudioAt = Date.now();
        this.stats.appendCount++;
    }

    /**
     * Log Twilio media event (call in index.ts message handler)
     */
    logTwilioMedia(data: any): void {
        if (!config.debugTwilioMedia) return;

        const eventType = data.event as string;

        // Always log non-media events
        if (eventType !== 'media') {
            const maskedStreamSid = this.maskStreamSid(data.streamSid || data.start?.streamSid);
            console.log(`📞 [TW:${this.sessionId}] ${eventType}`, { streamSid: maskedStreamSid });
            return;
        }

        // Track media stats
        this.stats.mediaCount++;
        this.stats.lastMediaAt = Date.now();

        const track = data.media?.track || 'unknown';
        this.stats.trackCounts[track] = (this.stats.trackCounts[track] || 0) + 1;

        // Log first N media frames in detail
        if (this.mediaLogCount < config.debugMediaSamples) {
            this.mediaLogCount++;
            const payloadLength = data.media?.payload?.length || 0;
            console.log(`📞 [TW:${this.sessionId}] media #${this.mediaLogCount}`, {
                payloadLen: payloadLength,
                track,
            });
        }
    }

    /**
     * Log periodic summary
     */
    private logSummary(): void {
        const now = Date.now();
        const lastAudioAgo = this.stats.lastAudioAt
            ? `${Math.round((now - this.stats.lastAudioAt) / 1000)}s ago`
            : 'never';
        const lastMediaAgo = this.stats.lastMediaAt
            ? `${Math.round((now - this.stats.lastMediaAt) / 1000)}s ago`
            : 'never';

        console.log(
            `📊 [${this.sessionId}] Summary: ` +
            `inBytes=${this.stats.inboundAudioBytes} ` +
            `lastAudio=${lastAudioAgo} ` +
            `speaking=${this.stats.isUserSpeaking} ` +
            `appends=${this.stats.appendCount} ` +
            `media=${this.stats.mediaCount} ` +
            `lastMedia=${lastMediaAgo} ` +
            `tracks=${JSON.stringify(this.stats.trackCounts)}`
        );
    }

    /**
     * Mask streamSid for PII protection (show last 8 chars)
     */
    private maskStreamSid(sid?: string): string {
        if (!sid) return 'unknown';
        if (sid.length <= 8) return sid;
        return '...' + sid.slice(-8);
    }

    /**
     * Get current stats (for external access if needed)
     */
    getStats(): Readonly<DebugStats> {
        return { ...this.stats };
    }
}
