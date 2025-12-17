import express from 'express';
import http from 'http';
import WebSocket, { WebSocketServer } from 'ws';
import bodyParser from 'body-parser';
import { createClient } from '@supabase/supabase-js';
import { config } from './config';
import { createLogFilePath, writeLog } from './logging';
import { TwilioMediaMessage } from './types';

import { RealtimeSession } from './realtimeSession';

import { middleware as lineMiddleware } from '@line/bot-sdk';
import { handleLineWebhook } from './lineWebhook';

const app = express();

// LINE Webhook: Must be before global body parser to handle raw body signature validation
if (config.lineChannelAccessToken && config.lineChannelSecret) {
  app.post('/line/webhook', lineMiddleware({
    channelAccessToken: config.lineChannelAccessToken,
    channelSecret: config.lineChannelSecret,
  }), handleLineWebhook);
  console.log('✅ LINE Webhook registered');
} else {
  console.log('ℹ️ LINE Webhook skipped (Missing credentials)');
}

app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

const server = http.createServer(app);

/** 接続中の Media Stream コンテキスト */
interface CallContext {
  streamSid: string;
  logFile: string;
  realtime?: RealtimeSession;
  twilioSocket?: WebSocket;
}

const calls = new Map<string, CallContext>();

// Health check endpoint for Railway monitoring
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.post('/incoming-call-realtime', async (req, res) => {
  console.log('📞 incoming call');

  if (process.env.NODE_ENV === 'development') {
    console.log('---------- DEBUG START ----------');
    console.log('Request Body:', JSON.stringify(req.body, null, 2));
    console.log('To Parameter:', req.body.To || req.body.to);
    console.log('---------- DEBUG END   ----------');
  }

  const to = req.body.To;
  const from = req.body.From;

  // --- Phase 3: Subscription Check Start ---
  try {
    const supabase = createClient(config.supabaseUrl, config.supabaseServiceRoleKey);
    const { data: profile, error } = await supabase
      .from('profiles')
      .select('is_subscribed')
      .eq('phone_number', to)
      .single();

    if (error || !profile) {
      console.warn(`🚫 Rejection: No profile found for ${to}`);
      const rejectTwiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say language="ja-JP">この番号は利用できません。</Say>
  <Hangup/>
</Response>`;
      res.type('text/xml').send(rejectTwiml);
      return;
    }

    if (!profile.is_subscribed) {
      console.warn(`🚫 Rejection: User ${to} is not subscribed`);
      const rejectTwiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say language="ja-JP">契約が無効です。</Say>
  <Hangup/>
</Response>`;
      res.type('text/xml').send(rejectTwiml);
      return;
    }
    console.log(`✅ Subscription verified for ${to}`);
  } catch (err) {
    console.error('❌ Error checking subscription:', err);
    // On DB error, fail-closed (reject) for safety
    const errorTwiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say language="ja-JP">システムエラーが発生しました。</Say>
  <Hangup/>
</Response>`;
    res.type('text/xml').send(errorTwiml);
    return;
  }
  // --- Phase 3: Subscription Check End ---

  // URLパラメータへの付与を廃止 (Twilio <Parameter> タグを使用するため)
  const wsUrl = buildWsUrl('/twilio-media');
  console.log('Generated WS URL:', wsUrl);

  // <Parameter> タグで toPhoneNumber を渡す
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${wsUrl}">
      <Parameter name="toPhoneNumber" value="${to}" />
      <Parameter name="fromPhoneNumber" value="${from}" />
    </Stream>
  </Connect>
</Response>`;

  res.type('text/xml').send(twiml);
});

const wss = new WebSocketServer({ server, path: '/twilio-media' });

wss.on('connection', (socket, req) => {
  console.log('🔊 Twilio media WebSocket connected');
  console.log('Incoming WS Request URL:', req.url);

  socket.on('message', async (msg: WebSocket.RawData) => {
    try {
      const data = JSON.parse(msg.toString()) as TwilioMediaMessage;
      if (data.event === 'start' && data.start) {
        const { streamSid, callSid, customParameters } = data.start;
        // customParameters から toPhoneNumber, fromPhoneNumber を取得
        const toPhoneNumber = customParameters?.toPhoneNumber;
        const fromPhoneNumber = customParameters?.fromPhoneNumber;

        console.log('Start event received. Custom params:', customParameters);
        const logFile = createLogFilePath();
        const context: CallContext = {
          streamSid,
          logFile,
          twilioSocket: socket,
        };
        calls.set(streamSid, context);
        await writeLog(logFile, {
          timestamp: new Date().toISOString(),
          event: 'start',
          streamSid,
          callSid,
        });

        const realtime = new RealtimeSession({
          streamSid,
          callSid,
          logFile,
          toPhoneNumber,
          fromPhoneNumber,
          onAudioToTwilio: (base64Mulaw) => {
            if (socket.readyState === WebSocket.OPEN) {
              socket.send(
                JSON.stringify({
                  event: 'media',
                  streamSid,
                  media: { payload: base64Mulaw },
                }),
              );
            }
          },
          onClearTwilio: () => {
            if (socket.readyState === WebSocket.OPEN) {
              socket.send(
                JSON.stringify({
                  event: 'clear',
                  streamSid,
                }),
              );
            }
          },
        });
        context.realtime = realtime;
        await realtime.connect();
      }

      if (data.event === 'media' && data.media && data.streamSid) {
        const context = calls.get(data.streamSid);
        if (!context?.realtime) return;
        const mulawPayload = Buffer.from(data.media.payload, 'base64');
        context.realtime.sendAudio(mulawPayload);
      }

      if (data.event === 'stop' && data.streamSid) {
        const context = calls.get(data.streamSid);
        if (context) {
          await writeLog(context.logFile, {
            timestamp: new Date().toISOString(),
            event: 'stop',
            streamSid: context.streamSid,
          });
          context.realtime?.close();
          calls.delete(data.streamSid);
        }
      }
    } catch (err) {
      console.error('Failed to handle Twilio message', err);
      // エラー発生時は通話を確実に終了させる（無音放置を防ぐ）
      if (socket.readyState === WebSocket.OPEN) {
        socket.close();
        console.log('🔚 Socket closed due to error');
      }
    }
  });

  socket.on('close', () => {
    console.log('🔚 Twilio media WebSocket closed');
  });

  socket.on('error', (err) => {
    console.error('WebSocket error', err);
  });
});

const listener = server.listen(config.port, () => {
  console.log(`🚀 Server listening on port ${config.port}`);
});

const gracefulShutdown = () => {
  console.log('Received kill signal, shutting down gracefully');

  // Close WebSocket connections to ensure fast shutdown
  wss.clients.forEach((client) => {
    client.terminate();
  });

  listener.close(() => {
    console.log('Closed out remaining connections');
    process.exit(0);
  });

  // Force close if not closed within 10s
  setTimeout(() => {
    console.error('Could not close connections in time, forcefully shutting down');
    process.exit(1);
  }, 10000);
};

process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);

function buildWsUrl(pathname: string, params?: Record<string, string>): string {
  const url = new URL(config.publicUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = pathname;
  if (params) {
    Object.entries(params).forEach(([k, v]) => {
      if (v) url.searchParams.append(k, v);
    });
  }
  return url.toString();
}
