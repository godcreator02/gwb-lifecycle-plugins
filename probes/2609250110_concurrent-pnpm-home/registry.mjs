// 零依赖的只读 npm 源：把 vendor 目录里 pnpm pack 出来的 tgz 当成已发布的版本对外提供。
// 回 packument 之前固定等 delayMs 毫秒，模拟真实源的网络延迟：pnpm add 读完 home 的 package.json 之后要等解析，
// 两个同时运行的 pnpm 的「读清单 → 写回清单」这段时间才会重叠。
//   GET /<name>                 → packument（等 delayMs）
//   GET /<name>/-/<file>.tgz    → tgz 本体（不等）
// 用法：node registry.mjs <vendor 目录> <src 目录> <写地址的文件> <delayMs>
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';

const [vendorDir, srcDir, urlFile, delayText] = process.argv.slice(2);
if (!vendorDir || !srcDir || !urlFile || !delayText) throw new Error('用法：node registry.mjs <vendor 目录> <src 目录> <写地址的文件> <delayMs>');
const delayMs = Number(delayText);
if (!Number.isInteger(delayMs) || delayMs < 0) throw new Error(`delayMs 要是非负整数，收到 ${delayText}`);

const tarballPattern = /^(.+)-(\d+\.\d+\.\d+)\.tgz$/;
// pnpm 有发布时间门槛时要看 time 字段；写成很早的固定时间，让门槛不影响这次实验
const publishedAt = '2020-01-01T00:00:00.000Z';

function buildPackuments(baseUrl) {
  const packuments = new Map();
  for (const file of readdirSync(vendorDir)) {
    const match = tarballPattern.exec(file);
    if (!match) throw new Error(`vendor 里有认不出的文件：${file}`);
    const [, name, version] = match;
    const bytes = readFileSync(join(vendorDir, file));
    const manifest = JSON.parse(readFileSync(join(srcDir, `${name}-${version}`, 'package.json'), 'utf8'));
    const packument = packuments.get(name) ?? { name, 'dist-tags': {}, versions: {}, time: {} };
    packument.versions[version] = {
      ...manifest,
      dist: {
        tarball: `${baseUrl}/${name}/-/${file}`,
        shasum: createHash('sha1').update(bytes).digest('hex'),
        integrity: 'sha512-' + createHash('sha512').update(bytes).digest('base64'),
      },
    };
    packument.time[version] = publishedAt;
    packuments.set(name, packument);
  }
  for (const packument of packuments.values()) {
    const versions = Object.keys(packument.versions).sort((x, y) => x.localeCompare(y, 'en', { numeric: true }));
    packument['dist-tags'].latest = versions.at(-1);
    packument.time.created = publishedAt;
    packument.time.modified = publishedAt;
  }
  return packuments;
}

let packuments;
const server = createServer((request, response) => {
  const url = decodeURIComponent(new URL(request.url, 'http://x').pathname);
  const tarballMatch = /^\/([^/]+)\/-\/([^/]+\.tgz)$/.exec(url);
  if (tarballMatch) {
    try {
      const bytes = readFileSync(join(vendorDir, tarballMatch[2]));
      response.writeHead(200, { 'content-type': 'application/octet-stream' }).end(bytes);
    } catch {
      response.writeHead(404).end();
    }
    return;
  }
  const packument = packuments.get(url.slice(1));
  setTimeout(() => {
    if (!packument) { response.writeHead(404, { 'content-type': 'application/json' }).end('{"error":"not found"}'); return; }
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(packument));
  }, delayMs);
});

server.listen(0, '127.0.0.1', () => {
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  packuments = buildPackuments(baseUrl);
  writeFileSync(urlFile, baseUrl);
});
