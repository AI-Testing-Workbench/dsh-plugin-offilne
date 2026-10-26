/**
 * Render smoke test for the browser half, without a browser.
 *
 * `client.js` is an IIFE-style artifact that calls
 * `window.__ModuleLoader__.load({ id, factory })`; this test captures that
 * registration, runs the factory with a minimal React stub, applies the plugin to
 * a fake Client context (latched slot registrations), and walks the rendered
 * element trees — invoking function components the way a renderer would. That
 * catches import-time and render-path mistakes (missing components, bad props,
 * throwing branches) even though layout and pixels stay unverified.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

/** Minimal React replacement: elements, hooks, and stable callbacks. */
const React = {
  createElement(type, props, ...children) {
    const merged = { ...(props ?? {}) };
    if (children.length === 1) merged.children = children[0];
    else if (children.length > 1) merged.children = children;
    return { type, props: merged };
  },
  useState(initial) {
    return [typeof initial === 'function' ? initial() : initial, () => {}];
  },
  useEffect() {},
  useCallback(fn) {
    return fn;
  },
  useRef(initial) {
    return { current: initial };
  },
};

/** Walk an element tree, invoking function components as a renderer would. */
function render(node, out = []) {
  if (node === null || node === undefined || typeof node === 'boolean') return out;
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node));
    return out;
  }
  if (Array.isArray(node)) {
    for (const child of node) render(child, out);
    return out;
  }
  if (typeof node.type === 'function') {
    render(node.type(node.props ?? {}), out);
    return out;
  }
  render(node.props?.children, out);
  return out;
}

/** Text content of one rendered tree. */
function textOf(node) {
  return render(node).join(' ');
}

/** Walk a tree and hand every host element (not function component) to `visit`. */
function elementsOf(node, visit) {
  if (node === null || node === undefined || typeof node === 'boolean') return;
  if (typeof node === 'string' || typeof node === 'number') return;
  if (Array.isArray(node)) {
    for (const child of node) elementsOf(child, visit);
    return;
  }
  if (typeof node.type === 'function') {
    elementsOf(node.type(node.props ?? {}), visit);
    return;
  }
  visit(node);
  elementsOf(node.props?.children, visit);
}

test('browser half registers both Plugins-page seats and renders them without throwing', async () => {
  let registration;
  globalThis.window = {
    __ModuleLoader__: {
      load(def) {
        registration = def;
      },
    },
  };
  await import('../client.js');
  assert.ok(registration, 'client.js must register itself with the module loader');
  assert.equal(registration.id, 'dsh-plugin-offline');

  const registered = [];
  const fakeLocale = {
    getSnapshot: () => ({ active: 'en', locales: [], revision: 0 }),
    subscribe: () => () => {},
    register: () => () => {},
  };
  const ctx = {
    locale: fakeLocale,
    get(name) {
      if (name === 'locale') return fakeLocale;
      if (name === 'uiWorkspace') return { pickDirectory: async () => undefined };
      return undefined;
    },
    inject(_deps, callback) {
      callback(ctx);
      return () => {};
    },
    effect(callback) {
      const disposer = callback();
      return () => {
        if (typeof disposer === 'function') disposer();
      };
    },
    slots: {
      inject(key, callback) {
        callback();
        return () => {};
      },
      register(options, component) {
        registered.push({ options, component });
        return () => {};
      },
    },
  };

  const plugin = registration.factory((specifier) => {
    if (specifier === 'react') return React;
    throw new Error(`unexpected require(${JSON.stringify(specifier)})`);
  });
  assert.deepEqual(plugin.inject, ['slots']);

  // Only actionable activation outcomes are surfaced; the normal `applied` state
  // adds no text because the success line already says the import worked.
  const translate = (key) => key;
  assert.equal(plugin.__internals.applicationNotice(translate, 'applied'), undefined);
  assert.equal(plugin.__internals.applicationNotice(translate, undefined), undefined);
  assert.equal(plugin.__internals.applicationNotice(translate, ''), undefined);
  assert.deepEqual(plugin.__internals.applicationNotice(translate, 'restart-required'), { text: 'activationRestart', tone: 'warn' });
  assert.deepEqual(plugin.__internals.applicationNotice(translate, 'overridden'), { text: 'activationOverridden', tone: 'warn' });
  assert.deepEqual(plugin.__internals.applicationNotice(translate, 'cancelled'), { text: 'activationCancelled', tone: 'warn' });
  assert.deepEqual(plugin.__internals.applicationNotice(translate, 'failed'), { text: 'activationFailed', tone: 'error' });

  plugin.apply(ctx);

  assert.deepEqual(registered.map((entry) => entry.options.name).sort(), [
    'plugins.detail.actions',
    'plugins.tab',
  ]);
  const detail = registered.find((entry) => entry.options.name === 'plugins.detail.actions');
  const tab = registered.find((entry) => entry.options.name === 'plugins.tab');
  assert.equal(detail.options.id, 'dsh-offline-export');
  assert.equal(tab.options.id, 'dsh-offline-export-tab');
  assert.equal(detail.options.label(), 'Export offline');
  assert.equal(tab.options.label(), 'Import & Export');

  // A non-bundle detail subject is not ours: the seat renders nothing.
  assert.equal(detail.component({ subject: { kind: 'row', pkg: { name: 'x' }, row: {} } }), null);
  assert.equal(detail.component({ subject: { kind: 'item', id: 'official' } }), null);
  // A shipped (not profile-installed) bundle page has nothing to export either.
  assert.equal(detail.component({ subject: { kind: 'bundle', pkg: { name: 'shipped', installed: false } } }), null);

  // An installed bundle shows the export button.
  const detailText = textOf(detail.component({ subject: { kind: 'bundle', pkg: { name: 'dshmarket', installed: true } } }));
  assert.match(detailText, /Export offline/);

  // The tab renders its header, refresh control and the import entry.
  const tabText = textOf(tab.component({ openPackage: () => {}, install: () => {} }));
  assert.match(tabText, /Import and export plugins/);
  assert.match(tabText, /Refresh/);
  assert.match(tabText, /Import an offline plugin/);
  assert.match(tabText, /Choose \.tgz file/);

  // The import result panel must span the row and all text must use theme tokens
  // (no hardcoded colours), which is what the follow-up feedback asked for.
  assert.match(tabText, /\.dsh-offline-import-result\{[^}]*width:100%/);
  assert.match(tabText, /\.dsh-offline-import-result \.dsh-offline-result\{[^}]*text-align:left/);
  assert.doesNotMatch(tabText, /color:#fff/i);
  assert.match(tabText, /font-family:inherit/);
});

test('export resolves the folder picker lazily when uiWorkspace starts after the plugin', async () => {
  let registration;
  globalThis.window = {
    __ModuleLoader__: {
      load(def) {
        registration = def;
      },
    },
  };
  // A query keeps this import separate from the first test's cached module.
  await import('../client.js?late-picker');

  const fakeLocale = {
    getSnapshot: () => ({ active: 'en', locales: [], revision: 0 }),
    subscribe: () => () => {},
    register: () => () => {},
  };
  /** Set only after apply, mirroring a Host that starts ui-workspace later. */
  let picker;
  const registered = [];
  const ctx = {
    locale: fakeLocale,
    get(name) {
      if (name === 'locale') return fakeLocale;
      if (name === 'uiWorkspace') return picker;
      return undefined;
    },
    inject(_deps, callback) {
      callback(ctx);
      return () => {};
    },
    effect(callback) {
      const disposer = callback();
      return () => {
        if (typeof disposer === 'function') disposer();
      };
    },
    slots: {
      inject(key, callback) {
        callback();
        return () => {};
      },
      register(options, component) {
        registered.push({ options, component });
        return () => {};
      },
    },
  };

  const plugin = registration.factory((specifier) => {
    if (specifier === 'react') return React;
    throw new Error(`unexpected require(${JSON.stringify(specifier)})`);
  });

  // The service is absent while apply runs; it must not be captured as absent.
  plugin.apply(ctx);
  picker = { pickDirectory: async () => '/picked/folder' };

  const detail = registered.find((entry) => entry.options.name === 'plugins.detail.actions');
  let exportButton;
  elementsOf(detail.component({ subject: { kind: 'bundle', pkg: { name: 'demo', installed: true } } }), (node) => {
    if (node.type === 'button' && String(node.props['aria-label']).startsWith('Export offline')) exportButton = node;
  });
  assert.ok(exportButton, 'the detail seat renders the export button');

  const originalFetch = globalThis.fetch;
  let request;
  globalThis.fetch = async (url, init) => {
    request = { url, init };
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () => JSON.stringify({ ok: true, result: { artifact: '/picked/folder/demo.tgz', bytes: 42 } }),
    };
  };
  try {
    await exportButton.props.onClick();
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(request.url, '/dsh-offline/api/v1/export');
  assert.deepEqual(JSON.parse(request.init.body), { plugin: 'demo', output: '/picked/folder' });
});
