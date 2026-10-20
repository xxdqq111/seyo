/**
 * MySQL 同步桥（主线程）
 * ==========================================================================
 * 原来的 store.mjs 是按 SQLite 的同步 API 写的（db.prepare(...).get() 到处是）。
 * MySQL 驱动只有异步 API，直接改会把引擎、服务端、测试全掀翻。
 * 折中：起一个 worker，用 Atomics.wait 把异步查询等成同步调用；
 * 这样 store.mjs 只换底层 db 对象，上层一行不用动。
 *
 * 账号隔离：每个账号一个独立数据库（seyo_u_<id>）。
 * 当前账号放 AsyncLocalStorage，服务端每个请求进来时用 withDb() 包一下。
 */
import fs from 'node:fs';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { AsyncLocalStorage } from 'node:async_hooks';
import { DATA_DIR } from './util.mjs';
import { MASTER_SCHEMA, ACCOUNT_SCHEMA } from './mysql-schema.mjs';

const CFG_FILE = path.join(DATA_DIR, 'mysql.json');

function readConfig() {
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(CFG_FILE, 'utf8')); } catch { /* 第一次跑，没文件 */ }
  const env = process.env;
  return {
    host: env.SEYO_MYSQL_HOST || saved.host || '127.0.0.1',
    port: Number(env.SEYO_MYSQL_PORT || saved.port || 3306),
    user: env.SEYO_MYSQL_USER || saved.user || 'root',
    password: env.SEYO_MYSQL_PASSWORD ?? saved.password ?? '123456',
    database: env.SEYO_MYSQL_DB || saved.database || 'seyo',
    prefix: env.SEYO_MYSQL_PREFIX || saved.prefix || 'seyo_u_',
  };
}

const config = readConfig();
const MASTER_DB = config.database;
const DEFAULT_ACCOUNT = process.env.SEYO_MYSQL_ACCOUNT || 'seyo_default';
const als = new AsyncLocalStorage();

/* ---------------- SharedArrayBuffer 同步协议 ---------------- */
const reqSab = new SharedArrayBuffer(1 * 1024 * 1024);
const respSab = new SharedArrayBuffer(16 * 1024 * 1024);
const ctrlSab = new SharedArrayBuffer(64);
const ctrl = new Int32Array(ctrlSab);
const reqView = new Uint8Array(reqSab);
const respView = new Uint8Array(respSab);
const enc = new TextEncoder();
const dec = new TextDecoder();

const worker = new Worker(new URL('./mysql-worker.mjs', import.meta.url), {
  workerData: { config, reqSab, respSab, ctrlSab },
});
// 测试脚本/命令行工具用完能正常退出；HTTP 服务本身有 server 撑住事件循环。
worker.unref();

function call(req) {
  const bytes = enc.encode(JSON.stringify(req));
  if (bytes.length > reqView.length) throw new Error('MySQL 请求太大');
  reqView.set(bytes);
  Atomics.store(ctrl, 2, bytes.length);
  Atomics.store(ctrl, 1, 0);
  Atomics.store(ctrl, 0, 1);
  Atomics.notify(ctrl, 0);
  const w = Atomics.wait(ctrl, 1, 0, 30000);
  if (w === 'timed-out') throw new Error('MySQL 查询超时（30 秒）');
  const len = Atomics.load(ctrl, 3);
  const ok = Atomics.load(ctrl, 4) === 1;
  Atomics.store(ctrl, 1, 0);
  const out = JSON.parse(dec.decode(respView.subarray(0, len)));
  if (!ok || !out.ok) {
    const e = new Error(out?.error?.message || 'MySQL 查询失败');
    e.code = out?.error?.code || '';
    e.errno = out?.error?.errno || 0;
    throw e;
  }
  return out.rows;
}

function safeDb(name) {
  const n = String(name || '');
  if (!/^[A-Za-z0-9_]+$/.test(n)) throw new Error('非法数据库名：' + n);
  return n;
}

let masterReady = false;
function ensureMaster() {
  if (masterReady) return;
  call({ op: 'ensureDb', db: MASTER_DB });
  call({ op: 'exec', db: MASTER_DB, sql: MASTER_SCHEMA.join(';\n') });
  masterReady = true;
}

const accountReady = new Set();
export function ensureAccountDb(name) {
  const db = safeDb(name);
  if (accountReady.has(db)) return db;
  call({ op: 'ensureDb', db });
  call({ op: 'exec', db, sql: ACCOUNT_SCHEMA.join(';\n') });
  accountReady.add(db);
  return db;
}

export function accountDbName(userId = '') {
  const id = String(userId || '').replace(/[^A-Za-z0-9_]/g, '');
  return safeDb(config.prefix + (id || 'default'));
}

export function currentDbName() {
  return als.getStore()?.db || DEFAULT_ACCOUNT;
}

/** 在这个账号的数据库上下文里执行（支持 async，await 后上下文仍在） */
export function withDb(dbName, fn) {
  return als.run({ db: safeDb(dbName) }, fn);
}

/* ---------------- SQL 兼容翻译（SQLite → MySQL） ---------------- */
export function translateSql(sql = '') {
  let s = String(sql);
  // 5 处 ON CONFLICT (...) DO UPDATE SET ... → ON DUPLICATE KEY UPDATE ...
  s = s.replace(/ON\s+CONFLICT\s*\([^)]*\)\s*DO\s+UPDATE\s+SET\s+/i, 'ON DUPLICATE KEY UPDATE ');
  s = s.replace(/\bexcluded\.(\w+)/g, 'VALUES($1)');
  s = s.replace(/INSERT\s+OR\s+IGNORE\s+INTO/i, 'INSERT IGNORE INTO');
  s = s.replace(/INSERT\s+OR\s+REPLACE\s+INTO/i, 'REPLACE INTO');
  return s;
}

const isWrite = (sql) => /^\s*(INSERT|UPDATE|DELETE|REPLACE)\b/i.test(sql);

/** 当前账号库名（确保库和表已经建好） */
function current() {
  const name = currentDbName();
  ensureAccountDb(name);
  return name;
}

/* ---------------- 对外 db 对象（兼容 SQLite 的 prepare/exec） ---------------- */
export const db = {
  prepare(sql) {
    const text = translateSql(sql);
    return {
      run(...params) {
        const raw = call({ op: 'query', db: current(), sql: text, params });
        const header = Array.isArray(raw) ? raw[raw.length - 1] : raw;
        return { changes: Number(header?.affectedRows || 0), lastInsertRowid: Number(header?.insertId || 0) };
      },
      get(...params) {
        const raw = call({ op: 'query', db: current(), sql: text, params });
        return Array.isArray(raw) ? raw[0] : undefined;
      },
      all(...params) {
        const raw = call({ op: 'query', db: current(), sql: text, params });
        return Array.isArray(raw) ? raw : [];
      },
    };
  },
  exec(sql) {
    return call({ op: 'exec', db: current(), sql: translateSql(sql) });
  },
  /** SQLite PRAGMA table_info 的替代 */
  columns(table) {
    const name = String(table || '');
    if (!/^[A-Za-z0-9_]+$/.test(name)) return [];
    const raw = call({
      op: 'query',
      db: current(),
      sql: 'SELECT COLUMN_NAME AS name FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ?',
      params: [name],
    });
    return Array.isArray(raw) ? raw : [];
  },
};

/* ---------------- 主库 / 测试 用的显式查询 ---------------- */
export function masterQuery(sql, params = []) {
  ensureMaster();
  return call({ op: 'query', db: MASTER_DB, sql: translateSql(sql), params });
}

export function queryIn(dbName, sql, params = []) {
  const db = safeDb(dbName);
  ensureAccountDb(db);
  return call({ op: 'query', db, sql: translateSql(sql), params });
}

export function execIn(dbName, sql) {
  const db = safeDb(dbName);
  ensureAccountDb(db);
  return call({ op: 'exec', db, sql: translateSql(sql) });
}

export const DB_LABEL = `mysql://${config.host}:${config.port}/${MASTER_DB}`;
export { config as mysqlConfig, MASTER_DB, DEFAULT_ACCOUNT, isWrite };
