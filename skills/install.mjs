#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile, copyFile, lstat } from 'node:fs/promises';
import { resolve, dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';

const here = dirname(fileURLToPath(import.meta.url));
const repository = resolve(here, '..');
const canonical = join(here, 'dsh-cost-contribute');
const runtime = join(canonical, 'scripts');
const skillName = 'dsh-cost-contribute';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const toPosix = value => value.split(sep).join('/');

function parseArgs(raw) {
  const parsed = {};
  for (let index = 0; index < raw.length; index += 1) {
    const flag = raw[index];
    if (['--check', '--write', '--sync', '--help'].includes(flag)) {
      if (parsed[flag]) throw new Error(`重复参数：${flag}`);
      parsed[flag] = true;
    } else if (['--target', '--skills-root'].includes(flag)) {
      if (parsed[flag] || !raw[index + 1] || raw[index + 1].startsWith('--')) throw new Error(`参数缺失或重复：${flag}`);
      parsed[flag] = raw[++index];
    } else throw new Error(`未知参数：${flag}`);
  }
  return parsed;
}

function assertInside(root, target) {
  const segment = relative(root, target);
  if (!segment || segment.startsWith(`..${sep}`) || segment === '..' || resolve(root, segment) !== target) {
    throw new Error('目标不在指定技能目录内。');
  }
}

async function filesUnder(root) {
  const files = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`技能分发目录不能包含符号链接：${toPosix(relative(root, path))}`);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) files.push(path);
    }
  }
  await visit(root);
  return files.sort();
}

async function runtimeSources() {
  const sources = [];
  for (const group of ['client', 'shared']) {
    const sourceRoot = join(repository, group);
    for (const source of await filesUnder(sourceRoot)) {
      if (!/\.(?:mjs|js|json)$/.test(source)) continue;
      sources.push({ source, destination: join(group, relative(sourceRoot, source)) });
    }
  }
  for (const required of ['client/dsh-cost-contribute.mjs', 'client/collect-dsh.mjs', 'shared/schema.json']) {
    if (!sources.some(item => toPosix(item.destination) === required)) throw new Error(`缺少技能运行文件：${required}`);
  }
  return sources;
}

async function expectedRuntime() {
  const sources = await runtimeSources();
  const hashes = {};
  for (const item of sources) hashes[toPosix(item.destination)] = digest(await readFile(item.source));
  return { sources, manifest: { format: 'dsh-skill-runtime-1', node: '>=22 <25', files: hashes } };
}

async function syncRuntime() {
  const { sources, manifest } = await expectedRuntime();
  for (const { source, destination } of sources) {
    const target = resolve(runtime, destination);
    assertInside(runtime, target);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(source, target);
  }
  await writeFile(join(runtime, 'package.json'), JSON.stringify({ private: true, type: 'module', engines: { node: '>=22 <25' } }, null, 2) + '\n', 'utf8');
  await writeFile(join(runtime, 'runtime-manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  await verifyRuntime();
  console.log(JSON.stringify({ ok: true, action: 'sync', source_files: sources.length, skill: canonical }, null, 2));
}

async function verifyRuntime() {
  const { manifest } = await expectedRuntime();
  const installedManifest = JSON.parse(await readFile(join(runtime, 'runtime-manifest.json'), 'utf8'));
  if (JSON.stringify(installedManifest) !== JSON.stringify(manifest)) throw new Error('技能运行快照落后于源码，请先运行 node skills/install.mjs --sync。');
  const actualFiles = [];
  for (const group of ['client', 'shared']) {
    for (const path of await filesUnder(join(runtime, group))) {
      actualFiles.push(toPosix(relative(runtime, path)));
    }
  }
  if (actualFiles.sort().join('\n') !== Object.keys(manifest.files).sort().join('\n')) throw new Error('技能运行快照含缺失或多余文件。');
  for (const [name, hash] of Object.entries(manifest.files)) {
    if (digest(await readFile(join(runtime, name))) !== hash) throw new Error(`技能运行文件与源码不一致：${name}`);
  }
  const pkg = JSON.parse(await readFile(join(runtime, 'package.json'), 'utf8'));
  if (pkg.type !== 'module' || pkg.engines?.node !== '>=22 <25') throw new Error('技能 Node 配置不完整。');
}

async function install(args) {
  const targetKind = args['--target'];
  if (!['codex', 'dsh'].includes(targetKind)) throw new Error('--target 必须是 codex 或 dsh。');
  if (args['--check'] && args['--write']) throw new Error('--check 与 --write 不能同时使用。');
  const environmentHome = targetKind === 'codex' ? process.env.CODEX_HOME : process.env.DSH_HOME;
  const defaultHome = join(homedir(), targetKind === 'codex' ? '.codex' : '.dsh');
  const skillsRoot = resolve(args['--skills-root'] || join(environmentHome || defaultHome, 'skills'));
  const destination = resolve(skillsRoot, skillName);
  assertInside(skillsRoot, destination);
  await verifyRuntime();
  const present = existsSync(destination);
  const mode = args['--write'] ? 'write' : 'check';
  if (mode === 'check') {
    console.log(JSON.stringify({ ok: true, action: 'check', target: targetKind, destination, exists: present, can_install: !present, runtime_matches_source: true }, null, 2));
    return;
  }
  if (present) throw new Error('同名技能目录已存在，未覆盖。请保留旧目录后选择新的安装位置或先人工处理。');
  if (existsSync(skillsRoot) && (await lstat(skillsRoot)).isSymbolicLink()) throw new Error('安装根目录是符号链接，请使用实际目录。');
  await mkdir(skillsRoot, { recursive: true });
  await mkdir(destination); // exclusive creation: concurrent install must fail
  for (const source of await filesUnder(canonical)) {
    const target = resolve(destination, relative(canonical, source));
    assertInside(destination, target);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(source, target);
  }
  await writeFile(join(destination, '_installation.json'), JSON.stringify({ format: 'dsh-skill-installation-1', installed_at: new Date().toISOString(), target: targetKind, destination, node: process.versions.node }, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
  console.log(JSON.stringify({ ok: true, action: 'installed', target: targetKind, destination, runtime_matches_source: true, session_loaded: false }, null, 2));
}

try {
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 22 || major >= 25) throw new Error('请使用 Node.js 22 或 24。');
  const args = parseArgs(process.argv.slice(2));
  if (args['--help']) {
    console.log('用法：\n  node skills/install.mjs --sync\n  node skills/install.mjs --target codex|dsh --check\n  node skills/install.mjs --target codex|dsh --write\n可选 --skills-root <技能根目录>。默认先检查，已存在同名目录时拒绝覆盖。');
  } else if (args['--sync']) {
    if (Object.keys(args).length !== 1) throw new Error('--sync 不能与安装参数混用。');
    await syncRuntime();
  } else await install(args);
} catch (error) {
  console.error(JSON.stringify({ ok: false, error: error.message }));
  process.exitCode = 1;
}
