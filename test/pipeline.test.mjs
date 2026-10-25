/**
 * Pipeline test for the lead-owned modules: a synthetic profile on disk, a fake
 * Host context (profileContext + pluginManager), and the real export → inspect →
 * import path. No DSH process, no network, no pnpm.
 */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { exportPlugin } from '../src/export.mjs';
import { importArtifact, inspectArtifact } from '../src/import.mjs';
import { OfflineError, getRuntimeVersion, resolveProfileDir } from '../src/profile.mjs';
import { packDirectoryToTarGz } from '../src/tar.mjs';

/**
 * Write one package directory.
 * @param dir - package root.
 * @param manifest - package.json contents.
 * @param files - extra relative path -> content.
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

/**
 * Build a synthetic profile: one installed bundle with one dependency, plus an
 * installation anchor manifest carrying the fake DSH runtime version.
 * @param root - temp root directory.
 * @returns the profile directory and fake install anchor.
 */
async function createProfile(root) {
  const profileDir = join(root, 'profiles', 'test-profile');
  const appDir = join(root, 'app');
  const bundleDir = join(profileDir, 'node_modules', 'fixture-plugin');
  const depDir = join(profileDir, 'node_modules', 'dep-a');
  await writePackage(appDir, { name: '@deepseek-ai/dsh', version: '0.2.1-rc.2' });
  await writePackage(bundleDir, {
    name: 'fixture-plugin',
    version: '1.0.0',
    type: 'module',
    main: 'index.js',
    dependencies: { 'dep-a': '^1.0.0' },
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  }, {
    'index.js': 'import { value } from "dep-a";\nexport const combined = `fixture+${value}`;\n',
    'cordis.patch.yml': "- insert:\n    - id: fixture-row\n      name: 'fixture-plugin'\n",
  });
  await writePackage(depDir, { name: 'dep-a', version: '1.2.0', type: 'module', main: 'index.js' }, {
    'index.js': 'export const value = "a1";\n',
  });
  await writeFile(join(profileDir, 'package.json'), `${JSON.stringify({
    name: 'dsh-profile-test-profile',
    private: true,
    dependencies: { 'fixture-plugin': 'file:' + bundleDir },
    dsh: { profile: { bundles: ['fixture-plugin'] } },
  }, undefined, 2)}\n`, 'utf8');
  await writeFile(join(profileDir, 'cordis.yml'), '[]\n', 'utf8');
  return { profileDir, installAnchor: join(appDir, 'package.json') };
}

/**
 * Fake Host context exposing exactly the services the pipeline uses.
 * @param profileDir - the synthetic profile directory.
 * @param installAnchor - fake DSH app manifest path.
 * @param calls - array capturing install calls.
 */
function createContext(profileDir, installAnchor, calls) {
  return {
    get(name) {
      if (name === 'profileContext') return { dir: profileDir, name: 'test-profile', installAnchor };
      return undefined;
    },
    pluginManager: {
      async listBundles() {
        return [
          {
            name: 'fixture-plugin',
            version: '1.0.0',
            installed: true,
            enabled: true,
            removable: true,
            rows: [{ rowId: 'fixture-row', moduleName: 'fixture-plugin', entryId: 'include:fixture-row' }],
          },
          { name: '@deepseek-ai/dsh-base', version: '0.2.1-rc.2', installed: false, enabled: true, rows: [] },
        ];
      },
      async installBundle(spec, options) {
        calls.push({ spec, options });
        return { stage: 'enable', target: 'fixture-plugin', enabled: true, changed: true, application: 'applied' };
      },
    },
  };
}

test('export writes a self-described artifact and import installs it through the manager', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-offline-pipeline-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { profileDir, installAnchor } = await createProfile(root);
  const calls = [];
  const ctx = createContext(profileDir, installAnchor, calls);

  assert.equal(resolveProfileDir(ctx), await realpath(profileDir));
  assert.equal(await getRuntimeVersion(ctx), '0.2.1-rc.2');

  const artifact = join(root, 'out', 'fixture-plugin-1.0.0-offline.tgz');
  const exported = await exportPlugin({ ctx, plugin: 'fixture-plugin', output: artifact });
  assert.equal(exported.artifact, artifact);
  assert.equal(exported.plugin.name, 'fixture-plugin');
  assert.equal(exported.target.dshVersion, '0.2.1-rc.2');
  assert.equal(exported.target.platform, process.platform);
  assert.deepEqual(exported.packages.map((entry) => entry.name), ['dep-a']);
  assert.deepEqual(exported.notBundled, []);
  assert.equal((await stat(artifact)).size > 0, true);

  const inspected = await inspectArtifact(artifact, ctx);
  assert.equal(inspected.recognized, true);
  assert.equal(inspected.metadata.kind, 'dsh-offline-plugin');
  assert.deepEqual(inspected.metadata.bundle.entries, ['fixture-row']);
  assert.equal(inspected.metadata.packages.length, 1);
  assert.equal(inspected.manifest.name, 'fixture-plugin');
  assert.deepEqual(inspected.warnings, []);

  const imported = await importArtifact({ ctx, artifact });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].spec, artifact);
  assert.deepEqual(calls[0].options, {});
  assert.equal(imported.install.application, 'applied');
  assert.equal(imported.plugin.name, 'fixture-plugin');
  assert.equal(imported.packages, 1);

  const disabled = await importArtifact({ ctx, artifact, enabled: false });
  assert.deepEqual(calls[1].options, { enabled: false });
  assert.equal(disabled.action, 'import');
});

test('unknown, shipped and non-bundle packages are refused with actionable codes', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-offline-pipeline-refuse-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { profileDir, installAnchor } = await createProfile(root);
  const ctx = createContext(profileDir, installAnchor, []);

  await assert.rejects(
    exportPlugin({ ctx, plugin: 'not-installed', output: join(root, 'x.tgz') }),
    (error) => error instanceof OfflineError && error.code === 'unknown-plugin',
  );
  await assert.rejects(
    exportPlugin({ ctx, plugin: '@deepseek-ai/dsh-base', output: join(root, 'x.tgz') }),
    (error) => error instanceof OfflineError && error.code === 'not-exportable',
  );

  // A plain npm tarball (no package/dsh-offline.json) is recognized as foreign.
  const plain = join(root, 'plain', 'package');
  await writePackage(plain, { name: 'plain-package', version: '1.0.0' }, { 'index.js': 'export {};\n' });
  const plainTarball = join(root, 'plain.tgz');
  await packDirectoryToTarGz({ sourceDir: plain, outFile: plainTarball, prefix: 'package' });
  const foreign = await inspectArtifact(plainTarball, ctx);
  assert.equal(foreign.recognized, false);
  await assert.rejects(
    importArtifact({ ctx, artifact: plainTarball }),
    (error) => error instanceof OfflineError && error.code === 'not-offline-artifact',
  );

  // Wrong paths are rejected before touching the manager.
  await assert.rejects(inspectArtifact('relative.tgz', ctx), (error) => error.code === 'invalid-artifact');
  await assert.rejects(inspectArtifact(join(root, 'missing.tgz'), ctx), (error) => error.code === 'artifact-not-found');
});

test('relative output paths are refused and directories receive the standard file name', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-offline-pipeline-output-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { profileDir, installAnchor } = await createProfile(root);
  const ctx = createContext(profileDir, installAnchor, []);

  await assert.rejects(
    exportPlugin({ ctx, plugin: 'fixture-plugin', output: 'relative/path.tgz' }),
    (error) => error instanceof OfflineError && error.code === 'invalid-output',
  );

  const dir = join(root, 'artifacts');
  const exported = await exportPlugin({ ctx, plugin: 'fixture-plugin', output: dir });
  assert.equal(exported.artifact, join(dir, 'fixture-plugin-1.0.0-offline.tgz'));
  assert.equal((await stat(exported.artifact)).isFile(), true);
});

test('an installed but deselected bundle is still exportable through the profile manifest', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-offline-pipeline-deselected-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { profileDir, installAnchor } = await createProfile(root);
  const calls = [];
  const ctx = {
    get(name) {
      if (name === 'profileContext') return { dir: profileDir, name: 'test-profile', installAnchor };
      return undefined;
    },
    pluginManager: {
      // Only shipped bundles are reported: the profile dependency is not selected.
      async listBundles() {
        return [{ name: '@deepseek-ai/dsh-base', version: '0.2.1-rc.2', installed: false, enabled: true, rows: [] }];
      },
      async installBundle(spec, options) {
        calls.push({ spec, options });
        return { application: 'applied' };
      },
    },
  };
  const exported = await exportPlugin({ ctx, plugin: 'fixture-plugin', output: join(root, 'artifact.tgz') });
  assert.equal(exported.plugin.name, 'fixture-plugin');
  assert.equal(exported.packageCount, 1);
  const inspected = await inspectArtifact(exported.artifact, ctx);
  assert.deepEqual(inspected.metadata.bundle.entries, []);
});

test('install-time lifecycle scripts are stripped and native builds are reported', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-offline-pipeline-scripts-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { profileDir, installAnchor } = await createProfile(root);
  const bundleDir = join(profileDir, 'node_modules', 'fixture-plugin');
  const manifestPath = join(bundleDir, 'package.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.scripts = { postinstall: 'node postinstall.js', build: 'node build.js' };
  await writeFile(manifestPath, `${JSON.stringify(manifest, undefined, 2)}\n`, 'utf8');
  await writeFile(join(bundleDir, 'binding.gyp'), '{"targets": []}\n', 'utf8');

  const ctx = createContext(profileDir, installAnchor, []);
  const exported = await exportPlugin({ ctx, plugin: 'fixture-plugin', output: join(root, 'artifact.tgz') });
  assert.equal(exported.warnings.some((warning) => warning.includes('postinstall')), true);
  assert.equal(exported.warnings.some((warning) => warning.includes('binding.gyp')), true);

  const inspected = await inspectArtifact(exported.artifact, ctx);
  assert.equal(inspected.manifest.scripts.postinstall, undefined);
  assert.equal(inspected.manifest.scripts.build, 'node build.js');
  assert.deepEqual(inspected.metadata.scriptsRemoved, ['postinstall']);
  assert.equal(inspected.metadata.nativeBuild, true);
});
