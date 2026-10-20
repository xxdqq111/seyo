/**
 * 注册 / 登录 / 会话
 * ==========================================================================
 * MySQL 主库（默认 seyo）里只放 users / sessions 两张表；
 * 每个账号一个独立数据库（seyo_u_<id>），里面是这位老人自己的全部数据。
 *
 * 密码用 scrypt + 每人一个 salt，存的是 hex；不存明文。
 * 登录成功发一个随机 token，写 HttpOnly Cookie（服务端 sessions 表可查、可过期）。
 */
import crypto from 'node:crypto';
import { masterQuery, ensureAccountDb, accountDbName } from './mysql.mjs';

const SESSION_MS = 30 * 24 * 3600 * 1000;
const USER_RE = /^[\u4e00-\u9fa5A-Za-z0-9_]{2,20}$/;

const hashCode = (password, salt) => crypto.scryptSync(String(password), String(salt), 64).toString('hex');
const newToken = () => crypto.randomBytes(32).toString('hex');

export function initAuth() {
  masterQuery('SELECT 1 AS ok');
  // 顺手清掉过期会话，别越攒越多
  try { masterQuery('DELETE FROM sessions WHERE expires < ?', [Date.now()]); } catch { /* ignore */ }
}

function publicUser(row) {
  return row && { id: row.id, username: row.username };
}

function makeSession(user) {
  const token = newToken();
  const now = Date.now();
  masterQuery(
    'INSERT INTO sessions (token, user_id, account_db, expires, created_at) VALUES (?,?,?,?,?)',
    [token, user.id, user.account_db, now + SESSION_MS, now],
  );
  return token;
}

export function register(username = '', password = '') {
  const name = String(username || '').trim();
  const pass = String(password || '');
  if (!USER_RE.test(name)) return { ok: false, error: '用户名 2–20 个字，只能用中文、字母、数字、下划线' };
  if (pass.length < 6 || pass.length > 72) return { ok: false, error: '密码至少 6 位' };

  const exists = masterQuery('SELECT id FROM users WHERE username = ?', [name]);
  if (exists.length) return { ok: false, error: '这个用户名已经注册过了' };

  const id = 'u' + crypto.randomBytes(12).toString('hex');
  const salt = crypto.randomBytes(16).toString('hex');
  const passHash = hashCode(pass, salt);
  const account = accountDbName(id);
  try {
    masterQuery(
      'INSERT INTO users (id, username, pass_hash, salt, created_at) VALUES (?,?,?,?,?)',
      [id, name, passHash, salt, Date.now()],
    );
  } catch (e) {
    if (String(e.code) === 'ER_DUP_ENTRY') return { ok: false, error: '这个用户名已经注册过了' };
    throw e;
  }
  // 建这个账号自己的库和表
  ensureAccountDb(account);
  const token = makeSession({ id, username: name, account_db: account });
  return { ok: true, token, user: { id, username: name } };
}

export function login(username = '', password = '') {
  const name = String(username || '').trim();
  const pass = String(password || '');
  if (!name || !pass) return { ok: false, error: '请输入用户名和密码' };
  const rows = masterQuery('SELECT * FROM users WHERE username = ?', [name]);
  const user = rows[0];
  if (!user) return { ok: false, error: '用户名或密码不对' };
  const got = hashCode(pass, user.salt);
  const want = String(user.pass_hash || '');
  let same = false;
  try { same = got.length === want.length && crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want)); } catch { same = false; }
  if (!same) return { ok: false, error: '用户名或密码不对' };
  const account = user.account_db || accountDbName(user.id);
  ensureAccountDb(account);
  const token = makeSession({ id: user.id, username: user.username, account_db: account });
  return { ok: true, token, user: publicUser(user) };
}

export function sessionOf(token = '') {
  if (!token) return null;
  const rows = masterQuery(
    'SELECT s.token, s.account_db, s.expires, u.id AS user_id, u.username FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?',
    [String(token)],
  );
  const row = rows[0];
  if (!row) return null;
  if (Number(row.expires) < Date.now()) {
    try { masterQuery('DELETE FROM sessions WHERE token = ?', [String(token)]); } catch { /* ignore */ }
    return null;
  }
  return { token: row.token, accountDb: row.account_db, userId: row.user_id, username: row.username };
}

export function logout(token = '') {
  if (!token) return;
  try { masterQuery('DELETE FROM sessions WHERE token = ?', [String(token)]); } catch { /* ignore */ }
}

/** 改密码：校验旧密码 → 换新 salt/hash → 踢掉其它设备上的会话（保留当前这个） */
export function changePassword(userId = '', oldPassword = '', newPassword = '', keepToken = '') {
  const oldPass = String(oldPassword || '');
  const newPass = String(newPassword || '');
  if (newPass.length < 6 || newPass.length > 72) return { ok: false, error: '新密码至少 6 位' };
  if (oldPass === newPass) return { ok: false, error: '新密码不能和旧密码一样' };
  const rows = masterQuery('SELECT * FROM users WHERE id = ?', [String(userId)]);
  const user = rows[0];
  if (!user) return { ok: false, error: '账号不存在' };
  const got = hashCode(oldPass, user.salt);
  const want = String(user.pass_hash || '');
  let same = false;
  try { same = got.length === want.length && crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want)); } catch { same = false; }
  if (!same) return { ok: false, error: '旧密码不对' };
  const salt = crypto.randomBytes(16).toString('hex');
  masterQuery('UPDATE users SET pass_hash = ?, salt = ? WHERE id = ?', [hashCode(newPass, salt), salt, user.id]);
  // 其它设备上的会话全部失效；当前设备继续用
  if (keepToken) masterQuery('DELETE FROM sessions WHERE user_id = ? AND token <> ?', [user.id, String(keepToken)]);
  else masterQuery('DELETE FROM sessions WHERE user_id = ?', [user.id]);
  return { ok: true };
}

export function userCount() {
  try { return Number(masterQuery('SELECT COUNT(*) c FROM users')[0]?.c || 0); } catch { return 0; }
}
