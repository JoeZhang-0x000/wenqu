import { describe, expect, it, vi } from 'vitest';

// Sanitizing needs a browser, and what it does is checked in the app. This is what goes into it.
vi.mock('dompurify', () => ({ default: { addHook: () => {}, sanitize: (html: string) => html } }));

const { renderMarkdown } = await import('../web/src/Markdown');

const SHA = 'a'.repeat(40);
const repo = { owner: 'foo', name: 'bar', sha: SHA };
const base = `https://github.com/foo/bar/blob/${SHA}`;

describe('rendering code citations', () => {
  it('links to the lines at the recorded commit, in a new tab', () => {
    const html = renderMarkdown('See [code:src/model.py:10-20].', undefined, repo);
    expect(html).toContain(`<a class="code-cite" href="${base}/src/model.py#L10-L20" target="_blank" rel="noopener noreferrer">src/model.py:10-20</a>`);
  });

  it('keeps underscores from becoming emphasis', () => {
    const html = renderMarkdown('[code:a_b_c/d_e_f.py:1] and [code:g_h_i.py:2]', undefined, repo);
    expect(html).toContain('a_b_c/d_e_f.py:1</a>');
    expect(html).toContain('g_h_i.py:2</a>');
    expect(html).not.toContain('<em>');
  });

  it('encodes the path in the link and escapes it in the label', () => {
    const html = renderMarkdown('[code:a b/c"<img src=x>.py:3]', undefined, repo);
    expect(html).toContain(`${base}/a%20b/c%22%3Cimg%20src%3Dx%3E.py#L3`);
    expect(html).toContain('a b/c&quot;&lt;img src=x&gt;.py:3</a>');
    expect(html).not.toContain('<img');
  });

  it('points old answers at their own commit', () => {
    const other = { ...repo, sha: 'b'.repeat(40) };
    expect(renderMarkdown('[code:a.py:1]', undefined, other)).toContain(`/blob/${'b'.repeat(40)}/a.py#L1`);
  });

  it.each(['[code:../../etc/passwd:1]', '[code:-x:1]', '[code:a.py:20-10]', '[code:]'])('renders %s as plain text', (text) => {
    const html = renderMarkdown(text, undefined, repo);
    expect(html).not.toContain('<a ');
    expect(html).toContain('[code:');
  });

  it('renders every citation as plain text without a repository', () => {
    const html = renderMarkdown('[code:a.py:1]');
    expect(html).not.toContain('<a ');
    expect(html).toContain('[code:a.py:1]');
  });

  it('refuses a recorded repository that was edited into something else', () => {
    const html = renderMarkdown('[code:a.py:1]', undefined, { owner: 'javascript:alert(1)//', name: 'x', sha: SHA });
    expect(html).not.toContain('<a ');
    expect(renderMarkdown('[code:a.py:1]', undefined, { ...repo, sha: 'HEAD' })).not.toContain('<a ');
  });

  it('leaves code alone, apart from a citation a model wrapped in backticks', () => {
    expect(renderMarkdown('`[code:a.py:1]`', undefined, repo)).toContain('class="code-cite"');
    expect(renderMarkdown('`x = [code:a.py:1]`', undefined, repo)).not.toContain('class="code-cite"');
    expect(renderMarkdown('```\n[code:a.py:1]\n```', undefined, repo)).not.toContain('class="code-cite"');
  });

  it('keeps page citations working alongside them', () => {
    const html = renderMarkdown('[p.3] and [code:a.py:1]', undefined, repo);
    expect(html).toContain('data-page="3"');
    expect(html).toContain('class="code-cite"');
  });

  it('works inside tables and lists', () => {
    expect(renderMarkdown('| a |\n|---|\n| [code:a.py:1] |', undefined, repo)).toContain('class="code-cite"');
    expect(renderMarkdown('- [code:a.py:1]', undefined, repo)).toContain('class="code-cite"');
  });
});
