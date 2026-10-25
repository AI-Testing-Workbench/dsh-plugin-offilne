/**
 * Tests for the browser-facing endpoints: route registration, bundle listing,
 * the export request, method/media-type refusals, and disposal. No HTTP server,
 * no network: a fake `webServer` collects handlers and the tests drive them with
 * a fake request stream and response recorder.
 */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { registerOfflineRoutes } from '../src/http.mjs';
import { packDirectoryToTarGz } from '../src/tar.mjs';

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

/** Synthetic profile with one installed bundle and an installation anchor. */
async function createProfile(root) {
  const profileDir = join(root, 'profiles', 'test-profile');
  const appDir = join(root, 'app');
  const bundleDir = join(profileDir, 'node_modules', 'fixture-plugin');
  await writePackage(appDir, { name: '@deepseek-ai/dsh', version: '0.2.1-rc.2' });
  await writePackage(bundleDir, {
    name: 'fixture-plugin',
    version: '1.0.0',
    type: 'module',
    main: 'index.js',
    dependencies: { 'dep-a': '^1.0.0' },
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  }, {
    'index.js': 'export const name = "fixture-plugin";\n',
    'cordis.patch.yml': "- insert:\n    - id: fixture-row\n      name: 'fixture-plugin'\n",
  });
  await writePackage(join(profileDir, 'node_modules', 'dep-a'), {
    name: 'dep-a', version: '1.2.0', type: 'module', main: 'index.js',
  }, { 'index.js': 'export const value = "a";\n' });
  await writeFile(join(profileDir, 'package.json'), `${JSON.stringify({
    name: 'dsh-profile-test-profile',
    private: true,
    dependencies: { 'fixture-plugin': 'file:' + bundleDir },
    dsh: { profile: { bundles: ['fixture-plugin'] } },
  }, undefined, 2)}\n`, 'utf8');
  await writeFile(join(profileDir, 'cordis.yml'), '[]\n', 'utf8');
  return { profileDir, installAnchor: join(appDir, 'package.json') };
}

/** Fake web server that records registered routes. */
function createWebServer() {
  const routes = [];
  return {
    routes,
    register(route) {
      routes.push(route);
      return () => {
        const index = routes.indexOf(route);
        if (index >= 0) routes.splice(index, 1);
      };
    },
  };
}

/** Fake Host context: profile facts, manager, and the fake web server. */
function createContext(profileDir, installAnchor, webServer, installs = []) {
  return {
    get(name) {
      if (name === 'profileContext') return { dir: profileDir, name: 'test-profile', installAnchor };
      if (name === 'webServer') return webServer;
      return undefined;
    },
    pluginManager: {
      async listBundles() {
        return [
          {
            name: 'fixture-plugin', version: '1.0.0', installed: true, enabled: true, removable: true,
            rows: [{ rowId: 'fixture-row', moduleName: 'fixture-plugin', entryId: 'include:fixture-row' }],
          },
          { name: '@deepseek-ai/dsh-base', version: '0.2.1-rc.2', installed: false, enabled: true, rows: [] },
        ];
      },
      async installBundle(spec, options) {
        installs.push({ spec, options });
        return { stage: 'enable', target: 'fixture-plugin', enabled: true, changed: true, application: 'applied' };
      },
    },
  };
}

/** Read an artifact's raw bytes as a fake upload body. */
function readArtifactBody(file) {
  return readFile(file);
}

/** Point DSH_HOME at a temp dir for one test and restore it afterwards. */
function useHome(t, root) {
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = join(root, 'home');
  t.after(() => {
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
  });
}

/** Fake HTTP request carrying an optional JSON body. */
function createRequest({ method = 'GET', body, contentType = 'application/json' } = {}) {
  const text = body === undefined ? '' : JSON.stringify(body);
  const request = Readable.from(text === '' ? [] : [Buffer.from(text, 'utf8')]);
  request.method = method;
  request.headers = text === '' ? {} : { 'content-type': contentType };
  return request;
}

/** Fake HTTP response recorder. */
function createResponse() {
  return {
    statusCode: undefined,
    headers: undefined,
    body: undefined,
    writeHead(status, headers) {
      this.statusCode = status;
      this.headers = headers;
    },
    end(body) {
      this.body = body;
    },
  };
}

/** Drive one recorded route with a fake request/response pair. */
async function callRoute(route, request) {
  const response = createResponse();
  await route.handler(request, response);
  const parsed = typeof response.body === 'string' ? JSON.parse(response.body) : undefined;
  return { response, body: parsed };
}

test('bundle listing exposes installed profile bundles only', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-offline-http-bundles-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { profileDir, installAnchor } = await createProfile(root);
  const webServer = createWebServer();
  const ctx = createContext(profileDir, installAnchor, webServer);
  const dispose = registerOfflineRoutes(ctx);
  assert.deepEqual(webServer.routes.map((route) => route.path).sort(), [
    '/dsh-offline/api/v1/bundles',
    '/dsh-offline/api/v1/export',
    '/dsh-offline/api/v1/import',
  ]);

  const route = webServer.routes.find((item) => item.path.endsWith('/bundles'));
  const { response, body } = await callRoute(route, createRequest({ method: 'GET' }));
  assert.equal(response.statusCode, 200);
  assert.equal(body.ok, true);
  assert.deepEqual(body.bundles.map((bundle) => bundle.name), ['fixture-plugin']);
  assert.equal(body.bundles[0].enabled, true);
  assert.equal(typeof body.artifactDir, 'string');
  assert.equal(body.runtime.version, '0.2.1-rc.2');

  dispose();
  assert.equal(webServer.routes.length, 0);
});

test('export request writes the artifact and reports the result', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-offline-http-export-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { profileDir, installAnchor } = await createProfile(root);
  const webServer = createWebServer();
  const ctx = createContext(profileDir, installAnchor, webServer);
  const dispose = registerOfflineRoutes(ctx);
  t.after(dispose);
  const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = join(root, 'home');
  t.after(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
  });

  const route = webServer.routes.find((item) => item.path.endsWith('/export'));
  const { response, body } = await callRoute(route, createRequest({ method: 'POST', body: { plugin: 'fixture-plugin' } }));
  assert.equal(response.statusCode, 200);
  assert.equal(body.ok, true);
  assert.equal(body.result.plugin.name, 'fixture-plugin');
  assert.equal(body.result.packageCount, 1);
  assert.deepEqual(body.result.packages.map((entry) => entry.name), ['dep-a']);
  assert.equal(body.result.target.dshVersion, '0.2.1-rc.2');
  assert.equal((await stat(body.result.artifact)).isFile(), true);
});

test('bad methods, media types and plugin names are refused', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-offline-http-refusals-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { profileDir, installAnchor } = await createProfile(root);
  const webServer = createWebServer();
  const ctx = createContext(profileDir, installAnchor, webServer);
  const dispose = registerOfflineRoutes(ctx);
  t.after(dispose);

  const bundles = webServer.routes.find((item) => item.path.endsWith('/bundles'));
  const exported = webServer.routes.find((item) => item.path.endsWith('/export'));

  const wrongMethod = await callRoute(bundles, createRequest({ method: 'POST', body: {} }));
  assert.equal(wrongMethod.response.statusCode, 405);
  assert.equal(wrongMethod.response.headers.allow, 'GET');

  const wrongExportMethod = await callRoute(exported, createRequest({ method: 'GET' }));
  assert.equal(wrongExportMethod.response.statusCode, 405);
  assert.equal(wrongExportMethod.response.headers.allow, 'POST');

  const wrongMedia = await callRoute(exported, createRequest({ method: 'POST', body: { plugin: 'fixture-plugin' }, contentType: 'text/plain' }));
  assert.equal(wrongMedia.response.statusCode, 415);
  assert.equal(wrongMedia.body.code, 'unsupported-media-type');

  const emptyPlugin = await callRoute(exported, createRequest({ method: 'POST', body: { plugin: '  ' } }));
  assert.equal(emptyPlugin.response.statusCode, 400);
  assert.equal(emptyPlugin.body.code, 'invalid-plugin');

  const unknownPlugin = await callRoute(exported, createRequest({ method: 'POST', body: { plugin: 'missing-plugin' } }));
  assert.equal(unknownPlugin.response.statusCode, 400);
  assert.equal(unknownPlugin.body.code, 'unknown-plugin');
});

test('profiles without a web server register nothing', async () => {
  const ctx = {
    get(name) {
      if (name === 'profileContext') return { dir: '/nonexistent-profile', name: 'x', installAnchor: '/nonexistent/app.json' };
      return undefined;
    },
    pluginManager: {},
  };
  const dispose = registerOfflineRoutes(ctx);
  assert.equal(typeof dispose, 'function');
  dispose();
});

test('export request honours a chosen output directory and refuses bad ones', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-offline-http-output-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { profileDir, installAnchor } = await createProfile(root);
  const webServer = createWebServer();
  const ctx = createContext(profileDir, installAnchor, webServer);
  const dispose = registerOfflineRoutes(ctx);
  t.after(dispose);
  useHome(t, root);

  const route = webServer.routes.find((item) => item.path.endsWith('/export'));
  const chosen = join(root, 'chosen');
  await mkdir(chosen, { recursive: true });
  const picked = await callRoute(route, createRequest({ method: 'POST', body: { plugin: 'fixture-plugin', output: chosen } }));
  assert.equal(picked.response.statusCode, 200);
  assert.equal(picked.body.result.artifact, join(chosen, 'fixture-plugin-1.0.0-offline.tgz'));
  assert.equal((await stat(picked.body.result.artifact)).isFile(), true);

  const relative = await callRoute(route, createRequest({ method: 'POST', body: { plugin: 'fixture-plugin', output: 'relative/dir' } }));
  assert.equal(relative.response.statusCode, 400);
  assert.equal(relative.body.code, 'invalid-output');

  const missing = await callRoute(route, createRequest({ method: 'POST', body: { plugin: 'fixture-plugin', output: join(root, 'missing') } }));
  assert.equal(missing.response.statusCode, 400);
  assert.equal(missing.body.code, 'invalid-output');

  const file = join(root, 'not-a-dir.tgz');
  await writeFile(file, 'x');
  const notDir = await callRoute(route, createRequest({ method: 'POST', body: { plugin: 'fixture-plugin', output: file } }));
  assert.equal(notDir.response.statusCode, 400);
  assert.equal(notDir.body.code, 'invalid-output');
});

test('import endpoint installs a valid artifact from its parked copy', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-offline-http-import-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { profileDir, installAnchor } = await createProfile(root);
  const webServer = createWebServer();
  const installs = [];
  const ctx = createContext(profileDir, installAnchor, webServer, installs);
  const dispose = registerOfflineRoutes(ctx);
  t.after(dispose);
  useHome(t, root);

  // Produce an artifact through the export route, then import it back.
  const exportRoute = webServer.routes.find((item) => item.path.endsWith('/export'));
  const exported = await callRoute(exportRoute, createRequest({ method: 'POST', body: { plugin: 'fixture-plugin' } }));
  const artifact = exported.body.result.artifact;
  const bytes = await readArtifactBody(artifact);

  const importRoute = webServer.routes.find((item) => item.path.endsWith('/import'));
  const response = createResponse();
  const request = Readable.from([bytes]);
  request.method = 'POST';
  request.headers = { 'content-type': 'application/octet-stream', 'x-dsh-offline-import': '1' };
  await importRoute.handler(request, response);
  const body = JSON.parse(response.body);
  assert.equal(response.statusCode, 200);
  assert.equal(body.ok, true);
  assert.equal(body.plugin.name, 'fixture-plugin');
  assert.equal(body.install.application, 'applied');
  const parked = join(root, 'home', 'offline-artifacts', 'imports', 'fixture-plugin-1.0.0-offline.tgz');
  assert.equal(body.artifact, parked);
  assert.equal((await stat(parked)).isFile(), true);
  assert.equal(installs.length, 1);
  assert.equal(installs[0].spec, parked);
});

test('import endpoint refuses markers, media types and foreign tarballs', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-offline-http-import-refuse-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { profileDir, installAnchor } = await createProfile(root);
  const webServer = createWebServer();
  const ctx = createContext(profileDir, installAnchor, webServer);
  const dispose = registerOfflineRoutes(ctx);
  t.after(dispose);
  useHome(t, root);

  const importRoute = webServer.routes.find((item) => item.path.endsWith('/import'));
  const drive = async (input) => {
    const response = createResponse();
    const request = Readable.from([input.bytes]);
    request.method = input.method ?? 'POST';
    request.headers = input.headers ?? {};
    await importRoute.handler(request, response);
    return { response, body: JSON.parse(response.body) };
  };

  const wrongMethod = await drive({ method: 'GET', bytes: Buffer.from('') });
  assert.equal(wrongMethod.response.statusCode, 405);
  assert.equal(wrongMethod.response.headers.allow, 'POST');

  const missingMarker = await drive({ bytes: Buffer.from('x'), headers: { 'content-type': 'application/octet-stream' } });
  assert.equal(missingMarker.response.statusCode, 400);
  assert.equal(missingMarker.body.code, 'missing-import-header');

  const wrongMedia = await drive({ bytes: Buffer.from('x'), headers: { 'content-type': 'application/json', 'x-dsh-offline-import': '1' } });
  assert.equal(wrongMedia.response.statusCode, 415);
  assert.equal(wrongMedia.body.code, 'unsupported-media-type');

  // A plain npm tarball is refused before any install.
  const plain = join(root, 'plain', 'package');
  await writePackage(plain, { name: 'plain-package', version: '1.0.0' }, { 'index.js': 'export {};\n' });
  const plainTarball = join(root, 'plain.tgz');
  await packDirectoryToTarGz({ sourceDir: plain, outFile: plainTarball, prefix: 'package' });
  const foreign = await drive({ bytes: await readFile(plainTarball), headers: { 'content-type': 'application/octet-stream', 'x-dsh-offline-import': '1' } });
  assert.equal(foreign.response.statusCode, 400);
  assert.equal(foreign.body.code, 'not-offline-artifact');

  // Bytes that are not even a readable gzip archive get the same 4xx vocabulary.
  const corrupt = await drive({ bytes: Buffer.from('not-a-tarball'), headers: { 'content-type': 'application/octet-stream', 'x-dsh-offline-import': '1' } });
  assert.equal(corrupt.response.statusCode, 400);
  assert.equal(corrupt.body.code, 'invalid-artifact');
});
