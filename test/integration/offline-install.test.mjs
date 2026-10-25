/**
 * End-to-end integration check for the artifact format, without DSH:
 *
 *   synthetic hoisted install tree -> closure -> staged bundled package -> .tgz
 *   -> `pnpm add --offline` into a fresh hoisted project -> the plugin and its
 *      transitively bundled dependencies resolve and execute.
 *
 * Requires `pnpm` on PATH; skipped otherwise. No registry access is allowed: the
 * bogus `--registry` plus `--offline` make any attempted fetch a failure.
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import { collectDependencyClosure, stageBundledPackage } from '../../src/closure.mjs';
import { packDirectoryToTarGz } from '../../src/tar.mjs';

const execFileAsync = promisify(execFile);

/** Whether pnpm is available for the offline install step. */
async function pnpmAvailable() {
  try {
    await execFileAsync('pnpm', ['--version']);
    return true;
  } catch {
    return false;
  }
}

/**
 * Write one synthetic package directory.
 * @param dir - package root.
 * @param manifest - package.json contents.
 * @param files - additional relative path -> text content entries.
 */
async function writePackage(dir, manifest, files = {}) {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'package.json'), `${JSON.stringify(manifest, undefined, 2)}\n`, 'utf8');
  for (const [name, content] of Object.entries(files)) {
    const target = join(dir, name);
    await mkdir(join(target, '..'), { recursive: true });
    await writeFile(target, content, 'utf8');
  }
}

const PNPM_AVAILABLE = await pnpmAvailable();

test('bundled artifact installs offline and resolves its nested dependencies', { skip: !PNPM_AVAILABLE, timeout: 180_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-offline-it-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  // 1. A hoisted install tree: the plugin and both dependencies as siblings.
  const source = join(root, 'source');
  const pluginDir = join(source, 'node_modules', 'offline-it-plugin');
  const depA = join(source, 'node_modules', 'dep-a');
  const depB = join(source, 'node_modules', 'dep-b');
  await writePackage(pluginDir, {
    name: 'offline-it-plugin',
    version: '1.0.0',
    type: 'module',
    main: 'index.js',
    exports: { '.': './index.js', './package.json': './package.json' },
    dependencies: { 'dep-a': '^1.0.0' },
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  }, {
    'index.js': 'import { value as a } from "dep-a";\nexport const combined = `plugin+${a}`;\nexport const name = "offline-it-plugin";\n',
    'cordis.patch.yml': "- insert:\n    - id: offline-it\n      name: 'offline-it-plugin'\n",
  });
  await writePackage(depA, {
    name: 'dep-a',
    version: '1.2.0',
    type: 'module',
    main: 'index.js',
    dependencies: { 'dep-b': '^2.0.0' },
  }, {
    'index.js': 'import { value as b } from "dep-b";\nexport const value = `a1:+${b}`;\n',
  });
  await writePackage(depB, {
    name: 'dep-b',
    version: '2.3.0',
    type: 'module',
    main: 'index.js',
  }, {
    'index.js': 'export const value = "b2";\n',
  });

  // 2. Closure + staging + packing.
  const closure = await collectDependencyClosure({ rootPackageDir: pluginDir });
  const staging = join(root, 'staging');
  await mkdir(staging, { recursive: true });
  const stage = await stageBundledPackage({
    closure,
    stagingDir: staging,
    generatedFiles: { 'dsh-offline.json': `${JSON.stringify({ kind: 'test' })}\n` },
  });
  assert.deepEqual(stage.bundleDependencies.sort(), ['dep-a', 'dep-b']);
  const artifact = join(root, 'offline-it-plugin-1.0.0-offline.tgz');
  await packDirectoryToTarGz({ sourceDir: stage.packageDir, outFile: artifact, prefix: 'package' });
  await access(artifact);

  // 3. A fresh hoisted profile-like project, installed strictly offline.
  const target = join(root, 'target');
  await mkdir(target, { recursive: true });
  await writeFile(join(target, 'package.json'), `${JSON.stringify({ name: 'offline-it-target', private: true, type: 'module' })}\n`, 'utf8');
  await writeFile(join(target, 'pnpm-workspace.yaml'), 'nodeLinker: hoisted\nautoInstallPeers: false\n', 'utf8');

  const install = await execFileAsync('pnpm', [
    'add',
    '--offline',
    '--registry', 'http://127.0.0.1:1/',
    artifact,
  ], { cwd: target, timeout: 150_000 });
  assert.match(install.stdout + install.stderr, /offline-it-plugin/i);

  // 4. The bundled tree is nested inside the installed package and Node resolves it.
  await access(join(target, 'node_modules', 'offline-it-plugin', 'node_modules', 'dep-a', 'package.json'));
  await access(join(target, 'node_modules', 'offline-it-plugin', 'node_modules', 'dep-b', 'package.json'));
  await access(join(target, 'node_modules', 'offline-it-plugin', 'dsh-offline.json'));
  const requireFromPlugin = createRequire(join(target, 'node_modules', 'offline-it-plugin', 'package.json'));
  assert.match(requireFromPlugin.resolve('dep-a'), /offline-it-plugin[/\\]node_modules[/\\]dep-a/);
  const lock = await readFile(join(target, 'pnpm-lock.yaml'), 'utf8');
  assert.match(lock, /bundledDependencies/);
  assert.match(lock, /- dep-a/);
  assert.match(lock, /- dep-b/);

  // 5. Executing the installed plugin proves runtime resolution through the bundle.
  const entry = await import(pathToFileURL(join(target, 'node_modules', 'offline-it-plugin', 'index.js')).href);
  assert.equal(entry.combined, 'plugin+a1:+b2');
});
