// 零依赖的只读 npm 源：按 run.ps1 写的索引文件，把 pnpm pack 出来的 tgz 当成已发布的版本对外提供。
// 支持带作用域的包名（pnpm 请求 /@probe%2fa，解码后是 /@probe/a）。
//   GET /<name>                 → packument
//   GET /<name>/-/<file>.tgz    → tgz 本体
// 用法：node registry.mjs <索引 JSON> <写地址的文件>
// 索引是数组，每项 { name, version, tarball: tgz 的绝对路径, manifest: 包的 package.json 内容 }
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { basename } from 'node:path';

const [indexFile, urlFile] = process.argv.slice(2);
if (!indexFile || !urlFile) throw new Error('用法：node registry.mjs <索引 JSON> <写地址的文件>');

// pnpm 有发布时间门槛时要看 time 字段；写成很早的固定时间，让门槛不影响这次实验
const publishedAt = '2020-01-01T00:00:00.000Z';

function buildPackuments(baseUrl) {
  const packuments = new Map();
  const tarballs = new Map();
  for (const entry of JSON.parse(readFileSync(indexFile, 'utf8'))) {
    const bytes = readFileSync(entry.tarball);
    const file = basename(entry.tarball);
    tarballs.set(file, bytes);
    const packument = packuments.get(entry.name) ?? { name: entry.name, 'dist-tags': {}, versions: {}, time: {} };
    packument.versions[entry.version] = {
      ...entry.manifest,
      dist: {
        tarball: `${baseUrl}/${entry.name}/-/${file}`,
        shasum: createHash('sha1').update(bytes).digest('hex'),
        integrity: 'sha512-' + createHash('sha512').update(bytes).digest('base64'),
      },
    };
    packument.time[entry.version] = publishedAt;
    packuments.set(entry.name, packument);
  }
  for (const packument of packuments.values()) {
    const versions = Object.keys(packument.versions).sort((x, y) => x.localeCompare(y, 'en', { numeric: true }));
    packument['dist-tags'].latest = versions.at(-1);
    packument.time.created = publishedAt;
    packument.time.modified = publishedAt;
  }
  return { packuments, tarballs };
}

let served;
const server = createServer((request, response) => {
  const url = decodeURIComponent(new URL(request.url, 'http://x').pathname);
  const tarballMatch = /^\/(.+)\/-\/([^/]+\.tgz)$/.exec(url);
  if (tarballMatch) {
    const bytes = served.tarballs.get(tarballMatch[2]);
    if (!bytes) { response.writeHead(404).end(); return; }
    response.writeHead(200, { 'content-type': 'application/octet-stream' }).end(bytes);
    return;
  }
  const packument = served.packuments.get(url.slice(1));
  if (!packument) { response.writeHead(404, { 'content-type': 'application/json' }).end('{"error":"not found"}'); return; }
  response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(packument));
});

server.listen(0, '127.0.0.1', () => {
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  served = buildPackuments(baseUrl);
  writeFileSync(urlFile, baseUrl);
});
