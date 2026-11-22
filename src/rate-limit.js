'use strict';

const { sendJson } = require('./http');

// ---------------------------------------------------------------- 限流
// 固定窗口计数：超限即拒绝，窗口到点整体重置。
// 阈值可用环境变量覆盖；**显式设 0 = 关闭该条限流**（留这个口子是因为
// 实验室 / 机房整班被试共用一个出口 IP 时，按 IP 限流与「几百人同时开始」天然冲突）。
function envLimit(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.floor(n);
}
const RATE_RULES = {
  loginIp:    { limit: envLimit('RATE_LOGIN_PER_MIN', 10),       windowMs: 60 * 1000 },          // 按 IP：挡批量猜密码
  // 按用户名挡「换 IP 猜同一个账号」。取 10 而不是 5：主试自己手误重试、以及
  // check → probe → shots 连着跑（一次全跑约消耗 5 次）都要留出余量，否则会把自己锁在门外
  loginUser:  { limit: envLimit('RATE_LOGIN_USER_PER_MIN', 10), windowMs: 60 * 1000 },
  register:   { limit: envLimit('RATE_REGISTER_PER_HOUR', 3),   windowMs: 60 * 60 * 1000 },      // 按 IP：挡刷账号
  // 「开始作答」两条按「整班同学一起扫码」定档（实测 200 个共用 IP 的请求只花 205ms，
  // 服务端扛得住，闸门才是瓶颈）：单 IP 覆盖一间机房整班，全局留一倍余量给重开 / 重做
  sessionIp:  { limit: envLimit('RATE_SESSION_PER_MIN', 600),   windowMs: 60 * 1000 },
  sessionAll: { limit: envLimit('RATE_SESSION_ALL_PER_MIN', 1200), windowMs: 60 * 1000 },
  preview:    { limit: envLimit('RATE_PREVIEW_PER_MIN', 60),    windowMs: 60 * 1000 },          // 管理端预览，自用放宽
  // 已登录用户的写接口：按用户 ID 限流，避免 token 泄露后在线猜旧密码 / 刷头像撑库
  passwordChange: { limit: envLimit('RATE_PASSWORD_PER_MIN', 5), windowMs: 60 * 1000 },
  avatar:         { limit: envLimit('RATE_AVATAR_PER_MIN', 10),  windowMs: 60 * 1000 }
};
// 走限流的路径 → 规则名。不在这张表里的路径一律不限流：作答主链路（/api/step、/api/heartbeat、
// /api/bootstrap）在共用出口 IP 时被限流等于丢数据，且它们的滥用面已被「sessionId 不可猜」约束住。
const RATE_BY_PATH = new Map([
  ['/api/auth/login', 'loginIp'],
  ['/api/auth/register', 'register'],
  ['/api/session', 'sessionIp']
]);
const RATE_MAX_BUCKETS = 20000;                    // 桶上限：限流器自己不能变成内存放大点
const rateBuckets = new Map();                     // key -> { count, resetAt }

// 客户端 IP：只有对端是本机回环（nginx 反代场景）时才认 X-Forwarded-For，
// 否则直连 3000 的请求可以自带该头伪造身份，按 IP 限流会形同虚设
function clientIp(req) {
  const peer = (req.socket && req.socket.remoteAddress) || '';
  const loopback = peer === '127.0.0.1' || peer === '::1' || peer === '::ffff:127.0.0.1';
  if (loopback) {
    const parts = String(req.headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (parts.length) return parts[parts.length - 1];     // 最右侧 = 反代自己看到的对端
  }
  return peer || 'unknown';
}

// 记一次访问：超限返回窗口重置时间戳，未超限返回 0
function rateHit(rule, subject) {
  const r = RATE_RULES[rule];
  if (r.limit <= 0) return 0;                      // 阈值设 0 = 这条不限流
  const now = Date.now();
  const key = `${rule}:${subject}`;
  let bucket = rateBuckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    if (rateBuckets.size >= RATE_MAX_BUCKETS) {
      pruneRateBuckets(now);
      if (rateBuckets.size >= RATE_MAX_BUCKETS) rateBuckets.delete(rateBuckets.keys().next().value);
    }
    bucket = { count: 0, resetAt: now + r.windowMs };
    rateBuckets.set(key, bucket);
  }
  bucket.count += 1;
  return bucket.count > r.limit ? bucket.resetAt : 0;
}
function pruneRateBuckets(now = Date.now()) {
  for (const [key, bucket] of rateBuckets) if (bucket.resetAt <= now) rateBuckets.delete(key);
}
const rateSweeper = setInterval(pruneRateBuckets, 60 * 1000);
if (rateSweeper && typeof rateSweeper.unref === 'function') rateSweeper.unref();

function rejectRateLimited(res, resetAt) {
  const retryAfter = Math.max(1, Math.ceil((resetAt - Date.now()) / 1000));
  sendJson(res, 429, { error: 'rate_limited', message: '操作过于频繁，请稍后再试' }, { 'Retry-After': String(retryAfter) });
}

// 按路径取本次请求适用的限流；被限住返回窗口重置时间戳，放行返回 0
function limitPath(pathname, ip) {
  // 只限量“创建预览”这个重操作：bootstrap / step / speed 是预览内的正常作答链路，
  // 高速预览时一分钟可能超过 60 次，按前缀限流会把正常操作挡掉。
  if (pathname === '/api/admin/preview' || pathname === '/api/preview/create') return rateHit('preview', ip);
  const rule = RATE_BY_PATH.get(pathname);
  if (!rule) return 0;
  const at = rateHit(rule, ip);
  if (at) return at;
  // 全局兜底：换 IP 分布式刷会话时，单 IP 限流拦不住，这里按总量再收一道
  return pathname === '/api/session' ? rateHit('sessionAll', 'all') : 0;
}

module.exports = {
  clientIp,
  rateHit,
  rejectRateLimited,
  limitPath
};
