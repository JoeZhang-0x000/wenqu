import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { TOOL_TAG } from '../src/shared/assistant';
import { Config } from '../src/server/config';
import { createApp, listen } from '../src/server/server';

const agent = vi.hoisted(() => ({ replies: [] as string[] }));
vi.mock('../src/server/agents', () => ({
  runAgent: async () => agent.replies.shift() ?? 'Done.',
}));

describe('assistant routes', () => {
  let root: string;
  let server: Server;
  let base: string;
  let settled: (id: string) => Promise<unknown>;
  let paperId: string;

  const call = async (path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await fetch(`${base}/api${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, data: (await res.json()) as any };
  };

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'wenqu-routes-'));
    process.env.WENQU_CONFIG_DIR = join(root, 'config');
    const { app, jobs, getVault } = createApp({ config: new Config(join(root, 'vault')) });
    ({ server } = await listen(app, 4600));
    const address = server.address() as { port: number };
    base = `http://127.0.0.1:${address.port}`;
    settled = (id) => jobs.settled(id);
    paperId = (await getVault().importPdf(readFileSync(join(__dirname, 'fixtures', 'cpn.pdf')), 'cpn.pdf')).meta.id;
  });

  afterAll(() => {
    server.close();
    delete process.env.WENQU_CONFIG_DIR;
    rmSync(root, { recursive: true, force: true });
  });

  beforeEach(() => {
    agent.replies = [];
  });

  it('changes nothing until the user approves over the API', async () => {
    agent.replies = [`<${TOOL_TAG}>[{"tool":"update_paper","args":{"paper":"${paperId}","year":1999}}]</${TOOL_TAG}>`];
    const { data: created } = await call('/assistant/sessions', { message: 'fix the year', harness: 'claude' });
    await settled(created.sessionId);

    const { data: list } = await call('/assistant/sessions');
    expect(list[0]).toMatchObject({ id: created.sessionId, pending: 1 });
    expect(list[0].messages).toBeUndefined();
    expect((await call(`/papers/${paperId}`)).data.year).not.toBe(1999);

    const { data: session } = await call(`/assistant/sessions/${created.sessionId}`);
    const [action] = session.messages.at(-1).actions;
    await call(`/assistant/sessions/${created.sessionId}/decide`, { approve: [action.id] });
    await settled(created.sessionId);
    expect((await call(`/papers/${paperId}`)).data.year).toBe(1999);
  });

  it('rejects a decision from another website', async () => {
    const { data: created } = await call('/assistant/sessions', { message: 'hello', harness: 'claude' });
    await settled(created.sessionId);
    const { status } = await call(`/assistant/sessions/${created.sessionId}/decide`, { approve: [] }, { Origin: 'https://evil.example' });
    expect(status).toBe(403);
  });

  it('validates what it is sent', async () => {
    expect((await call('/assistant/sessions', { message: '  ', harness: 'claude' })).status).toBe(400);
    expect((await call('/assistant/sessions', { message: 'hi', harness: 'rm' })).status).toBe(400);
    expect((await call('/assistant/sessions/not-a-session')).status).toBe(404);
    expect((await call('/assistant/sessions/../../etc')).status).toBe(404);
    const { data: created } = await call('/assistant/sessions', { message: 'hi', harness: 'claude' });
    await settled(created.sessionId);
    expect((await call(`/assistant/sessions/${created.sessionId}/decide`, { approve: 'all' })).status).toBe(400);
  });
});
