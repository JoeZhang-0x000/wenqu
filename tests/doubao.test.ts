import { describe, expect, it } from 'vitest';
import { gzipSync } from 'node:zlib';
import { decodeFrame, encodeClientFrame, EVENT, measureMp3, stripMp3Metadata } from '../src/server/doubao';

function serverFrame(opts: { type: number; event?: number; id?: string; body: Buffer; serialization?: number; compression?: number }) {
  const u32 = (n: number) => {
    const b = Buffer.alloc(4);
    b.writeUInt32BE(n);
    return b;
  };
  const header = Buffer.from([0x11, (opts.type << 4) | (opts.event !== undefined ? 4 : 0), ((opts.serialization ?? 1) << 4) | (opts.compression ?? 0), 0]);
  const parts = [header];
  if (opts.event !== undefined) parts.push(u32(opts.event));
  if (opts.id) parts.push(u32(opts.id.length), Buffer.from(opts.id));
  parts.push(u32(opts.body.length), opts.body);
  return Buffer.concat(parts);
}

describe('frames', () => {
  it('encodes a StartSession frame in the documented layout', () => {
    const frame = encodeClientFrame(EVENT.StartSession, 'abc', { action: 3 });
    expect([...frame.subarray(0, 4)]).toEqual([0x11, 0x14, 0x10, 0x00]);
    expect(frame.readUInt32BE(4)).toBe(100);
    expect(frame.readUInt32BE(8)).toBe(3);
    expect(frame.toString('utf8', 12, 15)).toBe('abc');
    const size = frame.readUInt32BE(15);
    expect(JSON.parse(frame.toString('utf8', 19, 19 + size))).toEqual({ action: 3 });
  });

  it('omits the session id from FinishConnection', () => {
    const frame = encodeClientFrame(EVENT.FinishConnection, null, {});
    expect(frame.readUInt32BE(4)).toBe(2);
    expect(frame.readUInt32BE(8)).toBe(2);
    expect(frame.toString('utf8', 12)).toBe('{}');
  });

  it('decodes JSON frames', () => {
    const frame = decodeFrame(serverFrame({ type: 0b1001, event: 360, id: 'sess', body: Buffer.from('{"round_id":1}') }));
    expect(frame).toMatchObject({ event: 360, id: 'sess', json: { round_id: 1 } });
  });

  it('decodes audio frames as raw bytes', () => {
    const audio = Buffer.from([1, 2, 3, 4]);
    const frame = decodeFrame(serverFrame({ type: 0b1011, event: 361, id: 'sess', body: audio, serialization: 0 }));
    expect(frame.event).toBe(361);
    expect(frame.json).toBeUndefined();
    expect(frame.payload.equals(audio)).toBe(true);
  });

  it('decompresses gzip payloads', () => {
    const body = gzipSync(Buffer.from('{"ok":true}'));
    expect(decodeFrame(serverFrame({ type: 0b1001, event: 150, id: 's', body, compression: 1 })).json).toEqual({ ok: true });
  });

  it('decodes error frames with and without a length prefix', () => {
    const code = Buffer.alloc(4);
    code.writeUInt32BE(40000010);
    const body = Buffer.from('{"error":"bad"}');
    const size = Buffer.alloc(4);
    size.writeUInt32BE(body.length);
    const head = Buffer.from([0x11, 0xf0, 0x10, 0]);
    const withSize = decodeFrame(Buffer.concat([head, code, size, body]));
    expect(withSize).toMatchObject({ errorCode: 40000010, json: { error: 'bad' } });
    const withoutSize = decodeFrame(Buffer.concat([head, code, body]));
    expect(withoutSize).toMatchObject({ errorCode: 40000010, json: { error: 'bad' } });
  });
});

describe('stripMp3Metadata', () => {
  // MPEG-2 Layer III, 48 kbps, 24 kHz: 72 * 48000 / 24000 = 144 bytes per frame.
  const frame = (marker?: string) => {
    const b = Buffer.alloc(144);
    b.set([0xff, 0xf3, 0x64, 0x00]);
    if (marker) b.write(marker, 21, 'latin1');
    return b;
  };
  const id3 = Buffer.concat([Buffer.from('ID3'), Buffer.from([4, 0, 0, 0, 0, 0, 5]), Buffer.alloc(5, 7)]);

  it('removes the ID3 tag and the Info frame', () => {
    const audio = frame();
    expect(stripMp3Metadata(Buffer.concat([id3, frame('Info'), audio])).equals(audio)).toBe(true);
  });

  it('keeps real audio frames', () => {
    const audio = Buffer.concat([frame(), frame()]);
    expect(stripMp3Metadata(audio).equals(audio)).toBe(true);
  });

  it('measures length from the frames', () => {
    // 576 samples per frame at 24 kHz is 24 ms.
    expect(measureMp3(Buffer.concat([frame(), frame(), frame()]))).toBeCloseTo(0.072);
    expect(measureMp3(Buffer.from('not an mp3'))).toBe(0);
  });

  it('leaves unknown data alone', () => {
    const data = Buffer.from('not an mp3 at all');
    expect(stripMp3Metadata(data).equals(data)).toBe(true);
  });
});
