export interface TwilioMediaMessage {
  event: 'connected' | 'start' | 'media' | 'mark' | 'stop';
  streamSid?: string;
  sequenceNumber?: string;
  start?: {
    streamSid: string;
    accountSid: string;
    callSid: string;
    tracks?: string[];
    customParameters?: {
      toPhoneNumber?: string;
      fromPhoneNumber?: string;
      [key: string]: string | undefined;
    };
  };
  media?: {
    payload: string; // Base64-encoded mu-law audio at 8kHz mono
  };
  mark?: {
    name: string;
  };
}

export interface RealtimeLogEvent {
  timestamp: string;
  event:
  // Existing events
  | 'start' | 'user_utterance' | 'assistant_response' | 'tool_call' | 'realtime_error' | 'stop'
  // Realtime connection lifecycle events
  | 'openai_ws_open' | 'openai_ws_close' | 'openai_ws_error'
  | 'session_update_sent' | 'session_updated_received' | 'response_create_sent'
  // Diagnostic events
  | 'twilio_media' | 'vad_event' | 'audio_delta'
  // Safeguard events
  | 'session_update_timeout' | 'speaking_failsafe'
  | string;
  role?: 'user' | 'assistant' | 'system';
  text?: string;
  streamSid?: string;
  callSid?: string;
  turn?: number;
  raw?: unknown;
  // Tool call logging fields
  tool?: string;
  call_id?: string;
  args?: string;
  result?: string;
  // Error event fields
  error_code?: string;
  error_message?: string;
  // Diagnostic event fields
  payload_bytes?: number;
  media_count?: number;
  delta_count?: number;
  bytes_sent?: number;
  close_code?: number;
  close_reason?: string;
  action?: 'start' | 'stop';  // For vad_event
  trigger?: 'initial' | 'tool' | 'other';  // For response_create_sent
  transcript_length?: number;  // For reservation_not_created alert
}
