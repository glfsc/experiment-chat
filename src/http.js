'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { PUBLIC_DIR } = require('./config');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon'
};

function sendJson(res, status, payload, extraHeaders) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...(extraHeaders || {})
  });
  res.end(JSON.stringify(payload));
}

function readJsonBody(req, maxBytes = 4 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let settled = false;
    const chunks = [];
    const settle = (fn, arg) => { if (!settled) { settled = true; fn(arg); } };
    req.on('data', (chunk) => {
      if (settled) return;                       // 已判超限：剩余数据读掉即弃，不再累积
      size += chunk.length;
      // 这里不 destroy(req)：destroy 会连 socket 一起销毁，客户端只看到连接重置、
      // 收不到我们回的那条 413。读掉多余数据（内存不再增长）才能把响应送达。
      if (size > maxBytes) { settle(reject, new Error('body_too_large')); return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) return settle(resolve, {});
      try { settle(resolve, JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { settle(resolve, {}); }
    });
    req.on('error', (err) => settle(reject, err));
  });
}

function serveFile(res, absPath) {
  fs.readFile(absPath, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Not Found'); return; }
    res.writeHead(200, {
      'Content-Type': MIME_TYPES[path.extname(absPath).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store'
    });
    res.end(data);
  });
}

function serveStatic(res, pathname) {
  let relPath = '';
  // 根路径就是管理端页面：未登录时它显示登录卡片，登录后直接进管理端
  if (pathname === '/' || pathname === '/index.html') relPath = 'admin.html';
  else if (pathname === '/chat' || pathname === '/chat.html') relPath = 'chat.html';
  else if (pathname === '/admin' || pathname === '/admin.html') relPath = 'admin.html';
  else if (pathname.startsWith('/assets/')) relPath = pathname.slice(1);
  if (!relPath) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Not Found'); return; }
  // 只允许 public/ 里的文件：URL 只对字面量 .. 做归一化，%2e%2e%2f 这类编码斜杠能绕过去，
  // 解码后必须再校验一次落点，否则 /assets/../../data.db 会读到数据库与源码
  const absPath = path.resolve(PUBLIC_DIR, relPath);
  if (absPath !== PUBLIC_DIR && !absPath.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not Found');
    return;
  }
  serveFile(res, absPath);
}

// ---------------------------------------------------------------- 安全响应头
// 在 writeHead 上统一注入，一次覆盖全部响应（含 401 / 404 / 500 等错误路径）
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  // 不能用 DENY：管理端编辑页用同源 iframe 嵌 /chat?preview= 做手机预览，DENY 会把它拦掉
  'X-Frame-Options': 'SAMEORIGIN',
  'Referrer-Policy': 'no-referrer',
  'X-Permitted-Cross-Domain-Policies': 'none',
  // HSTS 由应用统一下发：反代（nginx）不一定传 X-Forwarded-Proto，靠它判断会漏头。
  // 浏览器只在 HTTPS 响应上采纳 HSTS，局域网 HTTP 预实验收到也会忽略，所以无条件下发是安全的。
  // 暂不带 includeSubDomains：确认所有子域都支持 HTTPS 后再加。
  'Strict-Transport-Security': 'max-age=31536000',
  // 页面不需要摄像头 / 麦克风 / 定位；显式关掉，降低被第三方脚本利用的面
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  // 两个 HTML 的脚本均为外链（/assets/*.js），富文本只带内联 style，故：
  //   script-src 只允许 'self'（不再给 'unsafe-inline' / 'unsafe-eval'）
  //   style-src 保留 'unsafe-inline'（富文本的 color/font-size 等内联样式需要）
  'Content-Security-Policy': [
    "default-src 'self'",
    "img-src 'self' data:",                                  // 头像与二维码海报导出走 data:
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'self'"
  ].join('; ')
};
function applySecurityHeaders(req, res) {
  const original = res.writeHead.bind(res);
  res.writeHead = (status, arg1, arg2) => {
    const headers = arg1 && typeof arg1 === 'object' ? arg1 : (arg2 || {});
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) headers[name] = value;
    return typeof arg1 === 'string' ? original(status, arg1, headers) : original(status, headers);
  };
}

module.exports = {
  sendJson,
  readJsonBody,
  serveStatic,
  applySecurityHeaders
};
