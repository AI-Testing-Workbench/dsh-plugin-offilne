/**
 * Completeness audit tests: a real exported artifact verifies clean, and each
 * kind of broken artifact is reported with an actionable error.
 */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { exportPlugin } from '../src/export.mjs';
import { packDirectoryToTarGz } from '../src/tar.mjs';
import { verifyArtifact } from '../src/verify.mjs';

/** Write one package directory. */
async function writePackage(dir, manifest, files = {}) {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'package.json'), `${JSON.stringify(manifest, undefined, 2)}\n`, 'utf8');
  for (const [name, content] of Object.entries(files)) {
    const target = join(dir, name);
    await mkdir(join(target, '..'), { recursive: true });
    await writeFile(target, content, 'utf8');
  }
}

/** Pack one hand-made `package/` tree into an artifact. */
async function pack(root, tree, name) {
  const out = join(root, name);
  await packDirectoryToTarGz({ sourceDir: tree, outFile: out, prefix: 'package' });
  return out;
}

test('a real exported artifact audits as complete', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-offline-verify-ok-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const profileDir = join(root, 'profiles', 'source');
  const appDir = join(root, 'app');
  const bundleDir = join(profileDir, 'node_modules', 'verify-plugin');
  await writePackage(appDir, { name: '@deepseek-ai/dsh', version: '0.2.1-rc.2' });
  await writePackage(bundleDir, {
    name: 'verify-plugin',
    version: '1.0.0',
    type: 'module',
    main: 'index.js',
    dependencies: { 'dep-a': '^1.0.0', '@deepseek-ai/dsh-tools': '^0.2.0-rc.2' },
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  }, {
    'index.js': 'export const name = "verify-plugin";\n',
    'cordis.patch.yml': "- insert:\n    - id: verify-plugin\n      name: 'verify-plugin'\n",
  });
  await writePackage(join(profileDir, 'node_modules', 'dep-a'), {
    name: 'dep-a', version: '1.2.0', type: 'module', main: 'index.js', dependencies: { 'dep-b': '^2.0.0' },
  }, { 'index.js': 'export const value = "a";\n' });
  await writePackage(join(profileDir, 'node_modules', 'dep-b'), {
    name: 'dep-b', version: '2.3.0', type: 'module', main: 'index.js',
  }, { 'index.js': 'export const value = "b";\n' });
  await writeFile(join(profileDir, 'package.json'), `${JSON.stringify({
    name: 'dsh-profile-verify-source',
    private: true,
    dependencies: { 'verify-plugin': `file:${bundleDir}` },
    dsh: { profile: { bundles: ['verify-plugin'] } },
  }, undefined, 2)}\n`, 'utf8');
  await writeFile(join(profileDir, 'cordis.yml'), '[]\n', 'utf8');
  const installAnchor = join(appDir, 'package.json');
  const ctx = {
    get(name) {
      if (name === 'profileContext') return { dir: profileDir, name: 'source', installAnchor };
      return undefined;
    },
    pluginManager: {
      async listBundles() {
        return [{ name: 'verify-plugin', version: '1.0.0', installed: true, enabled: true, rows: [] }];
      },
    },
  };
  const artifact = join(root, 'verify-plugin-1.0.0-offline.tgz');
  const exported = await exportPlugin({ ctx, plugin: 'verify-plugin', output: artifact });
  assert.equal(exported.complete, true);
  assert.deepEqual(exported.auditErrors, []);
  assert.deepEqual(exported.packages.map((entry) => entry.name).sort(), ['dep-a', 'dep-b']);

  const report = await verifyArtifact(artifact);
  assert.equal(report.ok, true);
  assert.equal(report.complete, true);
  assert.equal(report.plugin.name, 'verify-plugin');
  assert.equal(report.packageCount, 3);
  assert.deepEqual(report.packages.map((entry) => entry.path).sort(), [
    '.',
    'node_modules/dep-a',
    'node_modules/dep-b',
  ]);
  assert.deepEqual(report.errors, []);
  // The declared @deepseek-ai dependency comes from the DSH runtime, not the artifact.
  assert.deepEqual(report.runtimeProvided, ['@deepseek-ai/dsh-tools']);
});

test('missing required dependencies and phantom bundle declarations are errors', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-offline-verify-broken-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const tree = join(root, 'tree');
  await writePackage(tree, {
    name: 'broken-plugin',
    version: '1.0.0',
    dependencies: { 'missing-dep': '^1.0.0' },
    bundleDependencies: ['ghost-package'],
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  }, { 'cordis.patch.yml': "- insert: []\n" });
  const artifact = await pack(root, tree, 'broken.tgz');

  const report = await verifyArtifact(artifact);
  assert.equal(report.ok, false);
  const kinds = report.errors.map((error) => error.kind).sort();
  assert.deepEqual(kinds, ['declared-bundle-missing', 'missing-dependency']);
  assert.deepEqual(report.errors.find((error) => error.kind === 'declared-bundle-missing').name, 'ghost-package');
  assert.deepEqual(report.errors.find((error) => error.kind === 'missing-dependency').name, 'missing-dep');
});

test('nested bundles resolve and an artifact manifest mismatch is reported', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-offline-verify-nested-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const tree = join(root, 'tree');
  await writePackage(tree, {
    name: 'nested-plugin',
    version: '1.0.0',
    dependencies: { 'dep-a': '^1.0.0' },
    bundleDependencies: ['dep-a'],
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  }, {
    'cordis.patch.yml': "- insert: []\n",
    'dsh-offline.json': `${JSON.stringify({ plugin: { name: 'other-plugin', version: '9.9.9' } })}\n`,
  });
  await writePackage(join(tree, 'node_modules', 'dep-a'), {
    name: 'dep-a', version: '1.0.0', dependencies: { 'dep-b': '^2.0.0' }, bundleDependencies: ['dep-b'],
  }, {});
  await writePackage(join(tree, 'node_modules', 'dep-a', 'node_modules', 'dep-b'), {
    name: 'dep-b', version: '2.0.0',
  }, {});
  const artifact = await pack(root, tree, 'nested.tgz');

  const report = await verifyArtifact(artifact);
  const kinds = report.errors.map((error) => error.kind);
  assert.deepEqual(kinds, ['marker-mismatch']);
  assert.equal(report.packageCount, 3);
  assert.equal(report.packages.some((entry) => entry.path === 'node_modules/dep-a/node_modules/dep-b'), true);
});

test('an optional dependency that is absent is a note, not an error', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-offline-verify-optional-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const tree = join(root, 'tree');
  await writePackage(tree, {
    name: 'optional-plugin',
    version: '1.0.0',
    optionalDependencies: { 'platform-native': '^1.0.0' },
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  }, { 'cordis.patch.yml': "- insert: []\n" });
  const artifact = await pack(root, tree, 'optional.tgz');

  const report = await verifyArtifact(artifact);
  assert.equal(report.ok, true);
  assert.deepEqual(report.optionalMissing.map((entry) => entry.name), ['platform-native']);
});
