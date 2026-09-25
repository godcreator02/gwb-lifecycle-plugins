// 打印一个 home 里几个包此刻的状态：清单里的写法、node_modules/<包> 的真实目录落在 .pnpm 下哪个目录、
// 从真实目录加载出来的 version 与 marker（本进程是新起的 node，没有模块缓存），
// 以及 peer 里写了别的 @probe 包的，从它的真实目录解析那个 peer 得到谁。最后列出 .pnpm 下所有 @probe 的目录。
// 用法：node inspect.cjs <home 目录> <包名…>
const fs = require('node:fs');
const path = require('node:path');

const [homeDir, ...pkgs] = process.argv.slice(2);
if (!homeDir || pkgs.length === 0) throw new Error('用法：node inspect.cjs <home 目录> <包名…>');
const virtualStore = path.join(homeDir, 'node_modules', '.pnpm');
const manifestDeps = JSON.parse(fs.readFileSync(path.join(homeDir, 'package.json'), 'utf8')).dependencies ?? {};

function virtualDirOf(realDir) {
  const rel = path.relative(virtualStore, realDir);
  return rel.startsWith('..') ? `（不在 .pnpm 下：${realDir}）` : rel.split(path.sep)[0];
}

function describe(realDir) {
  const loaded = require(realDir);
  return `.pnpm 目录=${virtualDirOf(realDir)}  version=${loaded.version}  marker=${loaded.marker}`;
}

for (const pkg of pkgs) {
  const linkPath = path.join(homeDir, 'node_modules', pkg);
  const spec = manifestDeps[pkg] ?? '（清单里没有）';
  let realDir;
  try { realDir = fs.realpathSync(linkPath); } catch (err) { if (err.code === 'ENOENT') { console.log(`${pkg}  清单=${spec}  node_modules 里没有`); continue; } throw err; }
  console.log(`${pkg}  清单=${spec}  ${describe(realDir)}`);
  const peers = JSON.parse(fs.readFileSync(path.join(realDir, 'package.json'), 'utf8')).peerDependencies ?? {};
  for (const peer of Object.keys(peers)) {
    let peerDir;
    try { peerDir = fs.realpathSync(path.dirname(require.resolve(`${peer}/package.json`, { paths: [realDir] }))); } catch (err) { console.log(`  peer ${peer}（${peers[peer]}）从它解析不到：${err.code}`); continue; }
    console.log(`  peer ${peer}（${peers[peer]}）从它解析到 ${describe(peerDir)}`);
  }
}
const probeDirs = fs.existsSync(virtualStore) ? fs.readdirSync(virtualStore).filter((d) => d.startsWith('@probe+')).sort() : [];
console.log(`.pnpm 下的 @probe 目录（${probeDirs.length} 个）：`);
for (const d of probeDirs) console.log(`  ${d}`);
