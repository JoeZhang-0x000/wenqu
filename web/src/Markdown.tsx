import DOMPurify from 'dompurify';
import { t } from '../../src/shared/i18n';
import katex from 'katex';
import { marked } from 'marked';
import { memo, useMemo } from 'react';

const CODE = /(```[\s\S]*?(?:```|$)|`[^`\n]*`)/g;
const BLOCK_MATH = /\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]/g;
const INLINE_MATH = /(?<![\\$\w])\$(?!\s)([^$\n]+?)(?<!\s)\$(?![\d$])|\\\(([^\n]+?)\\\)/g;
const CITE = /\[(?:(\d+)\s*[:：]\s*)?p\.?\s*(\d+)((?:\s*[-–,，]\s*\d+)*)\]/gi;
const VAULT_FIGURE = /!\[([^\]]*)\]\((?:\.\.\/)+(?:papers\/([a-z0-9-]+)\/)?figures\/([\w-]+\.png)\)/g;

// Agents read untrusted PDFs. A remote image would let injected text send data out as
// soon as a post renders, so only the app's own images load.
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'IMG' && !node.getAttribute('src')?.startsWith('/api/')) node.removeAttribute('src');
});

const escapeHtml = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function renderMarkdown(source: string, ownerId?: string): string {
  const stashed: string[] = [];
  const hold = (html: string) => {
    stashed.push(html);
    return `WENQUHOLD${stashed.length - 1}X`;
  };
  const stash = (tex: string, displayMode: boolean) =>
    hold(katex.renderToString(tex.trim(), { displayMode, throwOnError: false, output: 'htmlAndMathml' }));
  const figure = (alt: string, paperId: string | undefined, file: string) => {
    const text = escapeHtml(alt);
    return hold(
      `<span class="fig"><img src="/api/papers/${paperId ?? ownerId}/figures/${file}" alt="${text}" loading="lazy" /><span class="fig-cap">${text}</span></span>`,
    );
  };
  // Figures and math are pulled out first, so Markdown doesn't mangle what's inside them.
  const prepared = source
    .split(CODE)
    .map((part, i) =>
      i % 2 === 1
        ? part
        : part
            .replace(VAULT_FIGURE, (_, alt, paperId, file) => figure(alt, paperId, file))
            .replace(BLOCK_MATH, (_, a, b) => `\n\n${stash(a ?? b, true)}\n\n`)
            .replace(INLINE_MATH, (_, a, b) => stash(a ?? b, false))
            .replace(
              CITE,
              (_, ref, page, rest) =>
                `<a class="cite" href="#" data-page="${page}"${ref ? ` data-ref="${ref}"` : ''}>${ref ? `${ref}·` : ''}p.${page}${rest.replace(/\s+/g, '')}</a>`,
            ),
    )
    .join('');
  const html = (marked.parse(prepared, { async: false, gfm: true, breaks: false }) as string).replace(
    /WENQUHOLD(\d+)X/g,
    (_, i) => stashed[Number(i)],
  );
  // Output comes from an agent that read an untrusted PDF, so it is never trusted as HTML.
  return DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true, mathMl: true, svg: true },
    ADD_ATTR: ['data-page', 'target'],
  });
}

export const Markdown = memo(function Markdown({
  source,
  onCite,
  className = '',
  ownerId,
}: {
  source: string;
  /** `ref` is the paper number in a collection's citation, such as 2 in [2:p.5]. */
  onCite?: (page: number, ref?: number) => void;
  className?: string;
  /** The paper or collection this text belongs to, for resolving its figures. */
  ownerId?: string;
}) {
  const html = useMemo(() => renderMarkdown(source, ownerId), [source, ownerId]);
  return (
    <div
      className={`prose ${className}`}
      dangerouslySetInnerHTML={{ __html: html }}
      onClick={(e) => {
        const target = e.target as HTMLElement;
        const cite = target.closest('a.cite') as HTMLElement | null;
        if (cite) {
          e.preventDefault();
          onCite?.(Number(cite.dataset.page), cite.dataset.ref ? Number(cite.dataset.ref) : undefined);
          return;
        }
        const link = target.closest('a') as HTMLAnchorElement | null;
        if (link?.href && !link.classList.contains('cite')) {
          e.preventDefault();
          window.open(link.href, '_blank', 'noopener');
        }
      }}
    />
  );
});
