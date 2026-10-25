# dsh-offline-fixture

A disposable profile bundle used by the end-to-end test in this repository:

1. `plugin_manager { action: "install_bundle", target: "file:<this directory>" }`
2. `plugin_offline { action: "export", plugin: "dsh-offline-fixture" }`
3. `plugin_manager { action: "remove_bundle", target: "dsh-offline-fixture" }`
4. `plugin_offline { action: "import", artifact: "<artifact>" }`

It imports `semver` — deliberately not installed at the profile root by this repository's
own dependencies — and registers the `offline_fixture_ping` tool. The tool appearing and
answering after step 4 proves that an offline-imported bundle loaded *and* resolved its
bundled dependency from the artifact's nested `node_modules`.

Do not publish this package; it exists only for verification.
