/**
 * Unit tests for src/closure.mjs.
 *
 * Everything runs against synthetic package trees created under os.tmpdir(); there is no network
 * access and no pnpm/npm invocation. `node --test test/closure.test.mjs`.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

import {
  collectDependencyClosure,
  nodeModulePaths,
  readManifest,
  resolvePackageDir,
  stageBundledPackage,
} from '../src/closure.mjs';

// ---------------------------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------------------------

async function makeTemp(t) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-closure-'));
  t.after(async () => {
    await fsp.rm(dir, { recursive: true, force: true });
  });
  return dir;
}

async function writeJson(file, value) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeText(file, content) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, content);
}

/** Create a package directory: manifest + extra files (paths relative to the package dir). */
async function makePackage(dir, manifest, files = {}) {
  await writeJson(path.join(dir, 'package.json'), manifest);
  for (const [relative, content] of Object.entries(files)) {
    await writeText(path.join(dir, relative), content);
  }
}

async function readJsonFile(file) {
  return JSON.parse(await fsp.readFile(file, 'utf8'));
}

async function exists(target) {
  try {
    await fsp.stat(target);
    return true;
  } catch {
    return false;
  }
}

/** A profile with a hoisted node_modules layout: <root>/profile/node_modules/<pkg>. */
async function makeProfile(t) {
  const root = await makeTemp(t);
  const profileDir = path.join(root, 'profile');
  const nodeModules = path.join(profileDir, 'node_modules');
  await fsp.mkdir(nodeModules, { recursive: true });
  return { root, profileDir, nodeModules };
}

/** stagingDir is created empty by the caller, as required by the contract. */
async function makeStagingDir(root) {
  const stagingDir = path.join(root, 'staging');
  await fsp.mkdir(stagingDir, { recursive: true });
  return stagingDir;
}

function placementByPath(placements) {
  return new Map(placements.map((placement) => [placement.path, placement]));
}

// ---------------------------------------------------------------------------------------------
// resolution
// ---------------------------------------------------------------------------------------------

test('nodeModulePaths follows Node order and skips node_modules segments', async (t) => {
  const root = await makeTemp(t);
  const pluginDir = path.join(root, 'profile', 'node_modules', 'plugin');
  await fsp.mkdir(pluginDir, { recursive: true });

  const paths = nodeModulePaths(pluginDir);
  assert.equal(paths[0], path.join(pluginDir, 'node_modules'));
  assert.equal(paths[1], path.join(root, 'profile', 'node_modules'));
  assert.ok(paths.includes(path.join(root, 'node_modules')));
  assert.equal(paths.at(-1), path.join(path.parse(root).root, 'node_modules'));
  // No ".../node_modules/node_modules" candidate (a package's own node_modules is fine).
  assert.ok(!paths.some((entry) => entry.split(path.sep).includes(path.join('node_modules', 'node_modules'))));
  assert.equal(new Set(paths).size, paths.length);
  for (let index = 1; index < paths.length; index += 1) {
    assert.ok(paths[index].length < paths[index - 1].length, `lookup paths must get shallower`);
  }

  assert.deepEqual(nodeModulePaths('/'), [path.join('/', 'node_modules')]);
});

test('resolvePackageDir probes node_modules lookup order and returns realpaths', async (t) => {
  const { root, profileDir, nodeModules } = await makeProfile(t);
  const pluginDir = path.join(nodeModules, 'plugin');
  await makePackage(pluginDir, { name: 'plugin', version: '1.0.0' });
  await makePackage(path.join(nodeModules, 'dep'), { name: 'dep', version: '1.0.0' });
  await makePackage(path.join(pluginDir, 'node_modules', 'dep'), { name: 'dep', version: '2.0.0' });

  // A package's own node_modules wins over the hoisted sibling.
  assert.equal(
    resolvePackageDir('dep', pluginDir),
    await fsp.realpath(path.join(pluginDir, 'node_modules', 'dep')),
  );

  // Scoped names are just path segments.
  await makePackage(path.join(nodeModules, '@scope', 'thing'), { name: '@scope/thing', version: '1.0.0' });
  assert.equal(
    resolvePackageDir('@scope/thing', pluginDir),
    await fsp.realpath(path.join(nodeModules, '@scope', 'thing')),
  );

  // A symlinked (workspace) package resolves to its real directory.
  const workspace = path.join(root, 'work', 'linked');
  await makePackage(workspace, { name: 'linked', version: '1.0.0' });
  await fsp.symlink(workspace, path.join(nodeModules, 'linked'), 'dir');
  assert.equal(resolvePackageDir('linked', profileDir), await fsp.realpath(workspace));

  assert.equal(resolvePackageDir('does-not-exist', pluginDir), undefined);
});

test('readManifest parses package.json and rejects broken manifests', async (t) => {
  const root = await makeTemp(t);
  const pkgDir = path.join(root, 'pkg');
  await writeJson(path.join(pkgDir, 'package.json'), { name: 'pkg', version: '1.2.3' });
  assert.deepEqual(readManifest(pkgDir), { name: 'pkg', version: '1.2.3' });

  const broken = path.join(root, 'broken');
  await writeText(path.join(broken, 'package.json'), '{ not json');
  assert.throws(() => readManifest(broken), /invalid JSON in package manifest/);

  await assert.rejects(
    async () => readManifest(path.join(root, 'missing')),
    (error) => error.code === 'ENOMANIFEST',
  );
});

// ---------------------------------------------------------------------------------------------
// closure collection
// ---------------------------------------------------------------------------------------------

test('collectDependencyClosure walks a flat hoisted closure with kind-tagged edges', async (t) => {
  const { nodeModules } = await makeProfile(t);
  const pluginDir = path.join(nodeModules, 'plugin');
  await makePackage(pluginDir, {
    name: 'plugin',
    version: '1.0.0',
    dependencies: { a: '^1.0.0', b: '^1.0.0' },
    optionalDependencies: { optional: '^1.0.0' },
    peerDependencies: { peer: '^1.0.0' },
  });
  await makePackage(path.join(nodeModules, 'a'), { name: 'a', version: '1.0.0', dependencies: { c: '^1.0.0' } });
  await makePackage(path.join(nodeModules, 'b'), { name: 'b', version: '1.0.0' });
  await makePackage(path.join(nodeModules, 'c'), { name: 'c', version: '1.0.0' });
  await makePackage(path.join(nodeModules, 'optional'), { name: 'optional', version: '1.0.0' });
  await makePackage(path.join(nodeModules, 'peer'), { name: 'peer', version: '1.0.0' });

  const closure = await collectDependencyClosure({ rootPackageDir: pluginDir });
  assert.equal(closure.root.name, 'plugin');
  assert.equal(closure.root.version, '1.0.0');
  assert.equal(closure.root.dir, await fsp.realpath(pluginDir));
  assert.deepEqual(
    closure.root.edges.map((edge) => [edge.name, edge.kind]),
    [
      ['a', 'dependency'],
      ['b', 'dependency'],
      ['optional', 'optional'],
      ['peer', 'peer'],
    ],
  );
  // BFS discovery order, realpaths as keys.
  assert.deepEqual(
    [...closure.instances.values()].map((instance) => instance.name),
    ['a', 'b', 'optional', 'peer', 'c'],
  );
  const a = [...closure.instances.values()].find((instance) => instance.name === 'a');
  assert.deepEqual(a.edges.map((edge) => [edge.name, edge.kind]), [['c', 'dependency']]);
  assert.deepEqual(closure.skipped, []);
  assert.deepEqual(closure.unresolved, []);
  assert.deepEqual(closure.warnings, []);
});

test('collectDependencyClosure is cycle safe', async (t) => {
  const { nodeModules } = await makeProfile(t);
  const pluginDir = path.join(nodeModules, 'plugin');
  await makePackage(pluginDir, { name: 'plugin', version: '1.0.0', dependencies: { a: '^1.0.0' } });
  await makePackage(path.join(nodeModules, 'a'), { name: 'a', version: '1.0.0', dependencies: { b: '^1.0.0' } });
  await makePackage(path.join(nodeModules, 'b'), { name: 'b', version: '1.0.0', dependencies: { a: '^1.0.0' } });

  const closure = await collectDependencyClosure({ rootPackageDir: pluginDir });
  assert.deepEqual([...closure.instances.values()].map((instance) => instance.name), ['a', 'b']);
  const a = [...closure.instances.values()].find((instance) => instance.name === 'a');
  const b = [...closure.instances.values()].find((instance) => instance.name === 'b');
  assert.deepEqual(a.edges.map((edge) => edge.name), ['b']);
  assert.deepEqual(b.edges.map((edge) => edge.name), ['a']); // cycle linked, not re-walked
});

test('missing optional dependencies warn; missing required dependencies are unresolved', async (t) => {
  const { nodeModules } = await makeProfile(t);
  const pluginDir = path.join(nodeModules, 'plugin');
  await makePackage(pluginDir, {
    name: 'plugin',
    version: '1.0.0',
    optionalDependencies: { missingOptional: '^1.0.0' },
    dependencies: { missingRequired: '^1.0.0' },
  });

  const closure = await collectDependencyClosure({ rootPackageDir: pluginDir });
  assert.deepEqual(closure.unresolved, [
    { name: 'missingRequired', requestedBy: 'plugin', kind: 'dependency' },
  ]);
  assert.equal(closure.warnings.length, 2);
  assert.ok(closure.warnings.some((warning) => warning.includes('missingOptional')));
  assert.ok(closure.warnings.some((warning) => warning.includes('missingRequired')));
});

test('skips runtime-provided @deepseek-ai packages and honours a custom skip predicate', async (t) => {
  const { nodeModules } = await makeProfile(t);
  const pluginDir = path.join(nodeModules, 'plugin');
  await makePackage(pluginDir, {
    name: 'plugin',
    version: '1.0.0',
    dependencies: { '@deepseek-ai/dsh-tools': '^1.0.0', a: '^1.0.0' },
  });
  await makePackage(path.join(nodeModules, '@deepseek-ai', 'dsh-tools'), {
    name: '@deepseek-ai/dsh-tools',
    version: '1.0.0',
  });
  await makePackage(path.join(nodeModules, 'a'), { name: 'a', version: '1.0.0' });

  const closure = await collectDependencyClosure({ rootPackageDir: pluginDir });
  assert.deepEqual(closure.skipped, [
    { name: '@deepseek-ai/dsh-tools', requestedBy: 'plugin', kind: 'dependency' },
  ]);
  assert.deepEqual([...closure.instances.values()].map((instance) => instance.name), ['a']);
  assert.deepEqual(closure.unresolved, []);

  const custom = await collectDependencyClosure({
    rootPackageDir: pluginDir,
    skip: (name) => name.startsWith('@deepseek-ai/') || name === 'a',
  });
  assert.deepEqual(custom.skipped, [
    { name: '@deepseek-ai/dsh-tools', requestedBy: 'plugin', kind: 'dependency' },
    { name: 'a', requestedBy: 'plugin', kind: 'dependency' },
  ]);
  assert.equal(custom.instances.size, 0);
});

// ---------------------------------------------------------------------------------------------
// staging
// ---------------------------------------------------------------------------------------------

test('stageBundledPackage materializes a flat closure with placements and bundleDependencies', async (t) => {
  const { root, nodeModules } = await makeProfile(t);
  const pluginDir = path.join(nodeModules, 'plugin');
  await makePackage(
    pluginDir,
    {
      name: 'plugin',
      version: '1.0.0',
      description: 'test plugin',
      dependencies: { a: '^1.0.0', b: '^1.0.0' },
      optionalDependencies: { optional: '^1.0.0' },
      peerDependencies: { peer: '^1.0.0' },
    },
    { 'index.js': 'module.exports = 1;\n' },
  );
  await makePackage(path.join(nodeModules, 'a'), { name: 'a', version: '1.0.0', dependencies: { c: '^1.0.0' } });
  await makePackage(path.join(nodeModules, 'b'), { name: 'b', version: '1.0.0' });
  await makePackage(path.join(nodeModules, 'c'), { name: 'c', version: '1.0.0' });
  await makePackage(path.join(nodeModules, 'optional'), { name: 'optional', version: '1.0.0' });
  await makePackage(path.join(nodeModules, 'peer'), { name: 'peer', version: '1.0.0' });

  const closure = await collectDependencyClosure({ rootPackageDir: pluginDir });
  const stagingDir = await makeStagingDir(root);
  const result = await stageBundledPackage({ closure, stagingDir });

  const packageDir = path.join(stagingDir, 'package');
  assert.equal(result.packageDir, packageDir);

  // Flat first-come-first-served layout, discovery order.
  assert.deepEqual(result.placements, [
    { name: 'a', version: '1.0.0', path: 'node_modules/a', kind: 'dependency' },
    { name: 'b', version: '1.0.0', path: 'node_modules/b', kind: 'dependency' },
    { name: 'optional', version: '1.0.0', path: 'node_modules/optional', kind: 'optional' },
    { name: 'peer', version: '1.0.0', path: 'node_modules/peer', kind: 'peer' },
    { name: 'c', version: '1.0.0', path: 'node_modules/c', kind: 'dependency' },
  ]);
  assert.deepEqual(result.bundleDependencies, ['a', 'b', 'optional', 'peer', 'c']);
  assert.deepEqual(result.removedDependencies, []);
  assert.deepEqual(result.warnings, []);

  // Root manifest keeps identity, gets the merged bundle list, 2-space JSON + trailing newline.
  const manifestFile = path.join(packageDir, 'package.json');
  const rawManifest = await fsp.readFile(manifestFile, 'utf8');
  assert.ok(rawManifest.endsWith('\n'));
  assert.ok(rawManifest.startsWith('{\n  "name": "plugin"'));
  assert.ok(!rawManifest.includes('\t'));
  const manifest = JSON.parse(rawManifest);
  assert.equal(manifest.name, 'plugin');
  assert.equal(manifest.version, '1.0.0');
  assert.equal(manifest.description, 'test plugin');
  assert.deepEqual(manifest.bundleDependencies, ['a', 'b', 'optional', 'peer', 'c']);

  // Plugin files are copied; every dependency is a flat sibling.
  assert.equal(await fsp.readFile(path.join(packageDir, 'index.js'), 'utf8'), 'module.exports = 1;\n');
  for (const name of ['a', 'b', 'c', 'optional', 'peer']) {
    assert.equal((await readJsonFile(path.join(packageDir, 'node_modules', name, 'package.json'))).name, name);
  }

  // copiedBytes/fileCount count the copied package files only (not the generated manifest).
  const copiedSources = [
    path.join(pluginDir, 'package.json'),
    path.join(pluginDir, 'index.js'),
    ...['a', 'b', 'c', 'optional', 'peer'].map((name) => path.join(nodeModules, name, 'package.json')),
  ];
  let expectedBytes = 0;
  for (const source of copiedSources) expectedBytes += (await fsp.stat(source)).size;
  assert.equal(result.fileCount, copiedSources.length);
  assert.equal(result.copiedBytes, expectedBytes);
});

test('version conflicts are nested under the declaring package', async (t) => {
  const { root, nodeModules } = await makeProfile(t);
  const pluginDir = path.join(nodeModules, 'plugin');
  await makePackage(
    pluginDir,
    { name: 'plugin', version: '1.0.0', dependencies: { b: '^1.0.0', c: '^1.0.0' } },
    { 'index.js': 'plugin\n' },
  );
  await makePackage(path.join(nodeModules, 'b'), { name: 'b', version: '1.0.0' }, { 'index.js': 'b@1\n' });
  await makePackage(
    path.join(nodeModules, 'c'),
    { name: 'c', version: '1.0.0', dependencies: { b: '^2.0.0' } },
    { 'index.js': 'c\n' },
  );
  await makePackage(path.join(nodeModules, 'c', 'node_modules', 'b'), { name: 'b', version: '2.0.0' }, {
    'index.js': 'b@2\n',
  });

  const closure = await collectDependencyClosure({ rootPackageDir: pluginDir });
  // b@2 exists only below c, so it resolves from c's own node_modules.
  const b2Dir = await fsp.realpath(path.join(nodeModules, 'c', 'node_modules', 'b'));
  const cInstance = [...closure.instances.values()].find((instance) => instance.name === 'c');
  assert.equal(cInstance.edges[0].name, 'b');
  assert.equal(cInstance.edges[0].dir, b2Dir);

  const stagingDir = await makeStagingDir(root);
  const result = await stageBundledPackage({ closure, stagingDir });
  const packageDir = path.join(stagingDir, 'package');

  assert.deepEqual(result.bundleDependencies, ['b', 'c']);
  assert.deepEqual(
    result.placements.map((placement) => [placement.name, placement.version, placement.path]),
    [
      ['b', '1.0.0', 'node_modules/b'],
      ['c', '1.0.0', 'node_modules/c'],
      ['b', '2.0.0', 'node_modules/c/node_modules/b'],
    ],
  );

  // Each version keeps its own content.
  assert.equal(await fsp.readFile(path.join(packageDir, 'node_modules', 'b', 'index.js'), 'utf8'), 'b@1\n');
  assert.equal(
    await fsp.readFile(path.join(packageDir, 'node_modules', 'c', 'node_modules', 'b', 'index.js'), 'utf8'),
    'b@2\n',
  );

  // The declaring package declares its nested bundle.
  const cManifest = await readJsonFile(path.join(packageDir, 'node_modules', 'c', 'package.json'));
  assert.deepEqual(cManifest.bundleDependencies, ['b']);
  assert.deepEqual(cManifest.dependencies, { b: '^2.0.0' });

  // Root keeps its own declared ranges.
  const rootManifest = await readJsonFile(path.join(packageDir, 'package.json'));
  assert.deepEqual(rootManifest.dependencies, { b: '^1.0.0', c: '^1.0.0' });
  assert.deepEqual(result.warnings, []);

  // Node itself resolves each requester to the version it asked for in the staged tree.
  const rootRequire = createRequire(path.join(packageDir, 'package.json'));
  assert.equal(
    rootRequire.resolve('b/package.json'),
    await fsp.realpath(path.join(packageDir, 'node_modules', 'b', 'package.json')),
  );
  assert.equal(
    rootRequire.resolve('c/package.json'),
    await fsp.realpath(path.join(packageDir, 'node_modules', 'c', 'package.json')),
  );
  const cRequire = createRequire(path.join(packageDir, 'node_modules', 'c', 'package.json'));
  assert.equal(
    cRequire.resolve('b/package.json'),
    await fsp.realpath(path.join(packageDir, 'node_modules', 'c', 'node_modules', 'b', 'package.json')),
  );
});

test('staging deep-nests when owners are themselves nested', async (t) => {
  const { root, nodeModules } = await makeProfile(t);
  const pluginDir = path.join(nodeModules, 'plugin');
  await makePackage(pluginDir, {
    name: 'plugin',
    version: '1.0.0',
    dependencies: { a: '^1.0.0', b: '^1.0.0', c: '^2.0.0' },
  });
  // Flat hoisted versions: a@1, b@1, c@2.
  await makePackage(path.join(nodeModules, 'a'), { name: 'a', version: '1.0.0' });
  await makePackage(path.join(nodeModules, 'b'), { name: 'b', version: '1.0.0', dependencies: { a: '^2.0.0' } });
  await makePackage(path.join(nodeModules, 'c'), { name: 'c', version: '2.0.0' });
  // b resolves a@2 from its own node_modules; a@2 resolves c@1 nested below itself.
  await makePackage(path.join(nodeModules, 'b', 'node_modules', 'a'), {
    name: 'a',
    version: '2.0.0',
    dependencies: { c: '^1.0.0' },
  });
  await makePackage(
    path.join(nodeModules, 'b', 'node_modules', 'a', 'node_modules', 'c'),
    { name: 'c', version: '1.0.0' },
  );

  const closure = await collectDependencyClosure({ rootPackageDir: pluginDir });
  const stagingDir = await makeStagingDir(root);
  const result = await stageBundledPackage({ closure, stagingDir });
  const placements = placementByPath(result.placements);

  assert.equal(placements.get('node_modules/a').version, '1.0.0');
  assert.equal(placements.get('node_modules/b').version, '1.0.0');
  assert.equal(placements.get('node_modules/c').version, '2.0.0');
  assert.equal(placements.get('node_modules/b/node_modules/a').version, '2.0.0');
  assert.equal(placements.get('node_modules/b/node_modules/a/node_modules/c').version, '1.0.0');

  const packageDir = path.join(stagingDir, 'package');
  const nestedAManifest = await readJsonFile(
    path.join(packageDir, 'node_modules', 'b', 'node_modules', 'a', 'package.json'),
  );
  assert.deepEqual(nestedAManifest.bundleDependencies, ['c']);
  const bManifest = await readJsonFile(path.join(packageDir, 'node_modules', 'b', 'package.json'));
  assert.deepEqual(bManifest.bundleDependencies, ['a']);
  assert.deepEqual(result.bundleDependencies, ['a', 'b', 'c']);
  assert.deepEqual(result.warnings, []);
});

test('staging excludes node_modules, .git, .DS_Store and *.tgz from copied package content', async (t) => {
  const { root, nodeModules } = await makeProfile(t);
  const pluginDir = path.join(nodeModules, 'plugin');
  await makePackage(
    pluginDir,
    { name: 'plugin', version: '1.0.0', dependencies: { a: '^1.0.0' } },
    {
      'index.js': 'plugin\n',
      '.git/config': 'git config\n',
      '.DS_Store': 'junk',
      'leftover.tgz': 'not a package\n',
      'sub/.DS_Store': 'junk',
      'sub/keep.txt': 'keep\n',
      'node_modules/junk/package.json': '{"name":"junk"}',
    },
  );
  await makePackage(path.join(nodeModules, 'a'), { name: 'a', version: '1.0.0' }, {
    'index.js': 'a\n',
    'node_modules/leftover/package.json': '{"name":"leftover"}',
    'a.tgz': 'junk',
  });

  const closure = await collectDependencyClosure({ rootPackageDir: pluginDir });
  // The undeclared nested node_modules is not part of the closure.
  assert.deepEqual([...closure.instances.values()].map((instance) => instance.name), ['a']);

  const stagingDir = await makeStagingDir(root);
  await stageBundledPackage({ closure, stagingDir });
  const packageDir = path.join(stagingDir, 'package');

  assert.equal(await exists(path.join(packageDir, 'index.js')), true);
  assert.equal(await exists(path.join(packageDir, 'sub', 'keep.txt')), true);
  assert.equal(await exists(path.join(packageDir, '.git')), false);
  assert.equal(await exists(path.join(packageDir, '.DS_Store')), false);
  assert.equal(await exists(path.join(packageDir, 'sub', '.DS_Store')), false);
  assert.equal(await exists(path.join(packageDir, 'leftover.tgz')), false);
  assert.equal(await exists(path.join(packageDir, 'node_modules', 'junk')), false);
  assert.equal(await exists(path.join(packageDir, 'node_modules', 'a', 'node_modules')), false);
  assert.equal(await exists(path.join(packageDir, 'node_modules', 'a', 'a.tgz')), false);
  assert.equal(await exists(path.join(packageDir, 'node_modules', 'a', 'index.js')), true);
});

test('missing optional dependency: warning only, nothing nested and nothing stripped', async (t) => {
  const { root, nodeModules } = await makeProfile(t);
  const pluginDir = path.join(nodeModules, 'plugin');
  await makePackage(pluginDir, {
    name: 'plugin',
    version: '1.0.0',
    optionalDependencies: { nope: '^1.0.0' },
  });

  const closure = await collectDependencyClosure({ rootPackageDir: pluginDir });
  assert.deepEqual(closure.unresolved, []);
  assert.equal(closure.warnings.length, 1);

  const stagingDir = await makeStagingDir(root);
  const result = await stageBundledPackage({ closure, stagingDir });
  const manifest = await readJsonFile(path.join(result.packageDir, 'package.json'));

  assert.deepEqual(manifest.optionalDependencies, { nope: '^1.0.0' });
  assert.equal('bundleDependencies' in manifest, false);
  assert.deepEqual(result.bundleDependencies, []);
  assert.deepEqual(result.removedDependencies, []);
  assert.ok(result.warnings.some((warning) => warning.includes('nope')));
  assert.equal(await exists(path.join(result.packageDir, 'node_modules')), false);
});

test('unresolvable required dependency is recorded and stripped from the root manifest', async (t) => {
  const { root, nodeModules } = await makeProfile(t);
  const pluginDir = path.join(nodeModules, 'plugin');
  await makePackage(pluginDir, { name: 'plugin', version: '1.0.0', dependencies: { ghost: '^1.0.0' } });

  const closure = await collectDependencyClosure({ rootPackageDir: pluginDir });
  assert.deepEqual(closure.unresolved, [{ name: 'ghost', requestedBy: 'plugin', kind: 'dependency' }]);

  const stagingDir = await makeStagingDir(root);
  const result = await stageBundledPackage({ closure, stagingDir });
  const manifest = await readJsonFile(path.join(result.packageDir, 'package.json'));

  // A leftover declaration would make pnpm ask the registry during the offline install.
  assert.deepEqual(manifest.dependencies, {});
  assert.deepEqual(result.removedDependencies, [
    { name: 'ghost', reason: 'not resolvable from the source profile' },
  ]);
  assert.ok(result.warnings.some((warning) => warning.includes('ghost')));
});

test('@deepseek-ai packages are skipped, left declared and never staged', async (t) => {
  const { root, nodeModules } = await makeProfile(t);
  const pluginDir = path.join(nodeModules, 'plugin');
  await makePackage(pluginDir, {
    name: 'plugin',
    version: '1.0.0',
    dependencies: { '@deepseek-ai/dsh-tools': '^1.0.0', a: '^1.0.0' },
  });
  await makePackage(path.join(nodeModules, '@deepseek-ai', 'dsh-tools'), {
    name: '@deepseek-ai/dsh-tools',
    version: '1.0.0',
  });
  await makePackage(path.join(nodeModules, 'a'), { name: 'a', version: '1.0.0' });

  const closure = await collectDependencyClosure({ rootPackageDir: pluginDir });
  const stagingDir = await makeStagingDir(root);
  const result = await stageBundledPackage({ closure, stagingDir });
  const manifest = await readJsonFile(path.join(result.packageDir, 'package.json'));

  assert.equal(await exists(path.join(result.packageDir, 'node_modules', '@deepseek-ai')), false);
  assert.equal(await exists(path.join(result.packageDir, 'node_modules', 'a')), true);
  assert.deepEqual(result.bundleDependencies, ['a']);
  // Runtime-provided packages stay declared: the running DSH supplies them.
  assert.deepEqual(manifest.dependencies, { '@deepseek-ai/dsh-tools': '^1.0.0', a: '^1.0.0' });
  assert.deepEqual(result.removedDependencies, []);
});

test('existing bundleDependencies (array or object form) are preserved and merged', async (t) => {
  const { root, nodeModules } = await makeProfile(t);
  await makePackage(path.join(nodeModules, 'a'), { name: 'a', version: '1.0.0' });

  for (const existing of [['legacy'], { legacy: true }]) {
    const pluginDir = path.join(nodeModules, 'plugin');
    await makePackage(pluginDir, {
      name: 'plugin',
      version: '1.0.0',
      dependencies: { a: '^1.0.0' },
      bundleDependencies: existing,
    });
    const closure = await collectDependencyClosure({ rootPackageDir: pluginDir });
    const stagingDir = await makeStagingDir(root);
    const result = await stageBundledPackage({ closure, stagingDir });
    const manifest = await readJsonFile(path.join(result.packageDir, 'package.json'));
    assert.deepEqual(manifest.bundleDependencies, ['legacy', 'a']);
    assert.deepEqual(result.bundleDependencies, ['legacy', 'a']);
  }
});

test('symlinked package content is copied, workspace realpaths are used for resolution, cycles warn', async (t) => {
  const { root, profileDir, nodeModules } = await makeProfile(t);

  // Real plugin lives in a workspace directory and is symlinked into the profile.
  const workspace = path.join(root, 'work', 'linked-plugin');
  await makePackage(
    workspace,
    { name: 'linked-plugin', version: '1.0.0', dependencies: { a: '^2.0.0' } },
    {
      'index.js': 'linked\n',
      'real.txt': 'real content\n',
    },
  );
  await makePackage(path.join(workspace, 'node_modules', 'a'), { name: 'a', version: '2.0.0' }, {
    'index.js': 'a@2\n',
  });
  await makePackage(path.join(nodeModules, 'a'), { name: 'a', version: '1.0.0' }, { 'index.js': 'a@1\n' });

  await writeText(path.join(root, 'work', 'shared.txt'), 'shared content\n');
  await fsp.symlink(path.join('..', 'shared.txt'), path.join(workspace, 'alias.txt'));
  await makePackage(path.join(workspace, 'realdir'), { name: 'not-a-package', version: '0.0.0' }, {
    'inside.txt': 'nested\n',
  });
  await fsp.symlink(path.join(workspace, 'realdir'), path.join(workspace, 'dir-link'), 'dir');
  await fsp.symlink(workspace, path.join(workspace, 'loop'), 'dir');
  await fsp.symlink(workspace, path.join(nodeModules, 'linked-plugin'), 'dir');

  // The symlinked plugin resolves to its realpath, and deps resolve from the real location.
  assert.equal(resolvePackageDir('linked-plugin', profileDir), await fsp.realpath(workspace));
  const closure = await collectDependencyClosure({ rootPackageDir: path.join(nodeModules, 'linked-plugin') });
  assert.equal(closure.root.dir, await fsp.realpath(workspace));
  assert.deepEqual([...closure.instances.values()].map((instance) => instance.name), ['a']);
  assert.equal(
    [...closure.instances.values()][0].dir,
    await fsp.realpath(path.join(workspace, 'node_modules', 'a')),
  );

  const stagingDir = await makeStagingDir(root);
  const result = await stageBundledPackage({ closure, stagingDir });
  const packageDir = result.packageDir;

  assert.equal(await fsp.readFile(path.join(packageDir, 'index.js'), 'utf8'), 'linked\n');
  // Symlinked files are dereferenced.
  assert.equal(await fsp.readFile(path.join(packageDir, 'alias.txt'), 'utf8'), 'shared content\n');
  // Symlinked directories are copied as directories.
  assert.equal(await fsp.readFile(path.join(packageDir, 'dir-link', 'inside.txt'), 'utf8'), 'nested\n');
  // The self-referential symlink is skipped with a warning instead of hanging.
  assert.equal(await exists(path.join(packageDir, 'loop')), false);
  assert.ok(result.warnings.some((warning) => warning.includes('cycle')));
  // The workspace-nested dependency wins (realpath resolution) and is hoisted into the bundle.
  assert.equal((await readJsonFile(path.join(packageDir, 'node_modules', 'a', 'package.json'))).version, '2.0.0');
  assert.deepEqual(result.bundleDependencies, ['a']);
});

test('generatedFiles are written at the package root; packageJsonTransform is applied', async (t) => {
  const { root, nodeModules } = await makeProfile(t);
  const pluginDir = path.join(nodeModules, 'plugin');
  await makePackage(pluginDir, { name: 'plugin', version: '1.0.0', dependencies: { a: '^1.0.0' } });
  await makePackage(path.join(nodeModules, 'a'), { name: 'a', version: '1.0.0' });

  const closure = await collectDependencyClosure({ rootPackageDir: pluginDir });
  const stagingDir = await makeStagingDir(root);
  let transformCalls = 0;
  const result = await stageBundledPackage({
    closure,
    stagingDir,
    generatedFiles: {
      'dsh-offline.json': { schemaVersion: 1, kind: 'dsh-offline-plugin' },
      'notes.txt': 'hello\n',
      'meta/info.json': { nested: true },
    },
    packageJsonTransform: (manifest, stage) => {
      transformCalls += 1;
      assert.equal(stage.packageDir, path.join(stagingDir, 'package'));
      assert.deepEqual(stage.bundleDependencies, ['a']);
      assert.deepEqual(
        stage.placements.map((placement) => placement.path),
        ['node_modules/a'],
      );
      manifest.dshOffline = { packages: stage.bundleDependencies.length };
      // mutation-only transform: return undefined
    },
  });

  assert.equal(transformCalls, 1);
  const offlineFile = path.join(result.packageDir, 'dsh-offline.json');
  assert.deepEqual(await readJsonFile(offlineFile), { schemaVersion: 1, kind: 'dsh-offline-plugin' });
  const rawOffline = await fsp.readFile(offlineFile, 'utf8');
  assert.ok(rawOffline.endsWith('\n'));
  assert.ok(rawOffline.startsWith('{\n  "schemaVersion": 1'));
  assert.equal(await fsp.readFile(path.join(result.packageDir, 'notes.txt'), 'utf8'), 'hello\n');
  assert.deepEqual(await readJsonFile(path.join(result.packageDir, 'meta', 'info.json')), { nested: true });

  const manifest = await readJsonFile(path.join(result.packageDir, 'package.json'));
  assert.deepEqual(manifest.dshOffline, { packages: 1 });

  // A transform may also return a replacement object.
  const otherStaging = await makeStagingDir(path.join(root, 'other'));
  const replaced = await stageBundledPackage({
    closure,
    stagingDir: otherStaging,
    packageJsonTransform: (manifest) => ({ ...manifest, transformed: true }),
  });
  assert.equal((await readJsonFile(path.join(replaced.packageDir, 'package.json'))).transformed, true);

  // Generated paths may not escape the package.
  const evilStaging = await makeStagingDir(path.join(root, 'evil'));
  await assert.rejects(
    async () =>
      stageBundledPackage({ closure, stagingDir: evilStaging, generatedFiles: { '../escape.json': 'x' } }),
    /unsafe path/,
  );
});

test('staging a plugin with no dependencies writes a clean root manifest', async (t) => {
  const { root, nodeModules } = await makeProfile(t);
  const pluginDir = path.join(nodeModules, 'plugin');
  await makePackage(pluginDir, { name: 'plugin', version: '1.0.0' }, { 'index.js': '1\n' });

  const closure = await collectDependencyClosure({ rootPackageDir: pluginDir });
  assert.equal(closure.instances.size, 0);
  const stagingDir = await makeStagingDir(root);
  const result = await stageBundledPackage({ closure, stagingDir });
  const manifest = await readJsonFile(path.join(result.packageDir, 'package.json'));

  assert.equal('bundleDependencies' in manifest, false);
  assert.deepEqual(result.bundleDependencies, []);
  assert.deepEqual(result.placements, []);
  assert.deepEqual(result.removedDependencies, []);
  assert.equal(await exists(path.join(result.packageDir, 'node_modules')), false);
  assert.equal(await fsp.readFile(path.join(result.packageDir, 'index.js'), 'utf8'), '1\n');
});

test('a shadowed nested resolution gets a local copy so the staged tree stays correct', async (t) => {
  // Workspace-linked root pulls p@2 from the workspace, while the profile hoists p@1 and b@1.
  // c is hoisted and needs p@1 + b@2, so p@1 is nested under c; c's nested b@2 would shadow the
  // b@1 that p@1 declared. A correct artifact must keep p@1 resolving b@1.
  const { root, profileDir, nodeModules } = await makeProfile(t);
  const workspace = path.join(profileDir, 'work', 'linked-plugin');
  await makePackage(workspace, {
    name: 'linked-plugin',
    version: '1.0.0',
    dependencies: { p: '^2.0.0', b: '^1.0.0', c: '^1.0.0' },
  });
  await makePackage(path.join(workspace, 'node_modules', 'p'), { name: 'p', version: '2.0.0' });

  await makePackage(path.join(nodeModules, 'b'), { name: 'b', version: '1.0.0' });
  await makePackage(path.join(nodeModules, 'p'), {
    name: 'p',
    version: '1.0.0',
    dependencies: { b: '^1.0.0' },
  });
  await makePackage(path.join(nodeModules, 'c'), {
    name: 'c',
    version: '1.0.0',
    dependencies: { p: '^1.0.0', b: '^2.0.0' },
  });
  await makePackage(path.join(nodeModules, 'c', 'node_modules', 'b'), { name: 'b', version: '2.0.0' });
  await fsp.symlink(workspace, path.join(nodeModules, 'linked-plugin'), 'dir');

  const closure = await collectDependencyClosure({ rootPackageDir: path.join(nodeModules, 'linked-plugin') });
  const stagingDir = await makeStagingDir(root);
  const result = await stageBundledPackage({ closure, stagingDir });
  const placements = placementByPath(result.placements);

  // p@2 wins the flat slot (first root edge), p@1 is nested under c and c has its own b@2.
  assert.equal(placements.get('node_modules/p').version, '2.0.0');
  assert.equal(placements.get('node_modules/c/node_modules/p').version, '1.0.0');
  assert.equal(placements.get('node_modules/c/node_modules/b').version, '2.0.0');
  // The extra local copy keeps p@1 resolving b@1 despite c's nested b@2.
  assert.equal(placements.get('node_modules/c/node_modules/p/node_modules/b').version, '1.0.0');
  assert.ok(result.warnings.some((warning) => warning.includes('shadowed')));

  // Declaration bookkeeping includes the extra nested copy.
  const packageDir = result.packageDir;
  const nestedPRequire = createRequire(
    path.join(packageDir, 'node_modules', 'c', 'node_modules', 'p', 'package.json'),
  );
  assert.equal(
    nestedPRequire.resolve('b/package.json'),
    await fsp.realpath(
      path.join(packageDir, 'node_modules', 'c', 'node_modules', 'p', 'node_modules', 'b', 'package.json'),
    ),
  );
  assert.deepEqual(
    (await readJsonFile(path.join(packageDir, 'node_modules', 'c', 'node_modules', 'p', 'package.json'))).bundleDependencies,
    ['b'],
  );
  assert.deepEqual(
    (await readJsonFile(path.join(packageDir, 'node_modules', 'c', 'package.json'))).bundleDependencies,
    ['p', 'b'],
  );
  assert.deepEqual(result.bundleDependencies, ['p', 'b', 'c']);
});
