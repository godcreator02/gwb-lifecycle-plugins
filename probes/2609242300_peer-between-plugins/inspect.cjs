// 用法：node inspect.cjs <home 目录>
// 打印 home 里 probe-a / probe-b / probe-c 三个包的真实路径、.pnpm 目录清单、probe-a 同级的 node_modules，
// 以及从 probe-a 的真实路径出发 require.resolve('probe-b') 解析到哪一份、版本号是多少。
const fs = require('fs');
const path = require('path');

const home = path.resolve(process.argv[2]);
const rel = (p) => path.relative(home, p).split(path.sep).join('/');
const packageNames = ['probe-a', 'probe-b', 'probe-c'];

console.log('package.json dependencies: ' + JSON.stringify(JSON.parse(fs.readFileSync(path.join(home, 'package.json'), 'utf8')).dependencies));

for (const name of packageNames) {
  const link = path.join(home, 'node_modules', name);
  if (!fs.existsSync(link)) { console.log(`node_modules/${name}: 不存在`); continue; }
  const real = fs.realpathSync(link);
  const version = JSON.parse(fs.readFileSync(path.join(real, 'package.json'), 'utf8')).version;
  console.log(`node_modules/${name} -> ${rel(real)}  (version ${version})`);
}

const virtualStore = path.join(home, 'node_modules', '.pnpm');
if (!fs.existsSync(virtualStore)) {
  console.log('node_modules/.pnpm：不存在');
  process.exit(0);
}
console.log('node_modules/.pnpm 目录：');
for (const entry of fs.readdirSync(virtualStore, { withFileTypes: true })) {
  if (entry.isDirectory() && entry.name !== 'node_modules') console.log('  ' + entry.name);
}
const hiddenHoisted = path.join(virtualStore, 'node_modules');
const hiddenHoistedNames = fs.existsSync(hiddenHoisted) ? fs.readdirSync(hiddenHoisted) : [];
console.log(`node_modules/.pnpm/node_modules（隐藏提升）：${hiddenHoistedNames.join(', ') || '（空）'}`);

const aLink = path.join(home, 'node_modules', 'probe-a');
if (fs.existsSync(aLink)) {
  const aReal = fs.realpathSync(aLink);
  const aSiblings = path.dirname(aReal);
  console.log(`probe-a 同级（${rel(aSiblings)}）：`);
  for (const entry of fs.readdirSync(aSiblings)) {
    if (entry === 'probe-a') continue;
    console.log(`  ${entry} -> ${rel(fs.realpathSync(path.join(aSiblings, entry)))}`);
  }
  try {
    const resolved = require.resolve('probe-b/package.json', { paths: [aReal] });
    const version = JSON.parse(fs.readFileSync(resolved, 'utf8')).version;
    console.log(`从 probe-a 解析 probe-b：${rel(resolved)} -> 真实路径 ${rel(fs.realpathSync(resolved))}  (version ${version})`);
  } catch (error) {
    console.log(`从 probe-a 解析 probe-b：失败 ${error.code}`);
  }
}
