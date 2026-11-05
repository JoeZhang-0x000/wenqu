import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import * as nodeModule from 'node:module';
import { describe, expect, it } from 'vitest';

const root = join(__dirname, '..');

/** Makes the optional package unresolvable, which is how a machine without it looks to pdf.js. */
const withoutCanvas = `
  import { registerHooks } from 'node:module';
  registerHooks({
    resolve(specifier, context, next) {
      if (specifier.startsWith('@napi-rs/canvas')) throw Object.assign(new Error('not installed'), { code: 'MODULE_NOT_FOUND' });
      return next(specifier, context);
    },
  });
`;

const script = `
  import { readFileSync } from 'node:fs';
  import { locateFirstFigurePage } from ${JSON.stringify(join(root, 'src/server/cover.ts'))};
  import { figuresSupported } from ${JSON.stringify(join(root, 'src/server/figures.ts'))};
  import { extractPdf } from ${JSON.stringify(join(root, 'src/server/pdf.ts'))};
  const read = (name) => new Uint8Array(readFileSync(${JSON.stringify(join(root, 'tests/fixtures'))} + '/' + name));
  console.log(JSON.stringify({
    supported: await figuresSupported(),
    page: await locateFirstFigurePage(read('figures.pdf')),
    title: (await extractPdf(read('cpn.pdf'))).title,
  }));
`;

// `registerHooks` arrived in Node 22.15, and the behaviour under test doesn't depend on the Node version.
describe.runIf('registerHooks' in nodeModule)('without @napi-rs/canvas', () => {
  it('still reads PDFs and locates figures', async () => {
    const { stdout } = await promisify(execFile)(
      process.execPath,
      ['--import', 'tsx', '--import', `data:text/javascript,${encodeURIComponent(withoutCanvas)}`, '--input-type=module', '-e', script],
      { cwd: root },
    );
    const result = JSON.parse(stdout.trim().split('\n').pop()!);
    expect(result).toEqual({ supported: false, page: 1, title: 'Cascade Pruning Networks: Learning When to Stop Re-ranking' });
  }, 30_000);
});
