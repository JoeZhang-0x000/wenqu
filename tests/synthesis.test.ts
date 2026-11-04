import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';
import { EVENT, DoubaoError, synthesizePodcast } from '../src/server/doubao';

const u32 = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
};

function send(ws: WebSocket, event: number, id: string, body: Buffer | object) {
  const raw = Buffer.isBuffer(body);
  const payload = raw ? body : Buffer.from(JSON.stringify(body));
  const idBytes = Buffer.from(id);
  ws.send(Buffer.concat([Buffer.from([0x11, raw ? 0xb4 : 0x94, raw ? 0x00 : 0x10, 0]), u32(event), u32(idBytes.length), idBytes, u32(payload.length), payload]));
}

/** Reads the session id and JSON payload out of a client frame. */
function readClientFrame(data: Buffer) {
  const event = data.readUInt32BE(4);
  const idLength = data.readUInt32BE(8);
  const id = data.toString('utf8', 12, 12 + idLength);
  const size = data.readUInt32BE(12 + idLength);
  return { event, id, payload: JSON.parse(data.toString('utf8', 16 + idLength, 16 + idLength + size)) };
}

// One 24 ms MPEG-2 Layer III frame.
const mp3Frame = (fill: number) => {
  const frame = Buffer.alloc(144, fill);
  frame.set([0xff, 0xf3, 0x64, 0x00]);
  return frame;
};

function round(ws: WebSocket, id: string, roundId: number, fill: number) {
  send(ws, EVENT.PodcastRoundStart, id, { round_id: roundId, speaker: 'spk', text: `round ${roundId}` });
  send(ws, EVENT.PodcastRoundResponse, id, mp3Frame(fill));
  send(ws, EVENT.PodcastRoundEnd, id, { audio_duration: 9.99 });
}

describe('synthesizePodcast', () => {
  let server: WebSocketServer;
  afterEach(() => server?.close());

  const start = (onSession: (ws: WebSocket, session: ReturnType<typeof readClientFrame>, attempt: number) => void) =>
    new Promise<string>((resolve) => {
      let attempts = 0;
      server = new WebSocketServer({ port: 0, host: '127.0.0.1' }, () => {
        const { port } = server.address() as { port: number };
        resolve(`ws://127.0.0.1:${port}`);
      });
      server.on('connection', (ws) => {
        const attempt = attempts++;
        ws.on('message', (data: Buffer) => {
          // Other client frames, such as FinishConnection, have a different layout.
          if (data.readUInt32BE(4) === EVENT.StartSession) onSession(ws, readClientFrame(data), attempt);
        });
      });
    });

  it('writes whole rounds and measures their length from the audio', async () => {
    const url = await start((ws, { id }) => {
      send(ws, EVENT.SessionStarted, id, {});
      round(ws, id, -1, 0x01);
      round(ws, id, 0, 0x02);
      send(ws, EVENT.UsageResponse, id, { usage: { output_audio_tokens: 7 } });
      send(ws, EVENT.SessionFinished, id, {});
    });
    const audio: Buffer[] = [];
    const result = await synthesizePodcast({ apiKey: 'k', url, payload: {}, onAudio: (c) => audio.push(c) });
    expect(result.rounds.map((r) => r.roundId)).toEqual([-1, 0]);
    expect(result.rounds[1].start).toBeCloseTo(0.024);
    expect(result.duration).toBeCloseTo(0.048);
    expect(result.usage.outputAudioTokens).toBe(7);
    expect(Buffer.concat(audio).length).toBe(288);
  });

  it('drops the partial round and resumes after a disconnect', async () => {
    const sessions: ReturnType<typeof readClientFrame>[] = [];
    const url = await start((ws, session, attempt) => {
      sessions.push(session);
      const { id } = session;
      send(ws, EVENT.SessionStarted, id, {});
      if (attempt === 0) {
        round(ws, id, 0, 0x02);
        send(ws, EVENT.PodcastRoundStart, id, { round_id: 1, speaker: 'spk', text: 'cut off' });
        send(ws, EVENT.PodcastRoundResponse, id, mp3Frame(0xee));
        setTimeout(() => ws.terminate(), 20);
      } else {
        round(ws, id, 1, 0x03);
        send(ws, EVENT.SessionFinished, id, {});
      }
    });
    const audio: Buffer[] = [];
    const result = await synthesizePodcast({ apiKey: 'k', url, payload: { action: 3 }, onAudio: (c) => audio.push(c) });
    expect(sessions[1].payload.retry_info).toEqual({ retry_task_id: sessions[0].id, last_finished_round_id: 0 });
    expect(sessions[1].id).not.toBe(sessions[0].id);
    expect(result.rounds.map((r) => r.text)).toEqual(['round 0', 'round 1']);
    expect(Buffer.concat(audio).includes(Buffer.from([0xee, 0xee]))).toBe(false);
  });

  it('reports API errors without retrying them', async () => {
    let calls = 0;
    const url = await start((ws) => {
      calls++;
      const body = Buffer.from('{"error":"bad text"}');
      ws.send(Buffer.concat([Buffer.from([0x11, 0xf0, 0x10, 0]), u32(40000010), u32(body.length), body]));
    });
    const error = await synthesizePodcast({ apiKey: 'k', url, payload: {}, onAudio: () => {} }).catch((e) => e);
    expect(error).toBeInstanceOf(DoubaoError);
    expect(error.message).toContain('bad text');
    expect(error.code).toBe(40000010);
    expect(calls).toBe(1);
  });

  it('stops when cancelled', async () => {
    const url = await start((ws, { id }) => send(ws, EVENT.SessionStarted, id, {}));
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    await expect(synthesizePodcast({ apiKey: 'k', url, payload: {}, signal: controller.signal, onAudio: () => {} })).rejects.toThrow('Cancelled');
  });
});
