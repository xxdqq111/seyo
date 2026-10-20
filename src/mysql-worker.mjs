/**
 * MySQL 同步桥的 worker 端
 * ==========================================================================
 * 主线程用 Atomics.wait 阻塞等结果，worker 里跑 mysql2 的异步查询。
 * 这样 store.mjs 里几百处 db.prepare(...).get()/run()/all() 都能原样保留，
 * 不用把整个引擎改成 async/await。
 *
 * 协议：
 *   ctrl[0] 主线程置 1 → 有请求
 *   ctrl[1] worker 置 1 → 有响应
 *   ctrl[2]/[3] 请求/响应 JSON 字节长度（UTF-8）
 *   ctrl[4] 响应状态：1 成功 / 0 失败
 */
import { workerData } from 'node:worker_threads';
import mysql from 'mysql2/promise';

const { config, reqSab, respSab, ctrlSab } = workerData;
const ctrl = new Int32Array(ctrlSab);
const reqBuf = new Uint8Array(reqSab);
const respBuf = new Uint8Array(respSab);
const enc = new TextEncoder();
const dec = new TextDecoder();

const conns = new Map();
const SAFE = /^[A-Za-z0-9_]+$/;

function cfgFor(dbName) {
  const c = {
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    charset: 'utf8mb4',
    multipleStatements: true,
    connectTimeout: 8000,
    // 数量都在安全整数内；bigint 让 JSON.stringify 会炸
    supportBigNumbers: false,
  };
  if (dbName) c.database = dbName;
  return c;
}

async function connFor(dbName) {
  const key = dbName || '';
  if (conns.has(key)) return conns.get(key);
  const c = await mysql.createConnection(cfgFor(dbName));
  conns.set(key, c);
  return c;
}

async function dropConn(key) {
  const c = conns.get(key);
  if (!c) return;
  conns.delete(key);
  try { await c.end(); } catch { /* ignore */ }
}

async function handle(msg) {
  const op = msg.op;
  if (op === 'ensureDb') {
    const db = String(msg.db || '');
    if (!SAFE.test(db)) throw new Error('非法数据库名');
    const c = await connFor('');
    await c.query(`CREATE DATABASE IF NOT EXISTS \`${db}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`);
    return { ok: true };
  }
  if (op === 'query' || op === 'exec') {
    const db = msg.db || '';
    if (db && !SAFE.test(db)) throw new Error('非法数据库名');
    const c = await connFor(db);
    try {
      const [rows] = await c.query(msg.sql, msg.params || []);
      return { ok: true, rows };
    } catch (e) {
      await dropConn(db);
      throw e;
    }
  }
  throw new Error(`未知操作 ${op}`);
}

function writeResp(obj) {
  const bytes = enc.encode(JSON.stringify(obj));
  if (bytes.length > respBuf.length) {
    const err = enc.encode(JSON.stringify({ ok: false, error: { message: '查询结果太大，MySQL 同步桥缓冲区装不下', code: 'RESULT_TOO_LARGE' } }));
    respBuf.set(err.subarray(0, Math.min(err.length, respBuf.length)));
    Atomics.store(ctrl, 3, Math.min(err.length, respBuf.length));
    Atomics.store(ctrl, 4, 0);
  } else {
    respBuf.set(bytes);
    Atomics.store(ctrl, 3, bytes.length);
    Atomics.store(ctrl, 4, 1);
  }
  Atomics.store(ctrl, 1, 1);
  Atomics.notify(ctrl, 1);
}

(async () => {
  while (true) {
    // 等主线程放请求
    // eslint-disable-next-line no-await-in-loop
    const w = Atomics.wait(ctrl, 0, 0);
    if (w === 'not-equal') {
      Atomics.store(ctrl, 0, 0);
      const len = Atomics.load(ctrl, 2);
      const msg = JSON.parse(dec.decode(reqBuf.subarray(0, len)));
      try {
        const out = await handle(msg);
        writeResp(out);
      } catch (e) {
        writeResp({ ok: false, error: { message: e.message || String(e), code: e.code || '', errno: e.errno || 0 } });
      }
    }
  }
})();
