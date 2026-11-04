/**
 * Doubao (Volcengine) podcast API, WebSocket v3 binary protocol.
 * https://docs.volcengine.com/docs/doubao-voice/podcast-api-websocket-v3protocol
 */
import { randomUUID } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import WebSocket from 'ws';
import { t } from '../shared/i18n.js';

export const DOUBAO_URL = 'wss://openspeech.bytedance.com/api/v3/sami/podcasttts';
export const DOUBAO_RESOURCE_ID = 'volc.service_type.10050';

export const EVENT = {
  FinishConnection: 2,
  ConnectionFinished: 52,
  StartSession: 100,
  FinishSession: 102,
  SessionStarted: 150,
  SessionFinished: 152,
  SessionFailed: 153,
  UsageResponse: 154,
  PodcastRoundStart: 360,
  PodcastRoundResponse: 361,
  PodcastRoundEnd: 362,
  PodcastEnd: 363,
} as const;

const MSG_FULL_CLIENT = 0b0001;
const MSG_ERROR = 0b1111;
const FLAG_WITH_EVENT = 0b0100;
const SERIAL_JSON = 0b0001;
const COMPRESS_GZIP = 0b0001;

export interface Frame {
  type: number;
  event?: number;
  id?: string;
  errorCode?: number;
  /** Decoded JSON when the frame declares JSON serialization, otherwise undefined. */
  json?: any;
  /** Raw (decompressed) payload bytes. */
  payload: Buffer;
}

export function encodeClientFrame(event: number, sessionId: string | null, payload: unknown): Buffer {
  const header = Buffer.from([0x11, (MSG_FULL_CLIENT << 4) | FLAG_WITH_EVENT, SERIAL_JSON << 4, 0]);
  const body = Buffer.from(JSON.stringify(payload ?? {}), 'utf8');
  const u32 = (n: number) => {
    const b = Buffer.alloc(4);
    b.writeUInt32BE(n);
    return b;
  };
  const parts = [header, u32(event)];
  if (sessionId !== null) {
    const id = Buffer.from(sessionId, 'utf8');
    parts.push(u32(id.length), id);
  }
  parts.push(u32(body.length), body);
  return Buffer.concat(parts);
}

/** Lenient parser: the documented layouts disagree about optional fields, so sizes are validated before use. */
export function decodeFrame(data: Buffer): Frame {
  if (data.length < 4) throw new Error(`Frame too short (${data.length} bytes)`);
  const headerSize = (data[0] & 0x0f) * 4;
  const type = data[1] >> 4;
  const flags = data[1] & 0x0f;
  const serialization = data[2] >> 4;
  const compression = data[2] & 0x0f;
  let off = headerSize;
  const frame: Frame = { type, payload: Buffer.alloc(0) };

  const fits = (size: number) => off + 4 + size <= data.length;
  const readSized = () => {
    const size = data.readUInt32BE(off);
    off += 4;
    const out = data.subarray(off, off + size);
    off += size;
    return out;
  };

  let raw: Buffer;
  if (type === MSG_ERROR) {
    frame.errorCode = data.readUInt32BE(off);
    off += 4;
    raw = off + 4 <= data.length && fits(data.readUInt32BE(off)) ? readSized() : data.subarray(off);
  } else {
    if (flags & FLAG_WITH_EVENT) {
      frame.event = data.readUInt32BE(off);
      off += 4;
      // [id length][id][payload length][payload]. Some frames omit the id.
      if (off + 4 <= data.length) {
        const first = data.readUInt32BE(off);
        const second = off + 4 + first + 4 <= data.length ? data.readUInt32BE(off + 4 + first) : -1;
        if (second >= 0 && off + 4 + first + 4 + second === data.length) {
          frame.id = readSized().toString('utf8');
        }
      }
    }
    raw = off + 4 <= data.length && fits(data.readUInt32BE(off)) ? readSized() : data.subarray(off);
  }
  if (compression === COMPRESS_GZIP && raw.length) raw = gunzipSync(raw);
  frame.payload = raw;
  if (raw.length && (serialization === SERIAL_JSON || type === MSG_ERROR)) {
    try {
      frame.json = JSON.parse(raw.toString('utf8'));
    } catch {
      /* Non-JSON error bodies stay available through `payload`. */
    }
  }
  return frame;
}

const MP3_BITRATES_V1 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const MP3_BITRATES_V2 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
const MP3_RATES: Record<number, number[]> = {
  3: [44100, 48000, 32000],
  2: [22050, 24000, 16000],
  0: [11025, 12000, 8000],
};

/**
 * Each round is delivered as a complete MP3 with its own ID3 tag and Xing/Info frame.
 * Left in, the first Xing header makes players report the first round's length as the
 * whole episode's duration, so both are removed before the rounds are concatenated.
 */
export function stripMp3Metadata(buf: Buffer): Buffer {
  let off = 0;
  if (buf.length > 10 && buf.toString('latin1', 0, 3) === 'ID3') {
    const size = ((buf[6] & 0x7f) << 21) | ((buf[7] & 0x7f) << 14) | ((buf[8] & 0x7f) << 7) | (buf[9] & 0x7f);
    off = 10 + size + (buf[5] & 0x10 ? 10 : 0);
  }
  if (off + 4 > buf.length || buf[off] !== 0xff || (buf[off + 1] & 0xe0) !== 0xe0) return buf.subarray(off);
  const version = (buf[off + 1] >> 3) & 3;
  const bitrate = (version === 3 ? MP3_BITRATES_V1 : MP3_BITRATES_V2)[buf[off + 2] >> 4];
  const rate = MP3_RATES[version]?.[(buf[off + 2] >> 2) & 3];
  if (!bitrate || !rate) return buf.subarray(off);
  const padding = (buf[off + 2] >> 1) & 1;
  const frameLength = Math.floor(((version === 3 ? 144 : 72) * bitrate * 1000) / rate) + padding;
  const head = buf.toString('latin1', off, Math.min(off + 64, buf.length));
  return head.includes('Xing') || head.includes('Info') ? buf.subarray(off + frameLength) : buf.subarray(off);
}

/** Exact playable length in seconds, or 0 if the data doesn't parse as MP3. */
export function measureMp3(buf: Buffer): number {
  let off = 0;
  let seconds = 0;
  while (off + 4 <= buf.length) {
    if (buf[off] !== 0xff || (buf[off + 1] & 0xe0) !== 0xe0) break;
    const version = (buf[off + 1] >> 3) & 3;
    const bitrate = (version === 3 ? MP3_BITRATES_V1 : MP3_BITRATES_V2)[buf[off + 2] >> 4];
    const rate = MP3_RATES[version]?.[(buf[off + 2] >> 2) & 3];
    if (!bitrate || !rate) break;
    const padding = (buf[off + 2] >> 1) & 1;
    off += Math.floor(((version === 3 ? 144 : 72) * bitrate * 1000) / rate) + padding;
    seconds += (version === 3 ? 1152 : 576) / rate;
  }
  return seconds;
}

export interface SynthesisRound {
  /** Server round id: -1 is intro music, 9999 is outro music. */
  roundId: number;
  speaker: string;
  text: string;
  start: number;
  end: number;
}

export interface SynthesisResult {
  taskId: string;
  rounds: SynthesisRound[];
  duration: number;
  usage: { inputTextTokens: number; outputAudioTokens: number };
  inputTruncated?: boolean;
}

export interface SynthesisOptions {
  apiKey: string;
  resourceId?: string;
  url?: string;
  /** StartSession payload, without retry_info. Its audio format must be MP3. */
  payload: Record<string, unknown>;
  /** Called with audio for a completed round only, so a resumed file never holds half a round. */
  onAudio: (chunk: Buffer) => void;
  onRound?: (round: SynthesisRound) => void;
  signal?: AbortSignal;
  maxRetries?: number;
}

export class DoubaoError extends Error {
  constructor(
    message: string,
    readonly code?: number,
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'DoubaoError';
  }
}

const errorHint = (code: number): string | undefined =>
  (
    {
      40000010: t('请求参数错误'),
      40000022: t('严格风控下文本审核未通过'),
      45000000: t('并发超限，请稍后重试'),
      50302102: t('内容安全审核拦截或文本超长'),
      55000000: t('服务端错误'),
    } as Record<number, string>
  )[code];

function describeError(code: number | undefined, body: unknown): string {
  const detail = typeof body === 'string' ? body : (body as any)?.message ?? (body as any)?.error ?? JSON.stringify(body ?? '');
  const hint = code !== undefined ? errorHint(code) : undefined;
  return [hint, detail, code !== undefined ? `(code ${code})` : ''].filter(Boolean).join(' ');
}

/** Generates one podcast, resuming from the last complete round if the socket drops midway. */
export async function synthesizePodcast(opts: SynthesisOptions): Promise<SynthesisResult> {
  const taskId = randomUUID();
  const state: SynthesisResult & { lastRound: number | null } = {
    taskId,
    rounds: [],
    duration: 0,
    usage: { inputTextTokens: 0, outputAudioTokens: 0 },
    lastRound: null,
  };
  const maxRetries = opts.maxRetries ?? 3;
  for (let attempt = 0; ; attempt++) {
    try {
      await runSession(opts, state, attempt === 0 ? taskId : randomUUID());
      const { lastRound: _lastRound, ...result } = state;
      return result;
    } catch (err) {
      if (!(err instanceof DoubaoError) || !err.retryable || attempt >= maxRetries || opts.signal?.aborted) throw err;
      await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1)));
    }
  }
}

function runSession(
  opts: SynthesisOptions,
  state: SynthesisResult & { lastRound: number | null },
  sessionId: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(opts.url ?? DOUBAO_URL, {
      headers: {
        'X-Api-Key': opts.apiKey,
        'X-Api-Resource-Id': opts.resourceId || DOUBAO_RESOURCE_ID,
        'X-Api-Request-Id': randomUUID(),
      },
      handshakeTimeout: 20_000,
    });

    let settled = false;
    let finished = false;
    let open: { roundId: number; speaker: string; text: string; audio: Buffer[] } | null = null;

    const settle = (err?: Error) => {
      if (settled) return;
      settled = true;
      opts.signal?.removeEventListener('abort', onAbort);
      clearTimeout(idle);
      try {
        if (ws.readyState === WebSocket.OPEN) ws.send(encodeClientFrame(EVENT.FinishConnection, null, {}));
        ws.close();
      } catch {
        /* The socket is being discarded either way. */
      }
      if (err) reject(err);
      else resolve();
    };
    const onAbort = () => {
      ws.terminate();
      settle(new DoubaoError(t('已取消')));
    };
    opts.signal?.addEventListener('abort', onAbort, { once: true });

    // The server can spend a while on long inputs, but total silence means a dead connection.
    let idle: NodeJS.Timeout = setTimeout(() => {}, 0);
    const touch = () => {
      if (settled) return;
      clearTimeout(idle);
      idle = setTimeout(() => {
        ws.terminate();
        settle(new DoubaoError(t('服务端长时间无响应'), undefined, true));
      }, 180_000);
    };
    touch();

    ws.on('unexpected-response', (_req, res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        const hint =
          res.statusCode === 401 || res.statusCode === 403 ? t('鉴权失败：请检查 API Key 和服务开通状态。') : t('建连失败。');
        settle(new DoubaoError(`${hint} HTTP ${res.statusCode} ${body}`.trim()));
      });
    });

    ws.on('open', () => {
      touch();
      const payload: Record<string, unknown> = { ...opts.payload };
      if (state.lastRound !== null) {
        payload.retry_info = { retry_task_id: state.taskId, last_finished_round_id: state.lastRound };
      }
      ws.send(encodeClientFrame(EVENT.StartSession, sessionId, payload));
      // Despite the docs, the server only emits SessionFinished once the client has sent this.
      ws.send(encodeClientFrame(EVENT.FinishSession, sessionId, {}));
    });

    ws.on('message', (data: Buffer) => {
      touch();
      let frame: Frame;
      try {
        frame = decodeFrame(data);
      } catch (err) {
        settle(new DoubaoError(t('无法解析服务端帧：{error}', { error: (err as Error).message })));
        return;
      }
      if (frame.type === MSG_ERROR) {
        const body = frame.json ?? frame.payload.toString('utf8');
        settle(new DoubaoError(describeError(frame.errorCode, body), frame.errorCode, frame.errorCode === 55000000));
        return;
      }
      switch (frame.event) {
        case EVENT.PodcastRoundStart: {
          const j = frame.json ?? {};
          open = { roundId: j.round_id ?? 0, speaker: j.speaker ?? '', text: j.text ?? '', audio: [] };
          break;
        }
        case EVENT.PodcastRoundResponse:
          open?.audio.push(Buffer.from(frame.payload));
          break;
        case EVENT.PodcastRoundEnd: {
          const j = frame.json ?? {};
          if (j.is_error) {
            settle(new DoubaoError(j.error_msg || t('轮次合成失败'), undefined, true));
            return;
          }
          if (open) {
            const audio = stripMp3Metadata(Buffer.concat(open.audio));
            // The server's durations are shorter than the audio it sends, by enough to
            // drift a long transcript out of sync, so time is measured from the audio.
            const duration = measureMp3(audio) || Number(j.audio_duration) || 0;
            const round: SynthesisRound = {
              roundId: open.roundId,
              speaker: open.speaker,
              text: open.text,
              start: state.duration,
              end: state.duration + duration,
            };
            opts.onAudio(audio);
            state.duration = round.end;
            state.rounds.push(round);
            state.lastRound = round.roundId;
            opts.onRound?.(round);
            open = null;
          }
          break;
        }
        case EVENT.PodcastEnd:
          if (frame.json?.meta_info?.input_metrics?.input_text_truncated) state.inputTruncated = true;
          break;
        case EVENT.UsageResponse: {
          const usage = frame.json?.usage ?? {};
          state.usage.inputTextTokens += usage.input_text_tokens ?? 0;
          state.usage.outputAudioTokens += usage.output_audio_tokens ?? 0;
          break;
        }
        case EVENT.SessionFailed:
          settle(new DoubaoError(describeError(undefined, frame.json ?? frame.payload.toString('utf8'))));
          break;
        case EVENT.SessionFinished: {
          const status = frame.json?.status_code;
          if (status !== undefined && status !== 20000000 && status !== 0) {
            settle(new DoubaoError(describeError(status, frame.json?.message ?? frame.json), status));
            return;
          }
          finished = true;
          settle();
          break;
        }
      }
    });

    ws.on('error', (err) => {
      settle(new DoubaoError(t('连接错误：{error}', { error: err.message }), undefined, true));
    });
    ws.on('close', (code) => {
      if (!finished) settle(new DoubaoError(t('连接在合成完成前断开 ({code})', { code }), undefined, true));
    });
  });
}
