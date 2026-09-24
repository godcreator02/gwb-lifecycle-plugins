// 零依赖的只读 npm 源：把 vendor/ 里 pnpm pack 出来的 tgz 当成已发布的版本对外提供，
// 让 home 用版本号（而不是 file: 路径）安装。只实现 pnpm install 要用的两种请求：
//   GET /<name>                 → packument（versions 里放 work/src 下对应的 package.json + dist）
//   GET /<name>/-/<file>.tgz    → tgz 本体
// 用法：node registry.mjs <vendor 目录> <src 目录> <写端口号的文件>
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';

const [vendorDir, srcDir, portFile] = process.argv.slice(2);
if (!vendorDir || !srcDir || !portFile) throw new Error('用法：node registry.mjs <vendor 目录> <src 目录> <写端口号的文件>');

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
  if (!packument) { response.writeHead(404, { 'content-type': 'application/json' }).end('{"error":"not found"}'); return; }
  response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(packument));
});

server.listen(0, '127.0.0.1', () => {
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  packuments = buildPackuments(baseUrl);
  writeFileSync(portFile, baseUrl);
});
