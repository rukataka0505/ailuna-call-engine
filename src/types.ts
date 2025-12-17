export interface TwilioMediaMessage {
  event: 'start' | 'media' | 'stop';
  streamSid?: string;
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
}

export interface RealtimeLogEvent {
  timestamp: string;
  event: 'start' | 'user_utterance' | 'assistant_response' | 'tool_call' | 'realtime_error' | 'stop' | string;
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
}
