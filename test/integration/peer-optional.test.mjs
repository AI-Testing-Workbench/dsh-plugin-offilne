/**
 * Integration check for the peer-dependency fix behind the intranet failure:
 * a plugin tarball that declares `@deepseek-ai/cordis` as a peer must install
 * with pnpm's default autoInstallPeers behavior and an EMPTY store without any
 * registry access (before the fix pnpm tried to fetch that peer and failed with
 * ERR_PNPM_FETCH_404 on an isolated registry).
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { exportPlugin } from '../../src/export.mjs';

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

const PNPM_AVAILABLE = await pnpmAvailable();

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

test('an artifact with peer dependencies installs offline without fetching peers', { skip: !PNPM_AVAILABLE, timeout: 180_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-offline-peer-it-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  // Source profile with one installed bundle that declares peers like dshmarket.
  const profileDir = join(root, 'profiles', 'source');
  const appDir = join(root, 'app');
  const bundleDir = join(profileDir, 'node_modules', 'peer-plugin');
  await writePackage(appDir, { name: '@deepseek-ai/dsh', version: '0.2.1-rc.2' });
  await writePackage(bundleDir, {
    name: 'peer-plugin',
    version: '1.0.0',
    type: 'module',
    main: 'index.js',
    peerDependencies: { '@deepseek-ai/cordis': '^4.0.2', '@deepseek-ai/dsh-tools': '^0.2.0-rc.2' },
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  }, {
    'index.js': 'export const name = "peer-plugin";\n',
    'cordis.patch.yml': "- insert:\n    - id: peer-plugin\n      name: 'peer-plugin'\n",
  });
  await writeFile(join(profileDir, 'package.json'), `${JSON.stringify({
    name: 'dsh-profile-peer-source',
    private: true,
    dependencies: { 'peer-plugin': `file:${bundleDir}` },
    dsh: { profile: { bundles: ['peer-plugin'] } },
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
        return [{ name: 'peer-plugin', version: '1.0.0', installed: true, enabled: true, rows: [] }];
      },
    },
  };
  const artifact = join(root, 'peer-plugin-1.0.0-offline.tgz');
  await exportPlugin({ ctx, plugin: 'peer-plugin', output: artifact });

  // The artifact records the peers as optional.
  const { extractTarGz } = await import('../../src/tar.mjs');
  const extracted = join(root, 'check');
  await extractTarGz({ file: artifact, destDir: extracted });
  const manifest = JSON.parse(await readFile(join(extracted, 'package.json'), 'utf8'));
  assert.equal(manifest.peerDependenciesMeta['@deepseek-ai/cordis'].optional, true);
  assert.equal(manifest.peerDependenciesMeta['@deepseek-ai/dsh-tools'].optional, true);

  // A fresh hoisted project with an empty store and no registry must install it.
  const target = join(root, 'target');
  await mkdir(target, { recursive: true });
  await writeFile(join(target, 'package.json'), `${JSON.stringify({ name: 'peer-target', private: true, type: 'module' })}\n`, 'utf8');
  await writeFile(join(target, 'pnpm-workspace.yaml'), 'nodeLinker: hoisted\n', 'utf8');
  const install = await execFileAsync('pnpm', [
    'add',
    '--offline',
    '--store-dir', join(root, 'empty-store'),
    '--registry', 'http://127.0.0.1:1/',
    artifact,
  ], { cwd: target, timeout: 150_000 });
  assert.match(install.stdout + install.stderr, /peer-plugin/i);
  await access(join(target, 'node_modules', 'peer-plugin', 'package.json'));
  // autoInstallPeers did not add the peers as direct dependencies.
  await assert.rejects(access(join(target, 'node_modules', '@deepseek-ai')), /ENOENT/);
  const targetManifest = JSON.parse(await readFile(join(target, 'package.json'), 'utf8'));
  assert.deepEqual(Object.keys(targetManifest.dependencies), ['peer-plugin']);
});
