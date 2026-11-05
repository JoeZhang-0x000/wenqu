import { describe, expect, it } from 'vitest';
import { extractRepoMentions, rankRepoCandidates, repoFromLink } from '../src/server/repo-detect';

const repos = (text: string) => extractRepoMentions(text).map((r) => `${r.owner}/${r.name}`);
const names = (candidates: { owner: string; name: string }[]) => candidates.map((c) => `${c.owner}/${c.name}`);

describe('finding repositories in text', () => {
  it.each([
    ['a plain URL', 'see https://github.com/foo/bar for more', 'foo/bar'],
    ['no scheme', 'at github.com/foo/bar.', 'foo/bar'],
    ['www', 'http://www.github.com/foo/bar', 'foo/bar'],
    ['a trailing .git', 'git clone https://github.com/foo/bar.git', 'foo/bar'],
    ['trailing punctuation', '(https://github.com/foo/bar).', 'foo/bar'],
    ['a trailing comma', 'https://github.com/foo/bar, and', 'foo/bar'],
    ['a deeper path', 'https://github.com/foo/bar/tree/main/src', 'foo/bar'],
    ['a fragment', 'https://github.com/foo/bar#readme', 'foo/bar'],
    ['an ssh address', 'git@github.com:foo/bar.git', 'foo/bar'],
    ['dots and underscores', 'github.com/foo/llm_test.v2', 'foo/llm_test.v2'],
    ['a break after the host', 'https://github.com/\nfoo/bar here', 'foo/bar'],
    ['a break after the owner', 'https://github.com/foo/\nbar here', 'foo/bar'],
    ['a break inside the owner', 'https://github.com/redai-\nstudio/HYPIC here', 'redai-studio/HYPIC'],
    ['a break after a hyphen in the name', 'github.com/fla-org/flash-linear-\nattention is', 'fla-org/flash-linear-attention'],
    ['a break inside a footnote URL', '1 https://github.com/ruipeterpan/mar\nconi\n2 Another footnote', 'ruipeterpan/marconi'],
    ['a space from extraction', 'github. com/foo/bar', 'foo/bar'],
  ])('reads %s', (_name, text, expected) => {
    expect(repos(text)).toEqual([expected]);
  });

  it.each([
    ['the next word of a sentence', 'https://github.com/foo/bar\nfor details', 'foo/bar'],
    ['a sentence that ends the URL', 'at https://github.com/foo/bar.\nThe code', 'foo/bar'],
    ['a page number', 'https://github.com/foo/bar\n12', 'foo/bar'],
    ['a heading', 'https://github.com/foo/bar\nIntroduction', 'foo/bar'],
    ['a single word that ends a sentence', 'https://github.com/foo/bar\nonline.', 'foo/bar'],
  ])('does not join %s', (_name, text, expected) => {
    expect(repos(text)).toEqual([expected]);
  });

  it.each([
    ['/topics', 'https://github.com/topics/llm'],
    ['/features', 'https://github.com/features/actions'],
    ['/orgs', 'https://github.com/orgs/nvidia/repositories'],
    ['/sponsors', 'https://github.com/sponsors/foo'],
    ['/marketplace', 'https://github.com/marketplace/actions'],
    ['an owner alone', 'https://github.com/foo'],
    ['the home page', 'https://github.com/'],
    ['a similar host', 'https://mygithub.com/foo/bar'],
    ['a subdomain', 'https://gist.github.com/foo/bar'],
    ['a pages site', 'https://foo.github.io/bar'],
    ['an owner that would be an option', 'https://github.com/--upload-pack=x/bar'],
    ['a name that would be an option', 'https://github.com/foo/-bar'],
    ['a parent directory', 'https://github.com/foo/..'],
    ['an owner with a dot', 'https://github.com/foo.bar/baz'],
  ])('rejects %s', (_name, text) => {
    expect(repos(text)).toEqual([]);
  });

  it('reads the repository behind a link annotation', () => {
    expect(repoFromLink('https://github.com/foo/bar/blob/main/x.py#L3')).toEqual({ owner: 'foo', name: 'bar', rest: 'blob/main/x.py' });
    expect(repoFromLink('https://github.com/topics/llm')).toBeNull();
    expect(repoFromLink('https://example.com/github.com/foo/bar')).toBeNull();
    expect(repoFromLink('mailto:someone@github.com')).toBeNull();
  });
});

describe('ranking repositories', () => {
  const REFS = 'References\n[1] Someone. 2024. A thing.';

  it('puts HYPIC first, above the dependencies it mentions', () => {
    const ranked = rankRepoCandidates({
      title: 'HYPIC: Position-Independent Caching for Hybrid-Attention LLM Serving',
      pages: [
        'HYPIC\nAbstract. We present HYPIC.',
        'Our code is available at https://github.com/redai-studio/HYPIC.\n1 Introduction',
        'We transfer states with NIXL (https://github.com/ai-dynamo/nixl).\nWe use the fla library (https://github.com/fla-org/flash-linear-attention) for the layers.',
        `${REFS}\n[36] https://github.com/ai-dynamo/nixl\n[37] https://github.com/fla-org/flash-linear-attention`,
      ],
    });
    expect(names(ranked)[0]).toBe('redai-studio/HYPIC');
    expect(ranked[0].likely).toBe(true);
    expect(ranked.slice(1).every((c) => !c.likely)).toBe(true);
  });

  it('puts Marconi first, above a benchmark it mentions more often', () => {
    const ranked = rankRepoCandidates({
      title: 'Marconi: Prefix Caching for the Era of Hybrid LLMs',
      pages: [
        'Marconi\nAbstract.',
        'Source code: https://github.com/ruipeterpan/marconi',
        'We use the needle test from github.com/gkamradt/LLMTest_NeedleInAHaystack and again github.com/gkamradt/LLMTest_NeedleInAHaystack in the study of github.com/gkamradt/LLMTest_NeedleInAHaystack.',
      ],
    });
    expect(names(ranked)[0]).toBe('ruipeterpan/marconi');
    expect(ranked[0].likely).toBe(true);
    expect(ranked[1].likely).toBe(false);
  });

  it('calls nothing likely when CAKE only lists its dependencies', () => {
    const ranked = rankRepoCandidates({
      title: 'CAKE: Compiler-Agent Co-Design for Frontier Kernel Evolution',
      pages: [
        'CAKE\nAbstract.',
        'We compare with FlashInfer (https://github.com/flashinfer-ai/flashinfer) as a baseline.',
        `${REFS}\nhttps://github.com/NVIDIA/TensorRT-LLM\nhttps://github.com/triton-lang/triton\nhttps://github.com/NVIDIA/cutile-python`,
      ],
    });
    expect(ranked).toHaveLength(4);
    expect(ranked.some((c) => c.likely)).toBe(false);
    expect(ranked.find((c) => c.name === 'triton')?.hints).toContain('references');
  });

  it('does not call the base of Bole its own code', () => {
    const ranked = rankRepoCandidates({
      title: 'Bole: Efficient Tree Speculation for Hybrid-Attention Language Models',
      pages: ['Bole\nAbstract.', 'We implemented Bole on top of SGLang (https://github.com/sgl-project/sglang).'],
    });
    expect(names(ranked)).toEqual(['sgl-project/sglang']);
    expect(ranked[0].likely).toBe(false);
    expect(ranked[0].hints).toContain('dependency');
  });

  it('finds Nemotron among many links, including ones only in annotations', () => {
    const ranked = rankRepoCandidates({
      title: 'Nemotron 3 Ultra: Open, Efficient Mixture-of-Experts Hybrid Mamba-Transformer',
      pages: ['Abstract', 'Data\n1https://github.com/NVIDIA-NeMo/Nemotron\n2', ...Array(8).fill('Body text.')],
      links: [
        { url: 'https://github.com/NVIDIA-NeMo/Evaluator', page: 9, context: 'evaluated with' },
        { url: 'https://github.com/NVIDIA-NeMo/Gym', page: 9 },
        { url: 'https://github.com/harbor-framework/harbor', page: 9 },
        { url: 'https://github.com/NVIDIA/Model-Optimizer', page: 9 },
        { url: 'https://github.com/EleutherAI/lm-evaluation-harness', page: 9 },
        { url: 'https://github.com/NVIDIA-NeMo/Skills', page: 9 },
        { url: 'https://github.com/NVIDIA/Megatron-LM', page: 9 },
        { url: 'https://github.com/NVIDIA/TensorRT-LLM', page: 9 },
        { url: 'https://github.com/pinchbench/skill', page: 9 },
        { url: 'https://github.com/NVIDIA-NeMo/DataDesigner', page: 9 },
      ],
    });
    expect(names(ranked)[0]).toBe('NVIDIA-NeMo/Nemotron');
    expect(ranked).toHaveLength(11);
  });

  it('reads a link hidden behind text, using the words around it', () => {
    const ranked = rankRepoCandidates({
      title: 'A Study of Things',
      pages: ['Our code is here.'],
      links: [{ url: 'https://github.com/someone/thing-study', page: 1, context: 'Our code is available here.' }],
    });
    expect(names(ranked)).toEqual(['someone/thing-study']);
    expect(ranked[0].likely).toBe(true);
    expect(ranked[0].hints).toContain('context');
  });

  it('merges a name that lost its hyphen at a line break with the link that kept it', () => {
    const ranked = rankRepoCandidates({
      title: 'Something',
      pages: ['Using github.com/fla-org/flash-linearattention here.'],
      links: [{ url: 'https://github.com/fla-org/flash-linear-attention', page: 1 }],
    });
    expect(names(ranked)).toEqual(['fla-org/flash-linear-attention']);
  });

  it('marks down what only appears in the references, even with a matching name', () => {
    const ranked = rankRepoCandidates({
      title: 'Thing: A System',
      pages: ['Thing is good. We released it at github.com/a/early-code.', `${REFS}\ngithub.com/b/thing`],
    });
    expect(names(ranked)[0]).toBe('a/early-code');
    expect(ranked.find((c) => c.name === 'thing')?.likely).toBe(false);
  });

  it('counts a shared word in the title for little when it is a common one', () => {
    const ranked = rankRepoCandidates({ title: 'Linear Attention for Fast Serving', pages: ['See github.com/a/linear-attention here.', 'x', 'x'] });
    expect(ranked[0].likely).toBe(false);
  });

  it('handles a paper with no repositories', () => {
    expect(rankRepoCandidates({ title: 'Nothing', pages: ['No code at all.'] })).toEqual([]);
    expect(rankRepoCandidates({ title: '', pages: [] })).toEqual([]);
  });

  it('gives each candidate a URL that passes for linking', () => {
    const [candidate] = rankRepoCandidates({ title: 'X', pages: ['github.com/foo/bar.'] });
    expect(candidate.url).toBe('https://github.com/foo/bar');
  });
});
