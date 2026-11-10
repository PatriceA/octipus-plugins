// File access that never follows a link (C1, H1).
//
// Every path that comes from metadata (published.json, marketplace.json, a
// plan, a git tree) is checked by `checkRelPath` before it is joined to
// anything: no `..`, no absolute path, no backslash, no NUL or other control
// character, no empty or `.` segment. The check is on the string alone,
// without realpath, so it cannot be fooled by what is on disk.
//
// Reads (`readFileUnder`) lstat every directory on the way and open the file
// with O_NOFOLLOW, then refuse anything fstat does not call a regular file.
// Writes go through a `SafeDir`: a directory this process created itself
// (fresh, exclusive), whose subdirectories it also created itself, and every
// file is opened O_CREAT|O_EXCL|O_NOFOLLOW, so nothing is ever written
// through a link or over a file someone else put there.
import { closeSync, constants as C, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

export class UnsafePathError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UnsafePathError';
  }
}

const CONTROL = /[\u0000-\u001f\u007f]/;

/**
 * A relative path from metadata, `/`-separated (`a/b.png`). Returns it, or
 * throws UnsafePathError.
 */
export function checkRelPath(p, what = 'path') {
  if (typeof p !== 'string' || p === '') throw new UnsafePathError(`${what}: not a path`);
  const shown = JSON.stringify(p.slice(0, 200));
  if (p.length > 1024) throw new UnsafePathError(`${what} ${shown}: longer than 1024 characters`);
  if (p.includes('\0')) throw new UnsafePathError(`${what} ${shown}: contains NUL`);
  if (CONTROL.test(p)) throw new UnsafePathError(`${what} ${shown}: contains a control character`);
  if (p.includes('\\')) throw new UnsafePathError(`${what} ${shown}: contains a backslash`);
  if (p.startsWith('/') || /^[A-Za-z]:/.test(p)) throw new UnsafePathError(`${what} ${shown}: is absolute`);
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') throw new UnsafePathError(`${what} ${shown}: has an empty or "." segment`);
    if (seg === '..') throw new UnsafePathError(`${what} ${shown}: has a ".." segment`);
  }
  return p;
}

export function isSafeRelPath(p) {
  try { checkRelPath(p); return true; } catch { return false; }
}

/** lstat `root` and each of `segs` under it: every one must be a real directory (never a link). */
function assertRealDirs(root, segs, what) {
  let cur = root;
  const check = (p, shown) => {
    let st;
    try { st = lstatSync(p); } catch (err) {
      if (err.code === 'ENOENT') throw Object.assign(new UnsafePathError(`${what}: ${shown} does not exist`), { code: 'ENOENT' });
      throw err;
    }
    if (st.isSymbolicLink()) throw new UnsafePathError(`${what}: ${shown} is a symbolic link`);
    if (!st.isDirectory()) throw new UnsafePathError(`${what}: ${shown} is not a directory`);
  };
  check(cur, root);
  for (const s of segs) {
    cur = join(cur, s);
    check(cur, cur);
  }
}

/** Read all of an open fd, which fstat said is a regular file of `size` bytes. */
function readAll(fd, size) {
  const buf = Buffer.alloc(size);
  let off = 0;
  while (off < size) {
    const n = readSync(fd, buf, off, size - off, off);
    if (n === 0) break;
    off += n;
  }
  if (off !== size) throw new UnsafePathError('the file changed while it was read');
  return buf;
}

/**
 * Read `root/rel` without following any link: every directory on the way is
 * lstat'ed, the file is opened with O_NOFOLLOW and must be a regular file of
 * at most `maxBytes`. With `optional`, a missing file reads as null.
 */
export function readFileUnder(root, rel, { maxBytes = 64 * 1024 * 1024, encoding, optional = false } = {}) {
  checkRelPath(rel);
  const segs = rel.split('/');
  try {
    assertRealDirs(resolve(root), segs.slice(0, -1), rel);
  } catch (err) {
    if (optional && err.code === 'ENOENT') return null;
    throw err;
  }
  let fd;
  try {
    fd = openSync(join(resolve(root), rel), C.O_RDONLY | C.O_NOFOLLOW | C.O_NONBLOCK);
  } catch (err) {
    if (err.code === 'ELOOP' || err.code === 'EMLINK') throw new UnsafePathError(`${rel} is a symbolic link`);
    if (optional && err.code === 'ENOENT') return null;
    throw err;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new UnsafePathError(`${rel} is not a regular file`);
    if (st.size > maxBytes) throw new UnsafePathError(`${rel} is ${st.size} bytes; at most ${maxBytes}`);
    const buf = readAll(fd, st.size);
    return encoding ? buf.toString(encoding) : buf;
  } finally {
    closeSync(fd);
  }
}

/** Read a file given by an absolute path, refusing a link at the last component and anything not a regular file. */
export function readRegularFile(file, { maxBytes = 64 * 1024 * 1024, encoding } = {}) {
  let fd;
  try {
    fd = openSync(file, C.O_RDONLY | C.O_NOFOLLOW | C.O_NONBLOCK);
  } catch (err) {
    if (err.code === 'ELOOP' || err.code === 'EMLINK') throw new UnsafePathError(`${file} is a symbolic link`);
    throw err;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new UnsafePathError(`${file} is not a regular file`);
    if (st.size > maxBytes) throw new UnsafePathError(`${file} is ${st.size} bytes; at most ${maxBytes}`);
    const buf = readAll(fd, st.size);
    return encoding ? buf.toString(encoding) : buf;
  } finally {
    closeSync(fd);
  }
}

/**
 * Every entry under `root`, as `/`-separated relative paths, refusing any
 * link or special file. `{ files: [{ rel, size, mode }], dirs: [rel] }`.
 */
export function walkRegular(root) {
  const files = [];
  const dirs = [];
  assertRealDirs(resolve(root), [], root);
  const walk = (abs, rel) => {
    for (const name of readdirSync(abs).sort()) {
      const r = rel ? `${rel}/${name}` : name;
      checkRelPath(r);
      const st = lstatSync(join(abs, name));
      if (st.isSymbolicLink()) throw new UnsafePathError(`${r} is a symbolic link`);
      if (st.isDirectory()) { dirs.push(r); walk(join(abs, name), r); } else if (st.isFile()) files.push({ rel: r, size: st.size, mode: st.mode });
      else throw new UnsafePathError(`${r} is not a regular file or directory`);
    }
  };
  walk(resolve(root), '');
  return { files, dirs };
}

/**
 * A directory this process created, and everything under it. Subdirectories
 * are created here (and remembered); a file is written only into one of
 * them, exclusively and without following links.
 */
export class SafeDir {
  /** A new, empty temporary directory. */
  static temp(prefix = 'octipus-') {
    return new SafeDir(mkdtempSync(join(tmpdir(), prefix)), { created: true });
  }

  /** Create `dir` (which must not exist; its parent must) and own it. */
  static create(dir) {
    const abs = resolve(dir);
    mkdirSync(abs, { mode: 0o755 }); // EEXIST when it is there already: never adopt a directory
    return new SafeDir(abs, { created: true });
  }

  constructor(root, { created } = {}) {
    if (!created) throw new Error('SafeDir: use SafeDir.temp() or SafeDir.create()');
    this.root = root;
    this.dirs = new Set(['']);
  }

  path(rel = '') {
    if (rel === '') return this.root;
    checkRelPath(rel);
    return join(this.root, rel);
  }

  /** Create `rel` and its missing parents; each must be one this SafeDir created. */
  mkdir(rel) {
    if (rel === '') return this.root;
    checkRelPath(rel);
    let cur = '';
    for (const seg of rel.split('/')) {
      cur = cur ? `${cur}/${seg}` : seg;
      if (this.dirs.has(cur)) continue;
      try {
        mkdirSync(join(this.root, cur), { mode: 0o755 });
      } catch (err) {
        if (err.code === 'EEXIST') throw new UnsafePathError(`${cur} exists already and was not created by this run`);
        throw err;
      }
      this.dirs.add(cur);
    }
    assertRealDirs(this.root, rel.split('/'), rel);
    return join(this.root, rel);
  }

  /** Write a new file `rel` (its directory is created): O_CREAT|O_EXCL|O_NOFOLLOW. */
  write(rel, data, { mode = 0o644 } = {}) {
    checkRelPath(rel);
    const parts = rel.split('/');
    const parent = parts.slice(0, -1).join('/');
    this.mkdir(parent);
    assertRealDirs(this.root, parent ? parent.split('/') : [], rel);
    const fd = openSync(join(this.root, rel), C.O_WRONLY | C.O_CREAT | C.O_EXCL | C.O_NOFOLLOW, mode);
    try {
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
      let off = 0;
      while (off < buf.length) off += writeSync(fd, buf, off, buf.length - off);
    } finally {
      closeSync(fd);
    }
    return join(this.root, rel);
  }

  /** A child SafeDir for `rel` (created here). */
  sub(rel) {
    this.mkdir(rel);
    const child = new SafeDir(join(this.root, rel), { created: true });
    return child;
  }

  /**
   * Copy the regular files and directories under `srcRoot/srcRel` to
   * `destRel` here. Anything else (a link, a device, a FIFO) stops the copy.
   */
  copyTree(srcRoot, srcRel, destRel) {
    const src = srcRel ? join(resolve(srcRoot), checkRelPath(srcRel)) : resolve(srcRoot);
    if (srcRel) assertRealDirs(resolve(srcRoot), srcRel.split('/'), srcRel);
    const { files, dirs } = walkRegular(src);
    this.mkdir(destRel);
    for (const d of dirs) this.mkdir(destRel ? `${destRel}/${d}` : d);
    for (const f of files) {
      const data = readFileUnder(src, f.rel);
      this.write(destRel ? `${destRel}/${f.rel}` : f.rel, data, { mode: f.mode & 0o111 ? 0o755 : 0o644 });
    }
    return files.length;
  }

  /** Copy one regular file `srcRoot/srcRel` to `destRel`. */
  copyFile(srcRoot, srcRel, destRel, { maxBytes } = {}) {
    const data = readFileUnder(srcRoot, srcRel, { maxBytes });
    return this.write(destRel, data);
  }
}
