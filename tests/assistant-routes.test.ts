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

  it('changes a card and retries over the API, within what is offered', async () => {
    agent.replies = [`<${TOOL_TAG}>[{"tool":"generate_blog","args":{"paper":"${paperId}"}}]</${TOOL_TAG}>`];
    const { data: created } = await call('/assistant/sessions', { message: 'write', harness: 'claude' });
    await settled(created.sessionId);
    const path = `/assistant/sessions/${created.sessionId}`;
    const { data: session } = await call(path);
    const [action] = session.messages.at(-1).actions;

    const patch = (body: unknown, headers: Record<string, string> = {}) =>
      fetch(`${base}/api${path}/actions/${action.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
    expect((await patch({ language: 'klingon' })).status).toBe(400);
    expect((await patch({ language: 'en' }, { Origin: 'https://evil.example' })).status).toBe(403);
    const edited = (await (await patch({ language: 'en' })).json()) as any;
    expect(edited.messages.at(-1).actions[0].args.language).toBe('en');

    expect((await call(`${path}/retry`, { actions: [action.id] })).status).toBe(400);
    expect((await call(`${path}/retry`, { actions: 'all' })).status).toBe(400);
    expect((await call(`${path}/retry`, { actions: [action.id] }, { Origin: 'https://evil.example' })).status).toBe(403);
  });

  describe('tags', () => {
    const patch = async (body: unknown) => {
      const res = await fetch(`${base}/api/papers/${paperId}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      return { status: res.status, data: (await res.json()) as any };
    };
    const fixture = (name: string) => readFileSync(join(__dirname, 'fixtures', name));

    beforeEach(() => patch({ tags: [] }));

    it('saves, tidies and counts them', async () => {
      const { data } = await patch({ tags: [' #LLM ', 'llm', 'information   retrieval'] });
      expect(data.tags).toEqual(['LLM', 'information retrieval']);
      expect((await call('/tags')).data).toEqual([
        { tag: 'information retrieval', count: 1 },
        { tag: 'LLM', count: 1 },
      ]);
    });

    it('leaves them alone when given something that is not a list', async () => {
      await patch({ tags: ['kept'] });
      expect((await patch({ tags: 'oops' })).status).toBe(400);
      expect((await call(`/papers/${paperId}`)).data.tags).toEqual(['kept']);
    });

    it('refuses more than a paper can have', async () => {
      const { status } = await patch({ tags: Array.from({ length: 13 }, (_, i) => `tag ${i}`) });
      expect(status).toBe(400);
      expect((await call(`/papers/${paperId}`)).data.tags).toEqual([]);
    });

    it('generates them on request, on top of what is there', async () => {
      await patch({ tags: ['kept'] });
      agent.replies = ['Here you go:\n```json\n["kept", "re-ranking", "pruning"]\n```'];
      const { data: job } = await call(`/papers/${paperId}/tags/generate`, {});
      expect(job).toMatchObject({ kind: 'tags', status: 'running', paperId });
      await settled(`tags-${paperId}`);
      expect((await call(`/papers/${paperId}`)).data.tags).toEqual(['kept', 're-ranking', 'pruning']);
    });

    it('keeps the tags as they are when the agent says nothing useful', async () => {
      await patch({ tags: ['kept'] });
      agent.replies = ['Sorry, see [p.3].'];
      await call(`/papers/${paperId}/tags/generate`, {});
      const job = (await settled(`tags-${paperId}`)) as { status: string; error: string };
      expect(job.status).toBe('failed');
      expect((await call(`/papers/${paperId}`)).data.tags).toEqual(['kept']);
    });

    it('generates them for a new paper only when asked', async () => {
      const upload = async (name: string, query = '') => {
        const res = await fetch(`${base}/api/papers?filename=${name}.pdf${query}`, { method: 'POST', body: fixture('cpn-zh.pdf') });
        return (await res.json()) as any;
      };
      const plain = await upload('plain');
      expect(plain.paper.tags).toEqual([]);
      expect((await call('/jobs')).data.some((j: any) => j.targetId === `tags-${plain.paper.id}`)).toBe(false);

      await fetch(`${base}/api/papers/${plain.paper.id}`, { method: 'DELETE' });
      agent.replies = ['["pruning"]'];
      const asked = await upload('asked', '&autoTag=1');
      expect(asked.duplicate).toBe(false);
      await settled(`tags-${asked.paper.id}`);
      expect((await call(`/papers/${asked.paper.id}`)).data.tags).toEqual(['pruning']);

      // Nothing new was added, so a tagged paper isn't tagged again.
      agent.replies = ['["unwanted"]'];
      expect((await upload('again', '&autoTag=1')).duplicate).toBe(true);
      await settled(`tags-${asked.paper.id}`);
      expect((await call(`/papers/${asked.paper.id}`)).data.tags).toEqual(['pruning']);
    });

    it('remembers the choice to tag new papers', async () => {
      const put = await fetch(`${base}/api/settings`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ library: { autoTag: true } }) });
      expect(((await put.json()) as any).library.autoTag).toBe(true);
      expect((await call('/settings')).data.library.autoTag).toBe(true);
    });
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
