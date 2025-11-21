import fs from 'fs';
import path from 'path';
import { config } from './config';
import { RealtimeLogEvent } from './types';

/**
 * NDJSON の 1 行を書き出すユーティリティ。
 * 通話ごとに作成したファイルに逐次 append する。
 */
export const writeLog = async (filePath: string, event: RealtimeLogEvent): Promise<void> => {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  const line = JSON.stringify(event);
  await fs.promises.appendFile(filePath, line + '\n', 'utf-8');
};

/**
 * 通話開始時にユニークなログファイルパスを生成する。
 */
export const createLogFilePath = (): string => {
  const now = new Date();
  const ts = now
    .toISOString()
    .replace(/[-:]/g, '')
    .replace('T', '_')
    .slice(0, 15);
  const random = Math.random().toString(36).slice(2, 8);
  const fileName = `call_${ts}_${random}.ndjson`;
  return path.join(config.logDir, fileName);
};
