export interface TwilioMediaMessage {
  event: 'start' | 'media' | 'stop';
  streamSid?: string;
  start?: {
    streamSid: string;
    accountSid: string;
    callSid: string;
    tracks?: string[];
  };
  media?: {
    payload: string; // Base64-encoded mu-law audio at 8kHz mono
  };
}

export interface RealtimeLogEvent {
  timestamp: string;
  event: 'start' | 'user_utterance' | 'assistant_response' | 'stop' | string;
  role?: 'user' | 'assistant' | 'system';
  text?: string;
  streamSid?: string;
  callSid?: string;
  turn?: number;
  raw?: unknown;
}
