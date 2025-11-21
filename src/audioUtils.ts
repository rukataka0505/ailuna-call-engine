/**
 * 音声処理ユーティリティ。
 * Twilio Media Streams の μ-law 8kHz mono と OpenAI Realtime の PCM16 16kHz mono を相互変換する。
 */

const MULAW_MAX = 0x1FFF;
const MULAW_BIAS = 0x84;
const MULAW_CLIP = 32635;

const mulawTable = new Int16Array(256);
for (let i = 0; i < 256; i += 1) {
  const value = (~i) & 0xff;
  let t = ((value & 0x0f) << 3) + MULAW_BIAS;
  t <<= (value & 0x70) >> 4;
  mulawTable[i] = (value & 0x80) ? (MULAW_BIAS - t) : (t - MULAW_BIAS);
}

/** μ-law 8kHz mono → PCM16 8kHz mono */
export const mulawToPcm16 = (mulawBuffer: Buffer): Buffer => {
  const pcm = Buffer.alloc(mulawBuffer.length * 2);
  for (let i = 0; i < mulawBuffer.length; i += 1) {
    const pcmValue = mulawTable[mulawBuffer[i]];
    pcm.writeInt16LE(pcmValue, i * 2);
  }
  return pcm;
};



/**
 * シンプルな線形補間による PCM16 mono resampling。
 * fromRate, toRate は 8000↔16000 を想定。
 */
export const resamplePcm16Mono = (input: Buffer, fromRate: number, toRate: number): Buffer => {
  if (fromRate === toRate) {
    return Buffer.from(input);
  }

  const samples = input.length / 2;
  const ratio = toRate / fromRate;
  const outputSamples = Math.round(samples * ratio);
  const output = Buffer.alloc(outputSamples * 2);

  for (let i = 0; i < outputSamples; i += 1) {
    const srcIndex = i / ratio;
    const srcLow = Math.floor(srcIndex);
    const srcHigh = Math.min(srcLow + 1, samples - 1);
    const weight = srcIndex - srcLow;

    const lowSample = input.readInt16LE(srcLow * 2);
    const highSample = input.readInt16LE(srcHigh * 2);
    const interpolated = (1 - weight) * lowSample + weight * highSample;
    output.writeInt16LE(Math.round(interpolated), i * 2);
  }

  return output;
};
