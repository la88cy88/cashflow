/**
 * 静态质量与安全校验：node tools/verify.mjs
 * 覆盖：语法、DOM 引用完整性、PWA 资源完整性、外部依赖、敏感信息泄露。
 * 不联网、不依赖任何第三方包。
 */

import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const problems = [];
let passed = 0;

function check(condition, message) {
  if (condition) passed += 1;
  else problems.push(message);
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

const TEXT_EXT = new Set([
  '.html', '.css', '.js', '.mjs', '.json', '.webmanifest', '.md',
  '.yml', '.yaml', '.svg', '.py', '.gitignore', '.txt'
]);

async function collect(dir, out = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (['.git', 'node_modules', '.workbuddy', '.DS_Store', '_site', 'tmp'].includes(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) await collect(path, out);
    else if (entry.isFile()) out.push(path);
  }
  return out;
}

const files = await collect(ROOT);
const textFiles = files.filter((f) => {
  const name = f.slice(f.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return TEXT_EXT.has(dot === -1 ? '' : name.slice(dot)) || name === '.gitignore';
});

/* 1. 敏感信息扫描 —— 凭据绝不允许进入仓库 */
const SENSITIVE = [
  { name: 'GitHub classic token', re: /gh[pousr]_[A-Za-z0-9]{20,}/ },
  { name: 'GitHub fine-grained token', re: /github_pat_[A-Za-z0-9_]{20,}/ },
  { name: 'AWS access key', re: /AKIA[0-9A-Z]{16}/ },
  { name: 'private key block', re: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { name: 'Slack token', re: /xox[baprs]-[A-Za-z0-9-]{10,}/ },
  { name: 'hardcoded credential', re: /(?:password|passwd|api[_-]?key|secret)\s*[:=]\s*['"][^'"]{8,}['"]/i }
];

for (const file of textFiles) {
  const content = await readFile(file, 'utf8');
  for (const rule of SENSITIVE) {
    check(!rule.re.test(content), `${file.replace(ROOT, '')} 疑似包含 ${rule.name}`);
  }
}
console.log(`✓ 敏感信息扫描：${textFiles.length} 个文本文件，6 类凭据模式`);

/* 2. 无外部网络依赖：只检查真正的资源引用（src/href 属性、CSS url()）。
      变量赋值里的导航地址（如 PWA_URL）不算资源依赖，不在此列。 */
const EXTERNAL = /(?:src|href)\s*=\s*['"]?https?:\/\/[^'")\s]+|url\(\s*['"]?https?:\/\/[^'")\s]+/gi;
for (const file of textFiles) {
  if (file.endsWith('README.md') || file.includes('/tests/') || file.includes('/tools/')) continue;
  const content = await readFile(file, 'utf8');
  const hits = [...content.matchAll(EXTERNAL)].map((m) => m[0]);
  check(hits.length === 0, `${file.replace(ROOT, '')} 引用了外部地址：${hits.join(', ')}`);
}
console.log('✓ 运行时资源全部本地化（无 CDN / 无外链）');

/* 3. JS 语法 */
const jsFiles = files.filter((f) => /\.(js|mjs)$/.test(f));
for (const file of jsFiles) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
    passed += 1;
  } catch (error) {
    problems.push(`${file.replace(ROOT, '')} 语法错误：${String(error.stderr || error.message).slice(0, 160)}`);
  }
}
console.log(`✓ JS 语法检查：${jsFiles.length} 个文件`);

/* 4. DOM id 与 SVG symbol 引用完整性 */
const html = await readFile(join(ROOT, 'index.html'), 'utf8');
const declaredIds = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));

const referencedIds = new Set();
for (const name of ['app.js', 'ui.js', 'number.js', 'effects.js']) {
  const src = await readFile(join(ROOT, 'js', name), 'utf8');
  for (const m of src.matchAll(/(?:\$|getElementById)\(\s*'([^']+)'\s*\)/g)) referencedIds.add(m[1]);
}
for (const id of referencedIds) check(declaredIds.has(id), `JS 引用了不存在的 DOM id: #${id}`);

const usedSymbols = new Set([...html.matchAll(/<use href="#(i-[^"]+)"/g)].map((m) => m[1]));
for (const symbol of usedSymbols) check(declaredIds.has(symbol), `引用了不存在的 SVG symbol: #${symbol}`);
console.log(`✓ DOM 引用完整性：${referencedIds.size} 个 id / ${usedSymbols.size} 个图标`);

/* 4b. ui.els 属性引用完整性（防止引用 undefined 打断事件绑定） */
const uiSrc = await readFile(join(ROOT, 'js', 'ui.js'), 'utf8');
const appSrc = await readFile(join(ROOT, 'js', 'app.js'), 'utf8');
const elsBlock = uiSrc.slice(uiSrc.indexOf('const els = {'), uiSrc.indexOf('const amount ='));
const elsKeys = new Set([...elsBlock.matchAll(/^\s*([A-Za-z_$][\w$]*):/gm)].map((m) => m[1]));
for (const src of [uiSrc, appSrc]) {
  for (const m of src.matchAll(/\bels\.([A-Za-z_$][\w$]*)/g)) {
    check(elsKeys.has(m[1]), `ui.els 中不存在属性：els.${m[1]}`);
  }
}
console.log(`✓ ui.els 属性完整性：${elsKeys.size} 个键`);

/* 5. Service Worker 预缓存清单与 manifest 图标都存在 */
const sw = await readFile(join(ROOT, 'sw.js'), 'utf8');
const shell = [...sw.matchAll(/'(\.\/[^']+)'/g)].map((m) => m[1]);
for (const entry of new Set(shell)) {
  const target = join(ROOT, entry === './' ? 'index.html' : entry.slice(2));
  check(await exists(target), `Service Worker 预缓存资源缺失：${entry}`);
}
const manifest = JSON.parse(await readFile(join(ROOT, 'manifest.webmanifest'), 'utf8'));
for (const icon of manifest.icons) {
  check(await exists(join(ROOT, icon.src)), `manifest 图标缺失：${icon.src}`);
}
check(await exists(join(ROOT, 'icons/apple-touch-icon.png')), 'iOS 主屏图标缺失');
console.log(`✓ PWA 资源完整性：${new Set(shell).size} 项预缓存 / ${manifest.icons.length} 个清单图标`);

/* 6. HTML 中引用的 css / js / 图标文件都存在 */
for (const m of html.matchAll(/(?:href|src)="(\.\/[^"]+)"/g)) {
  const path = m[1];
  if (path.startsWith('#')) continue;
  check(await exists(join(ROOT, path.slice(2))), `HTML 引用缺失：${path}`);
}

/* 7. 关键计算约束的代码级检查 */
const engine = await readFile(join(ROOT, 'js/engine.js'), 'utf8');
check(/Date\.now\(\)/.test(engine), '引擎必须基于 Date.now()');
check(!/(?:setInterval|setTimeout)\s*\(/.test(engine), '引擎内部不得使用定时器');
check(/Math\.min\(salary, earned\)/.test(engine), '金额必须有上限 clamp');
const app = await readFile(join(ROOT, 'js/app.js'), 'utf8');
check(/requestAnimationFrame/.test(app), '主循环必须使用 requestAnimationFrame');
check(/visibilitychange/.test(app) && /pageshow/.test(app), '必须监听前后台恢复事件');
console.log('✓ 计算约束：真实时间源 / rAF / 后台恢复 / 金额上限');

/* 8. 小组件引导页的 DOM 引用与本地资源 */
const widgetHtml = await readFile(join(ROOT, 'widget.html'), 'utf8');
const widgetIds = new Set([...widgetHtml.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
const widgetPageJs = await readFile(join(ROOT, 'js', 'widget-page.js'), 'utf8');
const widgetRefs = new Set(
  [...widgetPageJs.matchAll(/(?:\$|getElementById)\(\s*'([^']+)'\s*\)/g)].map((m) => m[1])
);
for (const id of widgetRefs) {
  check(widgetIds.has(id), `widget-page.js 引用了不存在的 DOM id: #${id}`);
}
for (const page of ['index.html', 'widget.html']) {
  const src = await readFile(join(ROOT, page), 'utf8');
  for (const m of src.matchAll(/(?:href|src)="(\.\/[^"]+)"/g)) {
    check(await exists(join(ROOT, m[1].slice(2))), `${page} 引用缺失：${m[1]}`);
  }
}
check(await exists(join(ROOT, 'widget', 'CashflowWidget.js')), 'Scriptable 小组件脚本缺失');
console.log(`✓ 小组件页面：${widgetRefs.size} 个 id / 两个页面的本地资源`);

/* ---------- 汇总 ---------- */
console.log('');
if (problems.length) {
  console.error(`✖ 校验失败：${passed} 项通过，${problems.length} 项问题`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(`✅ 全部通过：${passed} 项检查，0 项问题`);
