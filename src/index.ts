import express from 'express';
import http from 'http';
import WebSocket, { WebSocketServer } from 'ws';
import bodyParser from 'body-parser';
import { config } from './config';
import { createLogFilePath, writeLog } from './logging';
import { TwilioMediaMessage } from './types';

import { RealtimeSession } from './realtimeSession';

const app = express();
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
app.post('/incoming-call-realtime', async (req, res) => {
  console.log('📞 incoming call');

  console.log('---------- DEBUG START ----------');
  console.log('Request Body:', JSON.stringify(req.body, null, 2));
  console.log('To Parameter:', req.body.To || req.body.to);
  console.log('---------- DEBUG END   ----------');

  const to = req.body.To;
  const wsUrl = buildWsUrl('/twilio-media', { to });
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${wsUrl}" />
  </Connect>
</Response>`;

  res.type('text/xml').send(twiml);
});

const wss = new WebSocketServer({ server, path: '/twilio-media' });

wss.on('connection', (socket, req) => {
  console.log('🔊 Twilio media WebSocket connected');

  // クエリパラメータから to (着信番号) を取得
  const url = new URL(req.url || '', `http://${req.headers.host}`);
  const toPhoneNumber = url.searchParams.get('to') || undefined;

  socket.on('message', async (msg: WebSocket.RawData) => {
    try {
      const data = JSON.parse(msg.toString()) as TwilioMediaMessage;
      if (data.event === 'start' && data.start) {
        const { streamSid, callSid } = data.start;
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
    }
  });

  socket.on('close', () => {
    console.log('🔚 Twilio media WebSocket closed');
  });

  socket.on('error', (err) => {
    console.error('WebSocket error', err);
  });
});

server.listen(config.port, () => {
  console.log(`🚀 Server listening on port ${config.port}`);
});

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
