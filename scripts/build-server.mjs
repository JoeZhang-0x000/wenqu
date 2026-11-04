import { chmodSync, readFileSync } from 'node:fs';
import { build } from 'esbuild';

const { version, dependencies, optionalDependencies } = JSON.parse(readFileSync('package.json', 'utf8'));

await build({
  entryPoints: ['src/server/cli.ts'],
  outfile: 'dist/cli.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  external: [...Object.keys(dependencies), ...Object.keys(optionalDependencies)],
  define: { 'process.env.WENQU_VERSION': JSON.stringify(version) },
});
chmodSync('dist/cli.js', 0o755);
