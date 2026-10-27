# dsh-plugin-offline — design and contracts

Status: implemented and verified against DSH 0.2.1-rc.2 / pnpm 11.28.5 (Desktop) and pnpm 11.7.0 (CLI).
The sections below are the design as built; the closing section records the implementation
choices that differ from, or refine, the original plan.

## Goal

A DSH profile plugin (`dsh-plugin-offline`) that gives the agent two capabilities:

1. **Export** — pick a plugin (bundle) already installed in the running DSH profile and write one
   `.tgz` artifact that contains the plugin package **plus its whole dependency closure**, so the
   artifact can be installed later on a machine with **no registry/network access**.
2. **Import** — validate such an artifact and install it into the current profile offline through
   the profile's own package-manager path (`ctx.pluginManager.installBundle(...)`), so bundle
   selection, lockfile, HMR activation and version checks all behave like a normal
   `plugin_manager install_bundle` — but without fetching anything.

Additional read-only actions: `list` (which installed bundles can be exported) and `inspect`
(read an artifact's manifest without installing it).

## Verified findings (do not re-research)

Environment facts (checked on this machine, DSH 0.2.0-rc.2, pnpm 11.7.0):

- DSH already supports installing a tarball: `plugin_manager { action: "install_bundle", target:
  "/abs/path/x.tgz" }`. `@deepseek-ai/dsh-plugin-manager` parses an absolute `*.tgz` as
  `{ kind: 'tarball' }` and runs `pnpm add <path>` in the profile directory.
- The desktop profile `/Users/lujs/.dsh/profiles/desktop` uses a **hoisted** pnpm layout:
  `pnpm-workspace.yaml` contains `nodeLinker: hoisted` and `autoInstallPeers: false`. Bundles are
  real directories under `<profile>/node_modules/<name>`; their dependencies are hoisted to
  `<profile>/node_modules/<dep>`.
- pnpm 11 refuses `bundleDependencies` only under the *isolated* linker when packing
  (`ERR_PNPM_BUNDLED_DEPENDENCIES_WITHOUT_HOISTED`). It accepts installing a tarball whose
  `package.json` declares `bundleDependencies` under **hoisted** profiles, and extracts the bundled
  `node_modules` **nested inside the installed package directory**, e.g.
  `<profile>/node_modules/<plugin>/node_modules/js-yaml`.
- That nested layout is exactly what DSH's runtime resolver wants: `dependencyClosure()` in
  `@deepseek-ai/dsh-app-boot` resolves each package's declared dependencies with Node's own
  `node_modules` lookup from the package's real directory, so bundled dependencies are found and
  registered as profile-scope packages. Nested local copies also win over the global name→package
  table for imports made *from inside* the plugin, so version conflicts stay correct.
- `pnpm add --offline --registry http://127.0.0.1:1/ /abs/x.tgz` succeeds for a tarball whose whole
  closure is bundled and whose `package.json` has `bundleDependencies` listing the packages present
  in its `node_modules`. Every declared dependency that is NOT bundled would be fetched from the
  registry, so **export must bundle every resolvable declared dependency**, and remove declared
  dependencies that cannot be resolved (record them as warnings) or the later offline install can
  fail.
- `autoInstallPeers: false` means peer dependencies are not fetched on install, so peers are safe to
  leave declared. DSH's boot check reads `peerDependencies` against the runtime version and may
  skip an incompatible bundle; the import tool should warn on a DSH-runtime mismatch but let the
  profile manager's own check decide.
- `@deepseek-ai/*` packages are supplied by the DSH installation through the runtime resolver
  (`collectInstallationScopePackages`). They must **not** be bundled: bundles get them from the
  running DSH, and bundling them is huge, duplicative and version-risky. Skip every package whose
  name starts with `@deepseek-ai/`; record it in the artifact metadata as runtime-provided.
- Packages installed from a workspace directory (`file:` dependency, e.g. `dsh-pomodoro-bundle`)
  resolve their own dependencies through their real path; the exporter resolves from the realpath
  and bundles them the same way.
- A tarball installed this way keeps the artifact's absolute path as its dependency spec
  (`"<name>": "file:/abs/x.tgz"`), so the artifact must be kept wherever it was imported from.

## Artifact format

One gzipped tar, extension `.tgz`, npm-style layout with a single top-level `package/` directory.
It is a valid npm package tarball with these guarantees:

- `package/package.json` is the plugin's manifest, with:
  - the original `name`/`version` unchanged;
  - `bundleDependencies` (merged with any existing value) listing every package placed directly
    under `package/node_modules/` **and** any package whose manifest declares nested bundles;
  - dependencies that could not be bundled removed from `dependencies` (metadata records them).
- `package/node_modules/<name>/...` holds the flat dependency closure. Version conflicts are nested
  under the package that needs them (`package/node_modules/<parent>/node_modules/<name>`), whose
  own `package.json` then gets the matching `bundleDependencies` entry.
- `package/dsh-offline.json` is the offline manifest (schema below), a plain file at the package
  root (readable by `inspect` without extracting, harmless once installed).
- Every other file of the installed plugin package is copied verbatim (except `node_modules`,
  `.git`, `.DS_Store`, `*.tgz` at any copied package root).

Schema `1` of `dsh-offline.json`:

```jsonc
{
  "schemaVersion": 1,
  "kind": "dsh-offline-plugin",
  "plugin": { "name": "dshmarket", "version": "1.66.45", "description": "…" },
  "target": { "dshVersion": "0.2.0-rc.2", "platform": "darwin", "arch": "arm64", "node": "v22.22.1" },
  "createdAt": "2026-10-25T13:00:00.000Z",
  "source": { "profile": "desktop", "profileDir": "/Users/…/.dsh/profiles/desktop" },
  "format": { "tarball": "npm-package-with-bundled-dependencies", "prefix": "package" },
  "bundle": { "patch": "./cordis.patch.yml", "entries": ["…"] },
  "packages": [ { "name": "js-yaml", "version": "4.3.2", "path": "node_modules/js-yaml", "kind": "dependency", "files": 12, "bytes": 123456 } ],
  "runtimeProvided": [ { "name": "@deepseek-ai/dsh-tools", "requestedBy": "…" } ],
  "notBundled": [ { "name": "fsevents", "reason": "optional dependency not installed on this platform" } ],
  "warnings": ["…"],
  "artifact": { "bytes": 1234567, "sha512": "…" }
}
```

`artifact.sha512` is computed over the finished tarball only if it can be recorded without
recursion; the first implementation may omit it (write `null` or leave the key out) — an external
checksum file is not required.

## Module layout and ownership

| Path | Owner | Purpose |
|---|---|---|
| `src/tar.mjs` | teammate `tar-engine` | gzip+tar writer/reader/extractor, pure Node builtins |
| `test/tar.test.mjs` | teammate `tar-engine` | unit tests for it |
| `src/closure.mjs` | teammate `closure-engine` | package resolution, dependency closure, staging layout |
| `test/closure.test.mjs` | teammate `closure-engine` | unit tests for it |
| `src/profile.mjs` | lead | profile dir + installed-bundle lookup helpers |
| `src/export.mjs` | lead | export pipeline (metadata, closure, tar) |
| `src/verify.mjs` | lead | artifact completeness audit (export-time + `verify` action) |
| `src/import.mjs` | lead | artifact inspection/validation + install via pluginManager |
| `src/tool.mjs` | lead | tool schema + action dispatch |
| `src/http.mjs` | lead | browser endpoints behind the Plugins-page buttons |
| `client.js` | lead | browser half: Import & Export tab + detail-page export button |
| `index.js` | lead | plugin entry (`apply`), approval gate, tool registration |
| `package.json`, `cordis.patch.yml`, `locale/*`, `icon.svg` | lead | bundle/display metadata |
| `README.md`, `README.zh-CN.md` | lead | user documentation |

No runtime npm dependencies. All modules are ESM (`.mjs`, `"type": "module"`), Node >= 20, and must
run under Electron's Node as well (no `node:` APIs beyond fs/path/os/zlib/stream/util/crypto).

## `src/tar.mjs` contract

```js
export class TarFormatError extends Error { code }        // 'too-large' | 'unsupported-entry' | …

/** Write `sourceDir` as a gzipped ustar/pax tarball containing `prefix/`. */
export async function packDirectoryToTarGz({ sourceDir, outFile, prefix = 'package' })
  // -> { file, bytes, fileCount, entries: number }
  // Deterministic: mtime 0, uid/gid 0, uname/gname empty. Files keep their executable bit
  // (mode 0755 when any exec bit is set, else 0644); directories 0755.
  // Long (>100 chars) and non-ASCII names must survive: use the ustar prefix field where it
  // fits and a pax extended header ('x' type) otherwise.
  // Paths inside the tar always use '/' separators.

/** List entries without extracting. */
export async function listTarGz(file)
  // -> [{ path, type: 'file'|'dir'|'symlink'|'other', size, mode }]  // raw paths incl. prefix

/** Read one UTF-8 file entry; stream, stop early. Returns null when absent. */
export async function readTarGzTextEntry(file, entryPath)
  // -> string | null

/** Extract safely into destDir, stripping `prefix` from entry paths. */
export async function extractTarGz({ file, destDir, prefix = 'package' })
  // -> { files, dirs, bytes }
  // Rejects (TarFormatError) absolute paths, paths escaping destDir, NUL bytes, and
  // symlink/hardlink/other entry types. Creates parent dirs; restores mode bits.
```

Streaming is required (artifacts may be hundreds of MB): never read the whole file into one Buffer.

## `src/closure.mjs` contract

```js
/** Node's node_modules lookup paths for modules resolved from `fromDir` (absolute, real). */
export function nodeModulePaths(fromDir) // -> string[]

/** Probe Node's lookup order for a package directory (no exports map needed). */
export function resolvePackageDir(name, fromDir) // -> realpath dir | undefined

/** Read/parse a package.json. */
export function readManifest(dir) // -> object

/**
 * Walk the dependency graph of an installed package.
 * Edges = dependencies ∪ optionalDependencies ∪ resolvable peerDependencies.
 * Skip predicate applies to every edge name (default: skip names starting with '@deepseek-ai/').
 */
export async function collectDependencyClosure({ rootPackageDir, skip })
  // -> {
  //   root:    { name, version, dir, manifest },
  //   instances: Map<dir, Instance>,      // dir = realpath, insertion order = discovery order
  //   skipped:   [{ name, requestedBy, kind }],   // skipped by predicate (runtime-provided)
  //   unresolved:[{ name, requestedBy, kind }],   // declared but not resolvable
  //   warnings:  string[],
  // }
  // Instance = { name, version, dir, manifest,
  //              edges: [{ name, kind: 'dependency'|'optional'|'peer', dir }] }
  // Cycle-safe (a package already visited is linked, never re-walked).

/**
 * Materialize the closure under `<stagingDir>/package/`:
 *  - copy each package's own files (skip node_modules/.git/.DS_Store/*.tgz),
 *  - flat layout under package/node_modules/ with nesting only on version conflicts,
 *  - merge `bundleDependencies` into the root manifest and into every nested bundle owner,
 *  - write `generatedFiles` (e.g. 'dsh-offline.json') at package root,
 *  - strip from root `dependencies` every edge that was not placed (record in result).
 */
export async function stageBundledPackage({ closure, stagingDir, generatedFiles = {}, packageJsonTransform })
  // -> { packageDir, bundleDependencies: string[], placements: [{name, version, path, kind}],
  //      removedDependencies: [{name, reason}], copiedBytes, fileCount, warnings }
```

Rules:

- `stagingDir` is created empty by the caller and may be removed by the caller afterwards.
- Root package files are copied from `closure.root.dir`; modified `package.json` is written over the
  copied one (keep 2-space JSON + trailing newline).
- A dependency instance is hoisted to `package/node_modules/<name>` when that slot is free. When the
  slot already holds a different version, place it at `<declaring package's dir>/node_modules/<name>`
  instead and add its name to that declaring package's `bundleDependencies`.
- Instances are keyed by realpath, so two dependers sharing one physical copy share one placement.
- Symlinks inside package content are followed (copy real content); a symlink cycle must not hang
  the copy (depth guard + warning).
- Copy must not follow `node_modules` into the staging tree; edges are placed by the algorithm only.

## Completeness audit

"Every dependency is inside the artifact" is checked mechanically, not assumed:

`auditPackageDir(packageDir)` walks the bundled tree from the plugin outward with Node's own
`node_modules` lookup (`resolvePackageDir`) and reports:

- **errors** (artifact not self-sufficient): a declared dependency (or bundled copy declared in
  `bundleDependencies`) that has no files in the artifact; a missing bundle patch file; a
  `dsh-offline.json` marker whose plugin identity disagrees with `package.json`.
- **runtime-provided**: declared `@deepseek-ai/*` names with no bundled copy — these come from
  the target DSH installation at load time (both peers and any skipped runtime dependency).
- **optional missing**: optional dependencies that were not installed on the source machine
  (other-platform binaries typically) — information only.
- **peers not bundled**: non-runtime peers that neither resolve in the artifact nor are marked
  optional — a warning that another bundle/runtime must supply them.
- physical/declared `bundleDependencies` cross-checks in both directions, plus package/file/byte
  totals.

Export runs the audit on the staged tree before packing (`verification` in `dsh-offline.json`,
`complete`/`auditErrors`/`auditWarnings` in the result). The same audit is exposed to users as
`plugin_offline { action: "verify", artifact }`, which extracts the tarball to a temp directory
first. `import` warns if an artifact's recorded audit reported problems. Verified on real
artifacts: `dshmarket` → complete, 4 packages / 440 files / 7.7 MB unpacked; `dsh-univer-office`
→ complete, 35 packages / 2,781 files / 334 MB unpacked, 9 runtime-provided peers, 16 expected
other-platform optional absences.

## Web UI

The Plugins page is `@deepseek-ai/dsh-client-ui-plugin-manager`; it declares a family of
extension seats under the `main` keyed panel. The live `Slots.listSubTree` catalog showed
**no per-card action seat** on the installed list itself, so the UI uses the two supported
seats that carry a bundle subject:

- `plugins.tab` — list slot rendered after the page's own Installed tab. Owner props are
  `{ install, openPackage }`; the registration's `label` is a thunk re-read on every
  projection, so it follows the active locale. The tab lists the profile's exportable
  bundles (fetched from the Host), gives each row an export button, and hosts the
  offline-import entry.
- `plugins.detail.actions` — list slot at the head of every detail page, rendered with
  owner props `{ subject }`; the subject is `{ kind: 'bundle', pkg }` for an installed
  package page, `{ kind: 'row', pkg, row }` for a row page, `{ kind: 'item', id }` for an
  official plugin page. The entry renders `null` unless `subject.kind === 'bundle'` and
  `subject.pkg.installed === true`, then draws the same export control.

Bridge: a profile Client plugin has no `host.call` (that is the dynamic-package runner's
bridge) and no generated `ctx.remote` namespace of its own, so the page calls two exact
routes registered on `ctx.webServer` — the same transport `dsh-univer-office` and
`dshmarket` use for plugin-owned endpoints:

- `GET /dsh-offline/api/v1/bundles` → installed bundles, artifact directory, runtime facts.
- `POST /dsh-offline/api/v1/export` with `{ plugin, output? }` → runs the same
  `exportPlugin` pipeline as the tool. Without `output` it writes to the default artifact
  directory. With `output` (the folder picked for this one export) the path must be
  absolute, must already exist, and must be a directory; the artifact file name is still
  chosen by the exporter, so a request can only add one `.tgz` inside a directory the
  person selected — it cannot create arbitrary directories or overwrite unrelated files.
- `POST /dsh-offline/api/v1/import` with an `application/octet-stream` body → streams the
  chosen `.tgz` to a staging file under `<DSH_HOME>/offline-artifacts/imports/` (1 GB cap,
  `x-dsh-offline-import: 1` marker and the octet-stream media type make cross-origin
  simple-request abuse require a preflight), validates it as an offline artifact, parks it
  as `<imports>/<name>-<version>-offline.tgz` (the profile records that path as the
  dependency source), then installs through `pluginManager.installBundle`. A corrupt
  upload is `400 invalid-artifact`, a foreign npm tarball is `400 not-offline-artifact`.
  This is the human's own Plugins-page action — the same authority as the shipped plugin
  manager page's install button — so it installs directly; agent-initiated imports remain
  on the approval-gated tool.

Client details: **each export asks for its folder** — the export button calls the Client
`uiWorkspace.pickDirectory()` service before POSTing, and cancelling the picker aborts that
export (no global folder setting). A Host without a folder picker falls back to the default
artifacts folder after the export and says so in the result line; a picker that fails
reports the error. The import upload uses `XMLHttpRequest` so large artifacts show upload
progress; after a successful import the tab refreshes the bundle list and offers the
owner's `openPackage(name)` to jump to the new plugin's page (the button reads "View plugin details"). The result shows the import
success line and the parked path only — the manager's normal `applied` state is not
spelled out; a pure `applicationNotice(t, application)` mapper surfaces just the actionable
outcomes (`restart-required`, `overridden`, `failed`, `cancelled`) as localized text, and the
render smoke test covers that mapping.

Both buttons show busy/result/error inline and speak through the Client locale service
(`dsh-offline` namespace, `en`/`zh` dictionaries); styles use only `--dsw-alias-*` theme
tokens plus an inline SVG-free button, matching the host's light/dark behavior without
importing any client package.

**Discovery gotcha (learned while verifying):** `dsh-client-modules` caches package
metadata per Loader specifier for the whole process, including the negative "not a client
package" verdict. A package that gains `dsh.client` while its Host is already running is
therefore not picked up until a DSH restart, even though a fresh install (or a restart)
sees it immediately. During development this was verified by clearing the cached entry
through a temporary diagnostic route and republishing the bundle (`clientModules.rebuilt`);
that route was removed from the shipped code, and the live slots stayed registered through
a normal bundle toggle afterwards.

## Lead-owned flow

`export` action:

1. Resolve profile dir and the installed bundle (`ctx.pluginManager.listBundles()`; `installed: true`).
2. Resolve the bundle's package dir via `resolvePackageDir(name, profileDir)`.
3. `collectDependencyClosure` → `stageBundledPackage` in a temp dir → `packDirectoryToTarGz`.
4. Delete temp dir; return artifact path, size, package list, warnings.

`import` action:

1. Read `dsh-offline.json` from the artifact (`readTarGzTextEntry`), validate schema/kind/plugin name.
2. Warn on platform/arch/DSh-version drift; refuse a malformed or unrecognized artifact.
3. Call `ctx.pluginManager.installBundle(absoluteArtifactPath, { enabled })`.
4. Return the manager's ChangeResult plus a short offline-specific summary.

`list` and `inspect` are read-only. Every action returns a JSON string (tool output schema string).

Approval: `import` (profile mutation) must call the same escalation gate as `plugin_manager`
(`approveEscalation` from `@deepseek-ai/dsh-sandbox` with `ctx.sandboxPolicy.resolve(...)` and
`ctx.get('approval')`); refused/cancelled approval throws before installing. `list`, `export`,
`inspect` do not mutate the profile; `export` writes only the artifact file.

## Testing bar

- `node --test test/*.test.mjs` must pass with no network.
- `src/tar.mjs` tests: roundtrip, empty dirs, long path (>100, >255 via pax), unicode names,
  executable bit, path-traversal rejection, prefix stripping, streaming read of a text entry.
- `src/closure.mjs` tests: synthetic package tree in `os.tmpdir()`; flat closure, nested conflict
  (A→B@1, A→C→B@2), cycle, optional missing, `@deepseek-ai/*` skip, unresolvable dependency removal,
  `bundleDependencies` merging, staging copy excludes node_modules.
- Integration (lead): produced artifact installs with
  `pnpm add --offline --registry http://127.0.0.1:1/ <artifact>` in a temp **hoisted** project,
  and `createRequire(.../node_modules/<plugin>/package.json).resolve(<bundled dep>)` finds the
  nested copy.


## Implementation status and refinements

Implemented files: `index.js`, `client.js`,
`src/{tool,http,export,import,verify,profile,closure,tar}.mjs`,
`test/{tar,closure,pipeline,http,client-render,verify}.test.mjs`,
`test/integration/{offline-install,peer-optional}.test.mjs`,
`examples/fixture-plugin`.

Verified:

- `node --test test/*.test.mjs` → 50/50 pass (tar: 10, closure: 19, pipeline: 8, http: 7,
  client render smoke: 2, artifact verify: 4).
- `node --test test/integration/*.test.mjs` → synthetic closure → `.tgz` →
  `pnpm add --offline --registry http://127.0.0.1:1/` in a fresh hoisted project → nested
  copies resolve and the plugin entry executes.
- Live Desktop profile end-to-end: installed `examples/fixture-plugin` via `plugin_manager`
  (`file:` copy), exported with `plugin_offline` (30 KB, `semver` bundled), removed the
  bundle, imported the artifact from a scratch directory with `plugin_offline`, and the
  bundle row remounted live (`Config.listConfigs` shows `include:offline-fixture`,
  `application: applied`); `semver` was **not** present at the profile root and resolved
  only from `node_modules/dsh-offline-fixture/node_modules/semver`. Removed afterwards.
- `dshmarket` artifact: 3 bundled packages (`js-yaml`, `undici`, `argparse`), offline
  install with an **empty** pnpm store succeeds.
- `dsh-univer-office` artifact: 34 packages / ~75 MB, including native bindings
  (`libsql`, Univer rust bindings) and version-conflict nesting
  (`cliui/node_modules/string-width`, `wrap-ansi/node_modules/string-width`); offline
  install with an empty store succeeds in ~1.2 s; `inspect` streams the manifest without
  extracting the archive.
- Intranet peer reproduction and fix: a tarball declaring `@deepseek-ai/cordis` as a peer,
  installed by pnpm with default `autoInstallPeers` and no reachable registry, failed exactly
  like the report (`@deepseek-ai/cordis` fetched as a direct dependency of the profile);
  with the artifact's peer marked optional, `pnpm add --offline --store-dir <empty>` in a
  fresh hoisted project installed only the tarball (no `node_modules/@deepseek-ai`). The
  pnpm-free fallback is covered by the pipeline test (registry failure → materialized install,
  manifest + bundle selection recorded; compatibility refusal → still fails).
- A fresh `DSH_HOME` profile whose only third-party dependency is an artifact composes
  under `dsh --profile <name> --dump-config` with the plugin's row present.
- Web UI: after the Client half was published, `Slots.listSubTree` reported the live
  occupants `plugins.tab` → `dsh-offline-export-tab` and `plugins.detail.actions` →
  `dsh-offline-export`. On the live Desktop web server: bundle listing answered; an export
  went into a chosen folder (`/tmp/dsh-offline-picked/...tgz`, 75 KB) while a relative
  folder was refused `invalid-output`; uploading a synthetic artifact through
  `POST /dsh-offline/api/v1/import` installed it live (`application: "applied"`, bundle row
  mounted, its self-test tool registered) and parked it under
  `<DSH_HOME>/offline-artifacts/imports/`; a corrupt upload was refused `400
  invalid-artifact` and a plain npm tarball `400 not-offline-artifact`. The test bundle and
  parked copies were removed afterwards. Rendered pixels were not captured (no
  browser-control tool in this session), so visual placement is unverified beyond slot
  registration and route behavior.
- Negative paths: unknown bundle (`unknown-plugin`), shipped bundle (`not-exportable`),
  plain npm tarball (`recognized: false` / `not-offline-artifact`), relative paths
  (`invalid-artifact`), approval refusal (`approval-refused`).

Refinements made during implementation:

1. **Runtime version discovery** uses `profileContext.installAnchor` (the DSH app package
   manifest, readable through Electron's asar-aware fs) instead of importing
   `@deepseek-ai/dsh-app-boot`. A `link:`-installed profile plugin is a *linked root* in
   the runtime resolver, so bare imports of shipped packages from it may not resolve
   (depending on declared peers). Reading the anchor keeps the artifact metadata correct
   without that dependency; the dynamic import remains a fallback.
2. **Deselected bundles**: `pluginManager.listBundles()` lists selected bundles only. An
   installed dependency whose bundle layer is switched off is still exportable — the
   exporter falls back to the profile manifest and then validates `dsh.bundle.patch` on
   the resolved package.
3. **Warnings** are de-duplicated in the artifact manifest and capped at 20 in the tool
   result (`warningCount` carries the total); the artifact itself keeps the complete list.
   Heavy plugins otherwise report a long tail of optional-dependency warnings.
4. **Closed-set tool actions** (`list`, `export`, `inspect`, `import`) are registered as a
   raw `ToolDefinition` (JSON Schema parameters) rather than through `defineTool`, keeping
   the plugin free of imports from shipped packages at load time.
5. The approval gate mirrors `plugin_manager` without importing `@deepseek-ai/dsh-sandbox`:
   skip only when `sandboxPolicy.resolve(...).mode === 'danger-full-access'`, otherwise
   ask through `ctx.get('approval').request(...)` and accept only `allowed-once`.
6. The closure engine added a **shadowed-resolution guard**: if hoisting would make a
   requester resolve a different version than the source tree did, it nests one extra copy
   under the requester and warns (seen for `wrap-ansi` with two `string-width` versions).
7. `.tgz` files are excluded from copied package content at any depth; optional
   dependencies for other platforms are reported, not bundled (pnpm never resolves the
   dependencies of bundled packages, so the target stays offline-safe).
8. **Web UI additions** (see the Web UI section): two shipped plugin-manager seats, an
   exact-route bridge on `ctx.webServer`, a folder picker for the export destination, a
   streamed upload entry that installs an artifact as the page user, inline results, and
   locale-driven labels. Agent-initiated imports remain approval-gated on the tool.
9. **Peer dependencies are made optional in the artifact** (intranet fix). Reproduced the
   reported failure locally: a tarball declaring `@deepseek-ai/cordis` as a peer, installed by
   pnpm with the default `autoInstallPeers`, tries to fetch that peer as a direct dependency
   of the profile (`ERR_PNPM_META_FETCH_FAIL`/`ERR_PNPM_FETCH_404`, the exact intranet symptom).
   Adding `peerDependenciesMeta.<peer>.optional = true` to the staged manifest stops the
   install/fetch (verified: empty store + `--offline` + bogus registry installs only the
   tarball, no `node_modules/@deepseek-ai`). DSH's own compatibility check reads
   `peerDependencies` and ignores the meta flag, so `@deepseek-ai/dsh-*` ranges are still
   enforced at load. The names newly marked are recorded in `dsh-offline.json`
   (`peersMadeOptional`) with a warning.
10. **pnpm-free import fallback.** If the profile package manager still fails for a
    registry/network reason (for example the profile's own dependencies cannot be resolved on
    the isolated network), `importArtifact` materializes the artifact's bundled tree directly
    into `<profile>/node_modules/<name>`, records `dependencies[name] = "file:<artifact>"` and
    selects the bundle in `dsh.profile.bundles`, then reports `manual: true` with a warning
    that the lockfile was not updated. An existing install is moved aside and restored on
    failure, and the manifest write is atomic. Compatibility refusals and blocked build
    scripts are never bypassed (`isRegistryInstallFailure` filters them out); the UI shows a
    localized note when the manual path ran.
11. **Install-time lifecycle scripts** (`preinstall`, `install`, `postinstall`) are removed
   from the staged root manifest and recorded as `scriptsRemoved` + a warning. Verified
   with pnpm 11: a tarball whose dependency declares `postinstall` installs with exit 1
   (`ERR_PNPM_IGNORED_BUILDS`) even when every file is bundled, while the same artifact
   with the scripts stripped installs offline with exit 0 and loads. A root `binding.gyp`
   is reported as `nativeBuild: true` because pnpm may still require a build.
