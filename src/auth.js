'use strict';

const crypto = require('node:crypto');
const { randomUUID } = crypto;
const store = require('../db');
const { sendJson } = require('./http');

// ---------------------------------------------------------------- 鉴权（用户账号）
// 签名 token（HMAC，密钥持久化在 settings）：
//   旧实现是内存 Map → 服务一重启所有登录态就失效，做不到「勾记住密码后 30 天免登录」。
//   现在 token 自带过期时间且可离线校验签名，重启后仍然有效；登出走内存黑名单（本机工具够用）。
// 一账号单设备在线：token 另带用户当前的「登录世代号」（users.token_epoch），
//   登录 / 登出 / 改密各 +1 —— 此前签发的 token 世代号对不上即失效（改密踢下线同此机制）；
//   世代号落库，重启服务也不会让旧 token 复活。
const TOKEN_TTL = 24 * 60 * 60 * 1000;                       // 默认：1 天
const TOKEN_TTL_REMEMBER = 30 * 24 * 60 * 60 * 1000;         // 勾了「记住密码」：30 天
const revokedTokens = new Set();                             // 已登出的 token 摘要（内存，作即时兜底）
const REVOKED_MAX = 2000;                                    // 上限：登出的权威机制是落库的世代号，这里只是即时兜底

// 登录时序防枚举：账号不存在时也执行一次同参数的 scrypt。
// 否则“不存在”立即返回、“存在但密码错”要跑 scrypt，响应时间差足以枚举账号。
const DUMMY_PASSWORD_ROW = (() => {
  const salt = crypto.randomBytes(16).toString('hex');
  return { salt, pass_hash: crypto.scryptSync('timing-equalizer-placeholder', salt, 64).toString('hex') };
})();

function tokenSecret() {
  let secret = store.getSetting('auth_secret');
  if (!secret) {
    secret = randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '');
    store.setSetting('auth_secret', secret);
  }
  return secret;
}
function tokenDigest(token) {
  return crypto.createHmac('sha256', tokenSecret()).update(String(token)).digest('base64url');
}
function issueToken(user, ttlMs = TOKEN_TTL) {
  // v = 签发时的登录世代号：任何一次登录 / 登出 / 改密都会使它过期（见文件头注释）
  const payload = Buffer.from(JSON.stringify({ uid: user.id, u: user.username, v: store.getTokenEpoch(user.id), exp: Date.now() + ttlMs }), 'utf8').toString('base64url');
  return `${payload}.${tokenDigest(payload)}`;
}
// 校验：签名正确 + 未过期 + 未被登出
function readToken(token) {
  const str = String(token || '').trim();
  const dot = str.lastIndexOf('.');
  if (dot <= 0) return null;
  const payload = str.slice(0, dot);
  const sig = str.slice(dot + 1);
  const expect = tokenDigest(payload);
  if (sig.length !== expect.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return null;
  if (revokedTokens.has(payload)) return null;
  try {
    const obj = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!obj || !obj.uid || !(Number(obj.exp) > Date.now())) return null;
    return obj;
  } catch {
    return null;
  }
}

function revokeToken(token) {
  const str = String(token || '').trim();
  const dot = str.lastIndexOf('.');
  if (dot <= 0) return;
  // Set 保持插入序：满了就先淘汰最早的一条，否则登出条目只增不减会一直吃内存
  if (revokedTokens.size >= REVOKED_MAX) {
    const oldest = revokedTokens.values().next().value;
    if (oldest !== undefined) revokedTokens.delete(oldest);
  }
  revokedTokens.add(str.slice(0, dot));
}

// 返回当前登录用户；未登录 / 过期 / 被其他设备顶下线则已发送 401 并返回 null
function requireUser(req, res) {
  const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  const hit = readToken(token);
  if (!hit) {
    sendJson(res, 401, { error: 'unauthorized', message: '登录已失效，请重新登录' });
    return null;
  }
  const user = store.getUser(hit.uid);
  if (!user) {
    revokeToken(token);
    sendJson(res, 401, { error: 'unauthorized', message: '账号不存在，请重新登录' });
    return null;
  }
  // 一账号单设备：世代号对不上 = 已在别处登录 / 已登出 / 已改密，本设备即刻下线
  if (Number(hit.v) !== store.getTokenEpoch(user.id)) {
    sendJson(res, 401, { error: 'kicked', message: '该账号已在其他设备登录或已修改密码，本设备登录已失效' });
    return null;
  }
  return user;
}

function requireAdmin(req, res) {
  const user = requireUser(req, res);
  if (!user) return null;
  if (user.role !== 'admin') {
    sendJson(res, 403, { error: 'forbidden', message: '需要管理员权限' });
    return null;
  }
  return user;
}

// 数据按创建者完全隔离：每个账号（含管理员）只能看到和操作自己创建的实验 / 问卷
function canAccess(user, row) {
  return !!row && row.owner_id === user.id;
}

// 登录态用户体：账号信息 + 智能助手展示配置（管理端「个人设置」回显用）
function authUserPayload(user) {
  const assistant = store.getAssistantConfig(user.id);
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    avatar: user.avatar || '',
    assistantAvatar: assistant.avatar,
    assistantName: assistant.name
  };
}

module.exports = {
  TOKEN_TTL,
  TOKEN_TTL_REMEMBER,
  DUMMY_PASSWORD_ROW,
  issueToken,
  readToken,
  revokeToken,
  requireUser,
  requireAdmin,
  canAccess,
  authUserPayload
};
