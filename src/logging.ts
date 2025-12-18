import fs from 'fs';
import path from 'path';
import { config } from './config';
import { RealtimeLogEvent } from './types';

// Cache for directories that have been created
const createdDirs = new Set<string>();

// Cache for active write streams (per log file)
const activeStreams = new Map<string, fs.WriteStream>();

/**
 * Ensure directory exists (cached - mkdir only on first call per dir)
 */
const ensureDir = async (dirPath: string): Promise<void> => {
  if (createdDirs.has(dirPath)) return;
  await fs.promises.mkdir(dirPath, { recursive: true });
  createdDirs.add(dirPath);
};

/**
 * Get or create a WriteStream for a log file
 */
const getStream = (filePath: string): fs.WriteStream => {
  let stream = activeStreams.get(filePath);
  if (!stream) {
    stream = fs.createWriteStream(filePath, { flags: 'a', encoding: 'utf-8' });
    activeStreams.set(filePath, stream);
    // Clean up on stream close
    stream.on('close', () => activeStreams.delete(filePath));
  }
  return stream;
};

/**
 * NDJSON の 1 行を書き出すユーティリティ。
 * WriteStream を使用して高速に書き込み。
 */
export const writeLog = async (filePath: string, event: RealtimeLogEvent): Promise<void> => {
  await ensureDir(path.dirname(filePath));
  const stream = getStream(filePath);
  const line = JSON.stringify(event) + '\n';
  stream.write(line);
};

/**
 * Close the WriteStream for a specific log file.
 * Call this when the call ends to ensure proper cleanup.
 */
export const closeLogStream = (filePath: string): void => {
  const stream = activeStreams.get(filePath);
  if (stream) {
    stream.end();
    activeStreams.delete(filePath);
  }
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
