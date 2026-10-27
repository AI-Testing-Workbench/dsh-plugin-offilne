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

test('export marks peer dependencies optional so pnpm never fetches them on import', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-offline-pipeline-peers-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { profileDir, installAnchor } = await createProfile(root);
  const bundleManifestPath = join(profileDir, 'node_modules', 'fixture-plugin', 'package.json');
  const bundleManifest = JSON.parse(await readFile(bundleManifestPath, 'utf8'));
  bundleManifest.peerDependencies = {
    '@deepseek-ai/cordis': '^4.0.2',
    '@deepseek-ai/dsh-tools': '^0.2.0-rc.2',
  };
  bundleManifest.peerDependenciesMeta = { '@deepseek-ai/dsh-tools': { optional: true, reason: 'runtime-provided' } };
  await writeFile(bundleManifestPath, `${JSON.stringify(bundleManifest, undefined, 2)}\n`, 'utf8');

  const ctx = createContext(profileDir, installAnchor, []);
  const artifact = join(root, 'peer-artifact.tgz');
  const exported = await exportPlugin({ ctx, plugin: 'fixture-plugin', output: artifact });
  assert.deepEqual(exported.peersMadeOptional, ['@deepseek-ai/cordis']);
  assert.equal(exported.warnings.some((warning) => warning.includes('peer dependencies')), true);

  const inspected = await inspectArtifact(artifact, ctx);
  assert.deepEqual(inspected.manifest.peerDependencies, {
    '@deepseek-ai/cordis': '^4.0.2',
    '@deepseek-ai/dsh-tools': '^0.2.0-rc.2',
  });
  assert.equal(inspected.manifest.peerDependenciesMeta['@deepseek-ai/cordis'].optional, true);
  assert.equal(inspected.manifest.peerDependenciesMeta['@deepseek-ai/dsh-tools'].optional, true);
  assert.equal(inspected.manifest.peerDependenciesMeta['@deepseek-ai/dsh-tools'].reason, 'runtime-provided');
  assert.deepEqual(inspected.metadata.peersMadeOptional, ['@deepseek-ai/cordis']);
});

/** Minimal empty profile for the import-fallback tests. */
async function createEmptyProfile(root, name) {
  const profileDir = join(root, 'profiles', name);
  await mkdir(profileDir, { recursive: true });
  const appDir = join(root, 'app');
  await writePackage(appDir, { name: '@deepseek-ai/dsh', version: '0.2.1-rc.2' });
  await writeFile(join(profileDir, 'package.json'), `${JSON.stringify({
    name: `dsh-profile-${name}`,
    private: true,
    dependencies: {},
    dsh: { profile: { bundles: [] } },
  }, undefined, 2)}\n`, 'utf8');
  await writeFile(join(profileDir, 'cordis.yml'), '[]\n', 'utf8');
  return { profileDir, installAnchor: join(appDir, 'package.json') };
}

/** Context for an empty profile whose manager installs fail with `error`. */
function createFailingContext(profileDir, installAnchor, error) {
  return {
    get(name) {
      if (name === 'profileContext') return { dir: profileDir, name: 'fallback-profile', installAnchor };
      return undefined;
    },
    pluginManager: {
      async listBundles() {
        return [];
      },
      async installBundle() {
        throw error;
      },
    },
  };
}

test('a registry failure falls back to a pnpm-free install of the bundled artifact', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-offline-pipeline-fallback-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  // Artifact from a source profile.
  const source = await createProfile(root);
  const sourceCtx = createContext(source.profileDir, source.installAnchor, []);
  const artifact = join(root, 'fallback-artifact.tgz');
  await exportPlugin({ ctx: sourceCtx, plugin: 'fixture-plugin', output: artifact });

  // Target profile whose pnpm cannot reach any registry (the intranet case).
  const target = await createEmptyProfile(root, 'target-profile');
  const registryError = new Error(
    'ERR_PNPM_FETCH_404 GET http://central.example.cn/artifactory/api/npm/group-npm/@deepseek-ai%2Fcordis: 404\n'
    + 'This error happened while installing a direct dependency of the profile',
  );
  const targetCtx = createFailingContext(target.profileDir, target.installAnchor, registryError);
  const imported = await importArtifact({ ctx: targetCtx, artifact });
  assert.equal(imported.install.manual, true);
  assert.equal(imported.install.application, 'applied');
  assert.equal(imported.warnings.some((warning) => warning.includes('without pnpm')), true);

  // The bundle files are materialized with their nested closure and recorded.
  assert.equal((await stat(join(target.profileDir, 'node_modules', 'fixture-plugin', 'package.json'))).isFile(), true);
  assert.equal((await stat(join(target.profileDir, 'node_modules', 'fixture-plugin', 'node_modules', 'dep-a', 'package.json'))).isFile(), true);
  const manifest = JSON.parse(await readFile(join(target.profileDir, 'package.json'), 'utf8'));
  assert.equal(manifest.dependencies['fixture-plugin'], `file:${artifact}`);
  assert.deepEqual(manifest.dsh.profile.bundles, ['fixture-plugin']);
});

test('compatibility refusals are never bypassed by the pnpm-free fallback', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-offline-pipeline-incompatible-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const source = await createProfile(root);
  const sourceCtx = createContext(source.profileDir, source.installAnchor, []);
  const artifact = join(root, 'incompatible-artifact.tgz');
  await exportPlugin({ ctx: sourceCtx, plugin: 'fixture-plugin', output: artifact });

  const target = await createEmptyProfile(root, 'incompatible-target');
  const incompatible = new Error('Plugin fixture-plugin@1.0.0 is incompatible with dsh 0.2.1-rc.2: peerDependencies {"@deepseek-ai/dsh-tools":"^9.0.0"}');
  const targetCtx = createFailingContext(target.profileDir, target.installAnchor, incompatible);
  await assert.rejects(
    importArtifact({ ctx: targetCtx, artifact }),
    (error) => error instanceof OfflineError && error.code === 'install-failed',
  );
  await assert.rejects(stat(join(target.profileDir, 'node_modules', 'fixture-plugin')), /ENOENT/);
});
