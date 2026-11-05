import { describe, expect, it } from 'vitest';
import { parseClaudeEfforts, parseClaudeModels, parseCodexModels, parseDshDefaultModel, parsePiEfforts, parsePiModels, readTomlString } from '../src/server/harness';
import { dshPatch } from '../src/server/agents';

describe('reading model lists', () => {
  it('finds the aliases in the wrapped Claude Code help text', () => {
    const help = `
  --mcp-config <configs...>             Load MCP servers
  --model <model>                       Model for the current session. Provide
                                        an alias for the latest model (e.g.
                                        'fable', 'opus', or 'sonnet') or a
                                        model's full name (e.g.
                                        'claude-fable-5').
  --verbose                             Override verbose mode`;
    expect(parseClaudeModels(help)).toEqual(['fable', 'opus', 'sonnet']);
  });

  it('returns nothing when the help text changes shape', () => {
    expect(parseClaudeModels('Usage: claude [options]')).toEqual([]);
  });

  it('lists visible Codex models with their display names', () => {
    const json = JSON.stringify({
      models: [
        {
          slug: 'gpt-a',
          display_name: 'GPT A',
          visibility: 'list',
          default_reasoning_level: 'medium',
          supported_reasoning_levels: [{ effort: 'low' }, { effort: 'medium' }],
        },
        { slug: 'gpt-hidden', display_name: 'Hidden', visibility: 'hide' },
        { slug: 'gpt-b', visibility: 'list' },
      ],
    });
    expect(parseCodexModels(json)).toEqual([
      { id: 'gpt-a', label: 'GPT A', efforts: ['low', 'medium'], defaultEffort: 'medium' },
      { id: 'gpt-b', label: 'gpt-b', efforts: [], defaultEffort: undefined },
    ]);
  });

  it('reads provider and model from the pi table', () => {
    const table = `provider   model          context  max-out  thinking  images
deepseek   deepseek-flash 1M       384K     yes       yes
kimi       k3             1.0M     131.1K   no        yes
`;
    expect(parsePiModels(table, ['low', 'high'])).toEqual([
      { id: 'deepseek/deepseek-flash', label: 'deepseek/deepseek-flash', efforts: ['low', 'high'] },
      { id: 'kimi/k3', label: 'kimi/k3', efforts: [] },
    ]);
  });

  it('reads thinking levels from each help text', () => {
    expect(parseClaudeEfforts(`  --effort <level>                      Effort level for the current session
                                        (low, medium, high, xhigh, max)
  --environment <id>   Create (a cloud) session`)).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    expect(parsePiEfforts('  --thinking <level>             Set thinking level: off, minimal, low\n  --extension')).toEqual(['off', 'minimal', 'low']);
    expect(parseClaudeEfforts('nothing here')).toEqual([]);
    expect(parsePiEfforts('nothing here')).toEqual([]);
  });

  it('reads the default model from the dsh config dump', () => {
    const config = "- id: jobs\n  name: x\n- id: agent-default-model\n  name: y\n  config:\n    provider: deepseek-official\n    model: deepseek-flash\n- id: z\n";
    expect(parseDshDefaultModel(config)).toBe('deepseek-flash');
    expect(parseDshDefaultModel('')).toBeUndefined();
  });

  it('reads top-level TOML values, not ones under a section', () => {
    const toml = 'approval = "x"\nmodel = "gpt-a"\n\n[profiles.fast]\nmodel = "gpt-b"\n';
    expect(readTomlString(toml, 'model')).toBe('gpt-a');
    expect(readTomlString('[a]\nmodel = "b"\n', 'model')).toBeUndefined();
  });
});

describe('the dsh patch', () => {
  const rows = (patch: string) => patch.trim().split('\n').map((line) => JSON.parse(line.slice(2)));

  it('switches tools off and keeps sessions in the working directory', () => {
    const list = rows(dshPatch({}, '/tmp/x'));
    expect(list).toContainEqual({ id: 'tool-bash', disabled: true });
    expect(list).toContainEqual({ id: 'session-persistence-jsonl', config: { root: '/tmp/x/sessions' } });
    expect(list.some((row) => row.id === 'agent-default-model')).toBe(false);
  });

  it('sets the model and thinking level together', () => {
    const row = rows(dshPatch({ thinking: 'max' }, '/tmp/x')).find((r) => r.id === 'agent-default-model');
    expect(row.config).toEqual({ provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'max' });
  });
});
