#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { getLocale, setLocale, t, type Locale } from '../shared/i18n.js';
import { importArxiv, parseArxivInput } from './arxiv.js';
import { Config } from './config.js';
import { createApp, listen } from './server.js';
import { Vault } from './vault.js';

const HELP = {
  en: `Paper2Podcast: a local paper library that generates blog posts and podcasts

Usage
  paper2podcast [start] [options]     Start the server and open a browser
  paper2podcast add <file.pdf|arXiv link or ID...>
                                      Import papers into the vault

Options
  --vault <dir>    Vault folder for this run
  --port <n>       Port (default 4317, moves up if taken)
  --no-open        Don't open a browser
  -h, --help       Show help
  -v, --version    Show version
`,
  zh: `Paper2Podcast: 本地论文库、博客与播客生成

用法
  paper2podcast [start] [选项]        启动服务并打开浏览器
  paper2podcast add <file.pdf|arXiv链接或编号...>
                                      把论文导入 Vault

选项
  --vault <dir>    本次运行使用的 Vault 目录
  --port <n>       端口（默认 4317，被占用时自动顺延）
  --no-open        不自动打开浏览器
  -h, --help       显示帮助
  -v, --version    显示版本
`,
};
const help = () => HELP[getLocale()];

/** Follows the terminal's language, as most command-line tools do. */
function systemLocale(): Locale {
  const lang = process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG || '';
  return lang.toLowerCase().startsWith('zh') ? 'zh' : 'en';
}

function openBrowser(url: string): void {
  const [command, args] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '', url]]
        : ['xdg-open', [url]];
  spawn(command as string, args as string[], { stdio: 'ignore', detached: true })
    .on('error', () => console.log(t('请在浏览器中打开 {url}', { url })))
    .unref();
}

setLocale(systemLocale());

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      vault: { type: 'string' },
      port: { type: 'string' },
      'no-open': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
      version: { type: 'boolean', short: 'v', default: false },
    },
  });
  if (values.help) {
    console.log(help());
    return;
  }
  if (values.version) {
    console.log(process.env.P2P_VERSION ?? 'dev');
    return;
  }

  const [command = 'start', ...rest] = positionals;
  const config = new Config(values.vault);
  const { uiLanguage } = config.get();
  if (uiLanguage !== 'auto') setLocale(uiLanguage);

  if (command === 'add') {
    if (!rest.length) throw new Error(t('请提供至少一个 PDF 路径或 arXiv 链接'));
    const vault = new Vault(config.get().vaultPath);
    for (const file of rest) {
      if (!existsSync(file) && !parseArxivInput(file)) throw new Error(t('找不到文件 {file}，它也不是有效的 arXiv 链接或编号', { file }));
      const { meta, duplicate } = existsSync(file)
        ? await vault.importPdf(readFileSync(resolve(file)), basename(file))
        : await importArxiv(vault, file);
      console.log(`${duplicate ? t('已存在') : t('已导入')}  ${meta.title}  (${t('{count} 页', { count: meta.pages })})`);
    }
    return;
  }
  if (command !== 'start') throw new Error(`${t('未知命令：{command}', { command })}\n\n${help()}`);

  const port = Number(values.port ?? 4317);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(t('无效的端口：{port}', { port: String(values.port) }));

  const { app } = createApp({ config, devOrigin: process.env.P2P_DEV_ORIGIN });
  const { port: actual } = await listen(app, port);
  const url = `http://127.0.0.1:${actual}`;
  console.log(t('\n  Paper2Podcast 已启动\n\n  地址   {url}\n  Vault  {vault}\n\n  按 Ctrl+C 退出\n', { url, vault: config.get().vaultPath }));
  if (!values['no-open']) openBrowser(url);
}

main().catch((err: Error) => {
  console.error(t('错误：{error}', { error: err.message }));
  process.exit(1);
});
