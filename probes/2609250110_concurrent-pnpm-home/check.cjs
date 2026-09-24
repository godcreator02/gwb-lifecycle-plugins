// 打印一个 home 此刻三处记录的是否一致：package.json 的 dependencies、pnpm-lock.yaml 的 importers、node_modules 里的直接依赖。
// 用法：node check.cjs <home 目录> <包名…>   输出一行 JSON
const fs = require('node:fs');
const path = require('node:path');

const [homeDir, ...pkgs] = process.argv.slice(2);
if (!homeDir || pkgs.length === 0) throw new Error('用法：node check.cjs <home 目录> <包名…>');

function readText(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch (err) { if (err.code === 'ENOENT') return undefined; throw err; }
}

const manifestText = readText(path.join(homeDir, 'package.json'));
let manifestDeps;
try { manifestDeps = JSON.parse(manifestText).dependencies ?? {}; } catch { manifestDeps = `package.json 解析不了：${JSON.stringify(manifestText)}`; }

// 锁文件只看根 importer（"  .:" 那一段）里列了哪些直接依赖：6 格缩进的「包名:」行
const lockText = readText(path.join(homeDir, 'pnpm-lock.yaml'));
const lockImporterDeps = [];
if (lockText !== undefined) {
  const importer = /\n  \.:\n([\s\S]*?)(?=\n\S|\n  \S|$)/.exec(lockText.replace(/\r\n/g, '\n'));
  if (importer) for (const m of importer[1].matchAll(/^      ('?[^\s:']+'?):$/gm)) lockImporterDeps.push(m[1].replace(/'/g, ''));
}

const report = { manifest: typeof manifestDeps === 'string' ? manifestDeps : Object.keys(manifestDeps).sort(), lock: lockText === undefined ? '没有锁文件' : lockImporterDeps.sort(), nodeModules: {} };
for (const pkg of pkgs) {
  const text = readText(path.join(homeDir, 'node_modules', pkg, 'package.json'));
  report.nodeModules[pkg] = text === undefined ? null : JSON.parse(text).version;
}
const inManifest = (pkg) => Array.isArray(report.manifest) && report.manifest.includes(pkg);
const inLock = (pkg) => Array.isArray(report.lock) && report.lock.includes(pkg);
report.consistent = pkgs.every((pkg) => inManifest(pkg) === inLock(pkg) && inLock(pkg) === (report.nodeModules[pkg] !== null));
console.log(JSON.stringify(report));
