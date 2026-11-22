'use strict';

const store = require('../../db');
const { sendJson, readJsonBody } = require('../http');
const { ALLOW_REGISTRATION } = require('../config');
const {
  TOKEN_TTL,
  TOKEN_TTL_REMEMBER,
  DUMMY_PASSWORD_ROW,
  issueToken,
  readToken,
  revokeToken,
  requireUser,
  authUserPayload
} = require('../auth');
const { rateHit, rejectRateLimited } = require('../rate-limit');

async function handleRegister(req, res) {
  if (!ALLOW_REGISTRATION) {
    return sendJson(res, 403, { error: 'registration_closed', message: '注册已关闭，请联系管理员开通账号' });
  }
  const body = await readJsonBody(req);
  try {
    const user = store.createUser({ username: body.username, password: body.password, role: 'user' });
    sendJson(res, 200, { token: issueToken(user), user: authUserPayload(user) });
  } catch (err) {
    const duplicate = !!err && err.message === '用户名已存在';
    // 用户名重复时也跑一次 scrypt：避免用注册接口的响应时间枚举账号
    if (duplicate) await store.verifyPasswordAsync(DUMMY_PASSWORD_ROW, String(body.password || ''));
    sendJson(res, 400, {
      error: 'register_failed',
      // 不直接确认“该用户名已存在”，减少账号枚举信号；密码规则等其它错误仍给明确提示
      message: duplicate ? '注册失败，请更换用户名或稍后再试' : (err.message || '注册失败')
    });
  }
}

async function handleLogin(req, res) {
  const body = await readJsonBody(req);
  const name = String(body.username || '').trim();
  // 按用户名再收一道：单 IP 限流挡不住换 IP 猜同一个账号
  const nameLimitedAt = name ? rateHit('loginUser', name.toLowerCase()) : 0;
  if (nameLimitedAt) return rejectRateLimited(res, nameLimitedAt);
  const user = store.getUserByName(name);
  // await 不能省：漏掉它 Promise 恒真，等于跳过密码校验（改密处同理）。
  // 用户不存在时用 dummy 行跑同样参数的 scrypt，消除“账号是否存在”的时序差。
  const passwordOk = await store.verifyPasswordAsync(user || DUMMY_PASSWORD_ROW, String(body.password || ''));
  if (!user || !passwordOk) {
    return sendJson(res, 401, { error: 'bad_credentials', message: '账号或密码不正确' });
  }
  // 一账号单设备在线：登录即 +1 世代号，此前所有设备上的登录随之失效
  store.bumpTokenEpoch(user.id);
  // 记住密码：勾选后签发 30 天的 token（前端存 localStorage，重开浏览器仍免登录）
  const ttl = body.remember ? TOKEN_TTL_REMEMBER : TOKEN_TTL;
  sendJson(res, 200, { token: issueToken(user, ttl), ttlMs: ttl, user: authUserPayload(user) });
}

async function handleLogout(req, res) {
  const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  const hit = readToken(token);
  // 登出也 +1 世代号：登出是持久化生效的，服务重启不会让旧 token 复活
  if (hit && store.getUser(hit.uid)) store.bumpTokenEpoch(hit.uid);
  revokeToken(token);
  sendJson(res, 200, { ok: true });
}

function handleMe(req, res) {
  const user = requireUser(req, res);
  if (!user) return;
  sendJson(res, 200, { user: authUserPayload(user) });
}

async function handleChangePassword(req, res) {
  const user = requireUser(req, res);
  if (!user) return;
  // 改密接口必须限流：token 泄露后，攻击者可在这里在线猜旧密码，且每次都触发一次 scrypt
  const limitedAt = rateHit('passwordChange', user.id);
  if (limitedAt) return rejectRateLimited(res, limitedAt);
  const body = await readJsonBody(req);
  if (!(await store.verifyPasswordAsync(user, String(body.oldPassword || '')))) {
    return sendJson(res, 400, { error: 'bad_password', message: '当前密码不正确' });
  }
  try {
    store.updateUserPassword(user.id, String(body.newPassword || ''));
  } catch (err) {
    return sendJson(res, 400, { error: 'bad_password', message: err.message || '密码修改失败' });
  }
  // 改密踢下线：世代号 +1，所有旧 token（含被复制留存的）立即失效；
  // 当前设备当场换发一张新 token 继续使用，去登录页的是其他设备。
  store.bumpTokenEpoch(user.id);
  const ttl = body.remember ? TOKEN_TTL_REMEMBER : TOKEN_TTL;
  sendJson(res, 200, { ok: true, token: issueToken(user, ttl), ttlMs: ttl });
}

async function handleAvatar(req, res) {
  const user = requireUser(req, res);
  if (!user) return;
  // 头像以 data URL 存库（单张 ≤600KB），不限流等于允许把库当对象存储刷
  const limitedAt = rateHit('avatar', user.id);
  if (limitedAt) return rejectRateLimited(res, limitedAt);
  const body = await readJsonBody(req);
  const avatar = String(body.avatar || '');
  if (avatar && !/^data:image\/(png|jpe?g|webp|gif);base64,/.test(avatar)) {
    return sendJson(res, 400, { error: 'bad_avatar', message: '仅支持图片文件' });
  }
  if (avatar.length > 600 * 1024) {
    return sendJson(res, 400, { error: 'avatar_too_large', message: '图片过大，请换一张较小的图片' });
  }
  store.updateUser(user.id, { avatar });
  sendJson(res, 200, { avatar });
}

// POST /api/auth/assistant —— 保存本账号的智能助手展示配置（头像 / 名称，被试端聊天页展示）
// 头像与个人头像同一口径（data URL、≤600KB）；名称留空 = 回落页面内置默认名称
async function handleAssistantConfig(req, res) {
  const user = requireUser(req, res);
  if (!user) return;
  // 与个人头像共用同一限流桶：两个入口都能写 ≤600KB 的 data URL
  const limitedAt = rateHit('avatar', user.id);
  if (limitedAt) return rejectRateLimited(res, limitedAt);
  const body = await readJsonBody(req);
  const patch = {};
  if (body.avatar != null) {
    const avatar = String(body.avatar || '');
    if (avatar && !/^data:image\/(png|jpe?g|webp|gif);base64,/.test(avatar)) {
      return sendJson(res, 400, { error: 'bad_avatar', message: '仅支持图片文件' });
    }
    if (avatar.length > 600 * 1024) {
      return sendJson(res, 400, { error: 'avatar_too_large', message: '图片过大，请换一张较小的图片' });
    }
    patch.assistantAvatar = avatar;
  }
  if (body.name != null) {
    const name = String(body.name || '').trim();
    if (name.length > 40) return sendJson(res, 400, { error: 'bad_name', message: '助手名称请控制在 40 个字以内' });
    patch.assistantName = name;
  }
  if (Object.keys(patch).length) store.updateUser(user.id, patch);
  sendJson(res, 200, { assistant: store.getAssistantConfig(user.id) });
}

module.exports = {
  handleRegister,
  handleLogin,
  handleLogout,
  handleMe,
  handleChangePassword,
  handleAvatar,
  handleAssistantConfig
};
