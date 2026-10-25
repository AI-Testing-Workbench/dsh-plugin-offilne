import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { access, chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import {
  TarFormatError,
  extractTarGz,
  listTarGz,
  packDirectoryToTarGz,
  readTarGzTextEntry,
} from '../src/tar.mjs';

const BLOCK = 512;
const ZERO_BLOCK = Buffer.alloc(BLOCK);
const tempDirs = [];

async function makeTempDir() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dsh-tar-test-'));
  tempDirs.push(dir);
  return dir;
}

after(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true }).catch(() => {})));
});

async function writeFixture(root, relativePath, content, mode) {
  const target = path.join(root, relativePath);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content);
  if (mode !== undefined) await chmod(target, mode);
}

/** Relative file/dir lists of a directory tree (symlinks are not used by the fixtures). */
async function walkTree(root) {
  const files = [];
  const dirs = [];
  const visit = async (absDir, relDir) => {
    const dirents = await readdir(absDir, { withFileTypes: true });
    dirents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const dirent of dirents) {
      const rel = relDir === '' ? dirent.name : `${relDir}/${dirent.name}`;
      if (dirent.isDirectory()) {
        dirs.push(rel);
        await visit(path.join(absDir, dirent.name), rel);
      } else {
        files.push(rel);
      }
    }
  };
  await visit(root, '');
  return { files: files.sort(), dirs: dirs.sort() };
}

// ---------------------------------------------------------------------------
// Independent raw-tar reader, used to check the writer's format from outside.
// ---------------------------------------------------------------------------

function parseOctal(block, offset, length) {
  let index = offset;
  const limit = offset + length;
  while (index < limit && (block[index] === 0x20 || block[index] === 0)) index += 1;
  let value = 0;
  while (index < limit) {
    const byte = block[index];
    if (byte < 0x30 || byte > 0x37) break;
    value = value * 8 + (byte - 0x30);
    index += 1;
  }
  return value;
}

function readCString(block, offset, length) {
  let end = offset;
  while (end < offset + length && block[end] !== 0) end += 1;
  return block.toString('utf8', offset, end);
}

function parsePaxRecords(data) {
  const result = {};
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space === -1) break;
    const recordLength = Number.parseInt(data.toString('latin1', offset, space), 10);
    assert.ok(Number.isFinite(recordLength) && recordLength > 0, 'pax record has a positive length');
    const record = data.subarray(space + 1, offset + recordLength);
    const equals = record.indexOf(0x3d);
    assert.ok(equals > 0, 'pax record has key=value form');
    const key = record.toString('latin1', 0, equals);
    let value = record.subarray(equals + 1);
    if (value.length > 0 && value[value.length - 1] === 0x0a) value = value.subarray(0, value.length - 1);
    result[key] = value.toString('utf8');
    offset += recordLength;
  }
  return result;
}

/** Strictly parse an uncompressed tar buffer; asserts checksums/magic and returns entries. */
function parseRawTar(buffer) {
  assert.equal(buffer.length % BLOCK, 0, 'tar stream is block aligned');
  const entries = [];
  let offset = 0;
  let pax = null;
  let paxHeaderName = null;
  while (offset + BLOCK <= buffer.length) {
    const block = buffer.subarray(offset, offset + BLOCK);
    if (block.equals(ZERO_BLOCK)) break;

    const storedChecksum = parseOctal(block, 148, 8);
    let computedChecksum = 0;
    for (let i = 0; i < BLOCK; i += 1) computedChecksum += i >= 148 && i < 156 ? 0x20 : block[i];
    assert.equal(storedChecksum, computedChecksum, 'tar header checksum is valid');
    assert.equal(block.toString('latin1', 257, 263), 'ustar\0', 'ustar magic');
    assert.equal(block.toString('latin1', 263, 265), '00', 'ustar version');

    const typeflag = String.fromCharCode(block[156]) || '0';
    const size = parseOctal(block, 124, 12);
    const name = readCString(block, 0, 100);
    const prefix = readCString(block, 345, 155);
    const data = buffer.subarray(offset + BLOCK, offset + BLOCK + size);
    offset += BLOCK + size + ((BLOCK - (size % BLOCK)) % BLOCK);

    if (typeflag === 'x') {
      pax = parsePaxRecords(data);
      paxHeaderName = name;
      continue;
    }

    entries.push({
      path: pax?.path ?? (prefix === '' ? name : `${prefix}/${name}`),
      typeflag,
      name,
      prefix,
      size,
      data,
      mode: parseOctal(block, 100, 8),
      uid: parseOctal(block, 108, 8),
      gid: parseOctal(block, 116, 8),
      mtime: parseOctal(block, 136, 12),
      uname: readCString(block, 265, 32),
      gname: readCString(block, 297, 32),
      pax: pax ?? undefined,
      paxHeaderName: pax === null ? undefined : paxHeaderName,
    });
    pax = null;
    paxHeaderName = null;
  }
  return entries;
}

// ---------------------------------------------------------------------------
// Independent raw-tar writer, used to build hostile/unusual archives.
// ---------------------------------------------------------------------------

function writeOctal(block, value, offset, length) {
  block.write(value.toString(8).padStart(length - 1, '0'), offset, length - 1, 'latin1');
  block[offset + length - 1] = 0;
}

function makeRawHeader({ name, prefix = '', type = '0', mode = 0o644, size = 0, linkname = '', mtime = 0 }) {
  const block = Buffer.alloc(BLOCK);
  block.write(name, 0, 100, 'latin1');
  writeOctal(block, mode, 100, 8);
  writeOctal(block, 0, 108, 8);
  writeOctal(block, 0, 116, 8);
  writeOctal(block, size, 124, 12);
  writeOctal(block, mtime, 136, 12);
  block.fill(0x20, 148, 156);
  block.write(type, 156, 1, 'latin1');
  block.write(linkname, 157, 100, 'latin1');
  block.write('ustar\0', 257, 6, 'latin1');
  block.write('00', 263, 2, 'latin1');
  block.write(prefix, 345, 155, 'latin1');
  let checksum = 0;
  for (let i = 0; i < BLOCK; i += 1) checksum += block[i];
  block.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'latin1');
  return block;
}

function makePaxRecord(key, value) {
  const body = ` ${key}=${value}\n`;
  const bodyLength = Buffer.byteLength(body, 'utf8');
  let length = bodyLength + 1;
  for (;;) {
    const digits = String(length).length;
    if (digits + bodyLength === length) break;
    length = digits + bodyLength;
  }
  return `${length}${body}`;
}

function padToBlock(buffer) {
  const remainder = buffer.length % BLOCK;
  return remainder === 0 ? buffer : Buffer.concat([buffer, Buffer.alloc(BLOCK - remainder)]);
}

/** Build a gzipped tar from arbitrary entries (payloads may be hostile). */
function buildRawTar(entries) {
  const parts = [];
  for (const entry of entries) {
    if (entry.pax) {
      const paxData = Buffer.concat(entry.pax.map(([key, value]) => Buffer.from(makePaxRecord(key, value), 'utf8')));
      parts.push(makeRawHeader({ name: 'PaxHeaders/entry', type: 'x', size: paxData.length }));
      parts.push(padToBlock(paxData));
    }
    const content = entry.content ?? Buffer.alloc(0);
    parts.push(
      makeRawHeader({
        name: entry.name,
        prefix: entry.prefix,
        type: entry.type,
        mode: entry.mode,
        size: content.length,
        linkname: entry.linkname,
      }),
    );
    if (content.length > 0) parts.push(padToBlock(content));
  }
  parts.push(Buffer.alloc(2 * BLOCK));
  return zlib.gzipSync(Buffer.concat(parts));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('pack → list → extract roundtrip preserves tree, empty dirs, modes and unicode', async () => {
  const dir = await makeTempDir();
  const source = path.join(dir, 'source');
  await mkdir(source, { recursive: true });

  const ustarLongPath = `u-${'a'.repeat(50)}/${'b'.repeat(50)}/file.txt`; // >100, fits ustar prefix
  const paxLongPath = `deep-${'c'.repeat(120)}/${'d'.repeat(120)}/${'e'.repeat(120)}/file.txt`; // >255
  const binary = crypto.randomBytes(4096);
  const fixtures = [
    { file: 'a.txt', content: 'hello\n' },
    { file: 'nested/deep/b.js', content: 'console.log("b");\n' },
    { file: 'bin/run.sh', content: '#!/bin/sh\necho ok\n', mode: 0o755 },
    { file: 'binary.bin', content: binary },
    { file: 'unicode-文件-ü.txt', content: 'héllo 世界\n' },
    { file: ustarLongPath, content: 'ustar-prefix\n' },
    { file: paxLongPath, content: 'pax-long\n' },
  ];
  for (const fixture of fixtures) await writeFixture(source, fixture.file, fixture.content, fixture.mode);
  await mkdir(path.join(source, 'empty-dir', 'nested-empty'), { recursive: true });

  const archive = path.join(dir, 'artifact.tgz');
  const packed = await packDirectoryToTarGz({ sourceDir: source, outFile: archive });
  assert.equal(packed.file, archive);
  assert.ok(packed.bytes > 0);
  assert.equal(packed.fileCount, fixtures.length);

  const listed = await listTarGz(archive);
  const byPath = new Map(listed.map((entry) => [entry.path, entry]));
  assert.equal(byPath.get('package/').type, 'dir');
  assert.equal(byPath.get('package/a.txt').type, 'file');
  assert.equal(byPath.get('package/empty-dir/').type, 'dir');
  assert.equal(byPath.get('package/bin/run.sh').mode, 0o755);
  assert.equal(byPath.get('package/a.txt').mode, 0o644);
  for (const fixture of fixtures) {
    assert.ok(byPath.has(`package/${fixture.file}`), `listing includes ${fixture.file}`);
  }
  assert.ok(!listed.some((entry) => entry.path.includes('PaxHeaders')), 'pax headers are not listed as entries');
  assert.ok(!listed.some((entry) => entry.path.startsWith('package/package/')), 'no duplicated prefix');

  const dest = path.join(dir, 'extracted');
  const extracted = await extractTarGz({ file: archive, destDir: dest });

  assert.equal(extracted.files, fixtures.length);
  const sourceTree = await walkTree(source);
  const destTree = await walkTree(dest);
  assert.deepEqual(destTree.files, sourceTree.files, 'extracted file tree matches');
  assert.deepEqual(destTree.dirs, sourceTree.dirs, 'extracted directory tree matches');
  assert.equal(extracted.dirs, sourceTree.dirs.length);
  assert.equal(
    extracted.bytes,
    fixtures.reduce(
      (total, fixture) => total + Buffer.byteLength(fixture.content, typeof fixture.content === 'string' ? 'utf8' : undefined),
      0,
    ),
  );

  for (const fixture of fixtures) {
    const content = await readFile(path.join(dest, fixture.file));
    if (Buffer.isBuffer(fixture.content)) assert.deepEqual(content, fixture.content);
    else assert.equal(content.toString('utf8'), fixture.content);
  }
  assert.equal((await stat(path.join(dest, 'bin/run.sh'))).mode & 0o777, 0o755, 'exec bit restored');
  assert.equal((await stat(path.join(dest, 'a.txt'))).mode & 0o777, 0o644, 'plain mode restored');
  assert.equal((await stat(path.join(dest, 'empty-dir'))).mode & 0o777, 0o755, 'directory mode restored');
  await assert.rejects(access(path.join(dest, 'package')), 'prefix is stripped from destination paths');

  assert.equal(await readTarGzTextEntry(archive, 'package/unicode-文件-ü.txt'), 'héllo 世界\n');
  assert.equal(await readTarGzTextEntry(archive, 'package/a.txt'), 'hello\n');
  assert.equal(await readTarGzTextEntry(archive, 'package/missing.txt'), null);
});

test('writer emits valid, deterministic ustar/pax headers', async () => {
  const dir = await makeTempDir();
  const source = path.join(dir, 'source');
  const ustarLongPath = `u/${'a'.repeat(50)}/${'b'.repeat(50)}/file.txt`;
  const paxLongPath = `deep/${'c'.repeat(120)}/${'d'.repeat(120)}/${'e'.repeat(120)}/file.txt`;
  const unicodePath = 'unicode-ü-文件.txt';
  await writeFixture(source, 'plain.txt', 'plain\n');
  await writeFixture(source, 'tool.sh', '#!/bin/sh\n', 0o755);
  await writeFixture(source, ustarLongPath, 'ustar\n');
  await writeFixture(source, paxLongPath, 'pax\n');
  await writeFixture(source, unicodePath, 'unicode\n');
  await writeFixture(source, 'sub/child.txt', 'child\n');

  const archiveA = path.join(dir, 'a.tgz');
  const archiveB = path.join(dir, 'b.tgz');
  await packDirectoryToTarGz({ sourceDir: source, outFile: archiveA });
  await packDirectoryToTarGz({ sourceDir: source, outFile: archiveB });
  assert.deepEqual(await readFile(archiveA), await readFile(archiveB), 'packing the same tree twice is byte identical');

  const raw = zlib.gunzipSync(await readFile(archiveA));
  assert.equal(raw.length % BLOCK, 0, 'uncompressed stream is block aligned');
  assert.ok(raw.subarray(raw.length - 2 * BLOCK).equals(Buffer.alloc(2 * BLOCK)), 'stream ends with two zero blocks');

  const entries = parseRawTar(raw);
  const byPath = new Map(entries.map((entry) => [entry.path, entry]));
  const withPrefix = (relative) => `package/${relative}`;

  for (const entry of entries) {
    assert.equal(entry.uid, 0, `${entry.path}: uid is 0`);
    assert.equal(entry.gid, 0, `${entry.path}: gid is 0`);
    assert.equal(entry.mtime, 0, `${entry.path}: mtime is 0`);
    assert.equal(entry.uname, '', `${entry.path}: uname is empty`);
    assert.equal(entry.gname, '', `${entry.path}: gname is empty`);
  }

  const plain = byPath.get(withPrefix('plain.txt'));
  assert.equal(plain.typeflag, '0');
  assert.equal(plain.mode, 0o644);
  assert.equal(plain.pax, undefined, 'short ASCII path does not need pax');

  const tool = byPath.get(withPrefix('tool.sh'));
  assert.equal(tool.mode, 0o755, 'executable bit is preserved');

  const sub = byPath.get(withPrefix('sub/'));
  assert.equal(sub.typeflag, '5');
  assert.equal(sub.mode, 0o755, 'directories are 0755');

  const ustarLong = byPath.get(withPrefix(ustarLongPath));
  assert.ok(ustarLong, 'ustar-prefix path is present');
  assert.equal(ustarLong.pax, undefined, 'path within 100+155 bytes uses ustar prefix, not pax');
  assert.notEqual(ustarLong.prefix, '', 'ustar prefix field is used');
  assert.ok(ustarLong.name.length <= 100 && ustarLong.prefix.length <= 155);

  const paxLong = byPath.get(withPrefix(paxLongPath));
  assert.ok(paxLong, 'pax-path entry is present');
  assert.equal(paxLong.pax?.path, withPrefix(paxLongPath), 'long path is carried by a pax header');
  assert.ok(paxLong.name.length <= 100, 'fallback ustar name fits');
  assert.match(paxLong.paxHeaderName, /^PaxHeaders\//);
  assert.ok(Buffer.byteLength(paxLong.paxHeaderName, 'latin1') <= 100);

  const unicode = byPath.get(withPrefix(unicodePath));
  assert.ok(unicode, 'unicode entry is present');
  assert.equal(unicode.pax?.path, withPrefix(unicodePath), 'non-ASCII path is carried by a pax header (UTF-8)');
  assert.match(unicode.name, /^[\x20-\x7e]*$/, 'fallback header name is ASCII');
  assert.equal(unicode.data.toString('utf8'), 'unicode\n');

  assert.ok(entries.filter((entry) => entry.pax !== undefined).length >= 2, 'pax is used only where required');
});

test('archive is readable and extractable by the system tar (interop)', async (t) => {
  const probe = spawnSync('tar', ['--version'], { encoding: 'utf8' });
  if (probe.error) {
    t.skip('system tar is not available');
    return;
  }

  const dir = await makeTempDir();
  const source = path.join(dir, 'source');
  await writeFixture(source, 'a.txt', 'alpha\n');
  await writeFixture(source, 'nested/b.txt', 'bravo\n');
  await writeFixture(source, 'bin/run.sh', '#!/bin/sh\necho run\n', 0o755);
  await writeFixture(source, 'unicode-文件.txt', 'unicode-content\n');
  const longPath = `long/${'x'.repeat(120)}/${'y'.repeat(120)}/file.txt`;
  await writeFixture(source, longPath, 'long-content\n');

  const archive = path.join(dir, 'artifact.tgz');
  await packDirectoryToTarGz({ sourceDir: source, outFile: archive });

  const expectedPaths = [
    'package/a.txt',
    'package/nested/b.txt',
    'package/bin/run.sh',
    'package/unicode-文件.txt',
    `package/${longPath}`,
  ];
  const listing = spawnSync('tar', ['-tzf', archive], { encoding: 'utf8' });
  assert.equal(listing.status, 0, `tar -tzf failed: ${listing.stderr}`);
  const listedPaths = listing.stdout.split('\n').filter(Boolean);
  for (const expected of expectedPaths) {
    assert.ok(listedPaths.includes(expected), `tar -tzf lists ${expected}\n${listing.stdout}`);
  }

  const outDir = path.join(dir, 'system-extract');
  await mkdir(outDir, { recursive: true });
  const extraction = spawnSync('tar', ['-xzf', archive, '-C', outDir], { encoding: 'utf8' });
  assert.equal(extraction.status, 0, `tar -xzf failed: ${extraction.stderr}`);
  assert.equal(await readFile(path.join(outDir, 'package/a.txt'), 'utf8'), 'alpha\n');
  assert.equal(await readFile(path.join(outDir, 'package/nested/b.txt'), 'utf8'), 'bravo\n');
  assert.equal(await readFile(path.join(outDir, 'package/unicode-文件.txt'), 'utf8'), 'unicode-content\n');
  assert.equal(await readFile(path.join(outDir, 'package', longPath), 'utf8'), 'long-content\n');
  assert.equal(await readFile(path.join(outDir, 'package/bin/run.sh'), 'utf8'), '#!/bin/sh\necho run\n');
  assert.notEqual((await stat(path.join(outDir, 'package/bin/run.sh'))).mode & 0o111, 0, 'system tar restores exec bit');
});

test('readTarGzTextEntry streams and stops before the end of a large archive', async () => {
  const dir = await makeTempDir();
  const source = path.join(dir, 'source');
  await mkdir(source, { recursive: true });
  const targetContent = 'TARGET-CONTENT-✔';
  await writeFixture(source, '000-target.txt', targetContent);
  const block = crypto.randomBytes(1024 * 1024);
  for (let i = 0; i < 6; i += 1) await writeFixture(source, `data/${i}.bin`, block);

  const cleanArchive = path.join(dir, 'large.tgz');
  await packDirectoryToTarGz({ sourceDir: source, outFile: cleanArchive });
  const cleanRaw = zlib.gunzipSync(await readFile(cleanArchive));
  assert.ok(cleanRaw.length >= 5 * 1024 * 1024, 'uncompressed tar is at least 5 MB');
  assert.ok(cleanRaw.subarray(cleanRaw.length - 2 * BLOCK).equals(Buffer.alloc(2 * BLOCK)));

  // The wanted entry is the first file entry of the archive.
  const listed = await listTarGz(cleanArchive);
  const firstFile = listed.find((entry) => entry.type === 'file');
  assert.equal(firstFile.path, 'package/000-target.txt');
  assert.equal(await readTarGzTextEntry(cleanArchive, 'package/000-target.txt'), targetContent);
  assert.equal(await readTarGzTextEntry(cleanArchive, 'package/nope.txt'), null);

  // Replace the end-of-archive marker with a corrupt header block: a reader that parses
  // to the end must fail, so a successful early read proves streaming early-stop.
  const corrupted = Buffer.concat([
    cleanRaw.subarray(0, cleanRaw.length - 2 * BLOCK),
    Buffer.alloc(BLOCK, 0x01),
    ZERO_BLOCK,
    ZERO_BLOCK,
  ]);
  const corruptArchive = path.join(dir, 'corrupt-tail.tgz');
  await writeFile(corruptArchive, zlib.gzipSync(corrupted));

  assert.equal(await readTarGzTextEntry(corruptArchive, 'package/000-target.txt'), targetContent);
  await assert.rejects(
    () => readTarGzTextEntry(corruptArchive, 'package/nope.txt'),
    (err) => err instanceof TarFormatError && err.code === 'invalid-header',
    'searching for an absent entry forces a full parse and hits the corrupt tail',
  );
  await assert.rejects(
    () => listTarGz(corruptArchive),
    (err) => err instanceof TarFormatError && err.code === 'invalid-header',
  );
});

test('extractTarGz rejects traversal, absolute paths, NUL bytes and special entries', async () => {
  const dir = await makeTempDir();
  const cases = [
    {
      label: 'parent traversal',
      entries: [{ name: 'package/../escape.txt', content: Buffer.from('owned') }],
      code: 'unsafe-path',
    },
    {
      label: 'nested traversal',
      entries: [{ name: 'package/a/../../escape.txt', content: Buffer.from('owned') }],
      code: 'unsafe-path',
    },
    {
      label: 'absolute path',
      entries: [{ name: '/tmp/escape.txt', content: Buffer.from('owned') }],
      code: 'unsafe-path',
    },
    {
      label: 'entry outside prefix',
      entries: [{ name: 'other/file.txt', content: Buffer.from('owned') }],
      code: 'unsafe-path',
    },
    {
      label: 'NUL byte in pax path',
      entries: [{ pax: [['path', 'package/bad\0name.txt']], name: 'fallback.txt', content: Buffer.from('x') }],
      code: 'unsafe-path',
    },
    {
      label: 'traversal via pax path',
      entries: [{ pax: [['path', 'package/../pax-escape.txt']], name: 'fallback.txt', content: Buffer.from('x') }],
      code: 'unsafe-path',
    },
    {
      label: 'windows-style traversal',
      entries: [{ name: 'package/a\\..\\..\\escape.txt', content: Buffer.from('owned') }],
      code: 'unsafe-path',
    },
    {
      label: 'symlink entry',
      entries: [{ name: 'package/link', type: '2', linkname: 'package/a.txt' }],
      code: 'unsupported-entry',
    },
    {
      label: 'hardlink entry',
      entries: [{ name: 'package/link', type: '1', linkname: 'package/a.txt' }],
      code: 'unsupported-entry',
    },
    {
      label: 'fifo entry',
      entries: [{ name: 'package/fifo', type: '6' }],
      code: 'unsupported-entry',
    },
  ];

  for (const [index, testCase] of cases.entries()) {
    const archive = path.join(dir, `hostile-${index}.tgz`);
    await writeFile(archive, buildRawTar(testCase.entries));
    const dest = path.join(dir, `dest-${index}`);
    await assert.rejects(
      () => extractTarGz({ file: archive, destDir: dest }),
      (err) => {
        assert.ok(err instanceof TarFormatError, `${testCase.label}: expected TarFormatError, got ${err}`);
        assert.equal(err.code, testCase.code, `${testCase.label}: code`);
        return true;
      },
      testCase.label,
    );
    await assert.rejects(access(path.join(dir, 'escape.txt')), `${testCase.label}: nothing escaped`);
    await assert.rejects(access(path.join(dir, 'other')), `${testCase.label}: no out-of-prefix dir`);
  }

  const symlinkArchive = path.join(dir, 'symlink.tgz');
  await writeFile(
    symlinkArchive,
    buildRawTar([
      { name: 'package/link', type: '2', linkname: 'package/a.txt' },
      { name: 'package/a.txt', content: Buffer.from('a') },
    ]),
  );
  const listed = await listTarGz(symlinkArchive);
  assert.equal(listed.find((entry) => entry.path === 'package/link').type, 'symlink');
});

test('listTarGz on an empty archive returns no entries', async () => {
  const dir = await makeTempDir();
  const archive = path.join(dir, 'empty.tgz');
  await writeFile(archive, zlib.gzipSync(Buffer.concat([ZERO_BLOCK, ZERO_BLOCK])));
  assert.deepEqual(await listTarGz(archive), []);
  assert.equal(await readTarGzTextEntry(archive, 'package/nope.txt'), null);
  assert.deepEqual(await extractTarGz({ file: archive, destDir: path.join(dir, 'empty-out') }), {
    files: 0,
    dirs: 0,
    bytes: 0,
  });
});

test('extractTarGz creates missing parents for file-only archives', async () => {
  const dir = await makeTempDir();
  const archive = path.join(dir, 'flat.tgz');
  await writeFile(archive, buildRawTar([{ name: 'package/a/b/c.txt', content: Buffer.from('deep') }]));
  const dest = path.join(dir, 'out');
  const result = await extractTarGz({ file: archive, destDir: dest });
  assert.deepEqual(result, { files: 1, dirs: 0, bytes: 4 });
  assert.equal(await readFile(path.join(dest, 'a/b/c.txt'), 'utf8'), 'deep');
});

test('custom prefix is used when packing and stripped when extracting', async () => {
  const dir = await makeTempDir();
  const source = path.join(dir, 'source');
  await writeFixture(source, 'x/y.txt', 'yo\n');
  const archive = path.join(dir, 'custom.tgz');
  await packDirectoryToTarGz({ sourceDir: source, outFile: archive, prefix: 'bundle/' });

  const listed = await listTarGz(archive);
  assert.ok(listed.every((entry) => entry.path === 'bundle/' || entry.path.startsWith('bundle/')), JSON.stringify(listed));
  assert.ok(!listed.some((entry) => entry.path.startsWith('package/')));

  const dest = path.join(dir, 'out');
  const result = await extractTarGz({ file: archive, destDir: dest, prefix: 'bundle' });
  assert.equal(result.files, 1);
  assert.equal(await readFile(path.join(dest, 'x/y.txt'), 'utf8'), 'yo\n');

  // Entries outside the configured prefix are refused rather than silently relocated.
  await assert.rejects(
    () => extractTarGz({ file: archive, destDir: path.join(dir, 'wrong-prefix'), prefix: 'package' }),
    (err) => err instanceof TarFormatError && err.code === 'unsafe-path',
  );
});

test('extractTarGz refuses to write through pre-existing symlinked directories', async () => {
  const dir = await makeTempDir();
  const outside = path.join(dir, 'outside');
  const dest = path.join(dir, 'dest');
  await mkdir(outside, { recursive: true });
  await mkdir(dest, { recursive: true });
  await symlink(outside, path.join(dest, 'link'));

  const archive = path.join(dir, 'planted.tgz');
  await writeFile(archive, buildRawTar([{ name: 'package/link/pwned.txt', content: Buffer.from('owned') }]));
  await assert.rejects(
    () => extractTarGz({ file: archive, destDir: dest }),
    (err) => err instanceof TarFormatError && err.code === 'unsafe-path',
  );
  await assert.rejects(access(path.join(outside, 'pwned.txt')), 'nothing written through the planted symlink');
});

test('packDirectoryToTarGz rejects a non-directory source', async () => {
  const dir = await makeTempDir();
  const file = path.join(dir, 'file.txt');
  await writeFile(file, 'x');
  await assert.rejects(
    () => packDirectoryToTarGz({ sourceDir: file, outFile: path.join(dir, 'out.tgz') }),
    (err) => err instanceof TarFormatError && err.code === 'unsupported-entry',
  );
});
