// 服务端入口：HTTP 服务、路由装配、启动与全局异常兜底。
// 业务模块在 src/：config（配置）、http（响应/静态资源）、auth（鉴权）、
// session/（状态机与写路径）、preview、report、routes/（按域拆分的接口）。
'use strict';

const http = require('node:http');
const { PORT } = require('./src/config');
const { sendJson, serveStatic, applySecurityHeaders } = require('./src/http');
const { clientIp, limitPath, rejectRateLimited } = require('./src/rate-limit');
const { lanAddresses, entryUrl } = require('./src/routes/net');
const routes = require('./src/routes');

// 路由表 → Map：一次构建，请求期 O(1) 查表。path 均为已解码的字面量。
const ROUTE_MAP = new Map(routes.map(([method, path, handler]) => [`${method} ${path}`, handler]));

const server = http.createServer(async (req, res) => {
  applySecurityHeaders(req, res);
  try {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    // 非法百分号编码（如 %ZZ）会让 decodeURIComponent 抛 URIError：
    // 这是请求本身有问题，不该落到兜底 500 去
    let pathname;
    try {
      pathname = decodeURIComponent(url.pathname);
    } catch {
      return sendJson(res, 400, { error: 'bad_request', message: '请求路径编码不合法' });
    }

    // 限流放在分发之前（body 都还没读）：洪水请求不会被解析
    const ip = clientIp(req);
    const limitedAt = limitPath(pathname, ip);
    if (limitedAt) return rejectRateLimited(res, limitedAt);

    const handler = ROUTE_MAP.get(`${req.method} ${pathname}`);
    if (handler) return await handler(req, res, url);

    if (req.method === 'GET') return serveStatic(res, pathname);
    sendJson(res, 405, { error: 'method_not_allowed' });
  } catch (err) {
    // 内部错误只写服务端日志：err.message 可能带上路径 / SQL 等内部细节，不回显给客户端
    console.error('[server] 未处理异常：', (err && err.stack) || err);
    // 响应已经开始发送（如静态文件读到一半）时只能收尾，再写 head 会抛
    if (res.headersSent) { try { res.end(); } catch { /* 连接已断，无需处理 */ } return; }
    // 超大请求体是「客户端可重试」的已知错误：前端 postStep 靠这个 code 决定重试，保留语义
    if (err && err.message === 'body_too_large') {
      return sendJson(res, 413, { error: 'body_too_large', message: '提交内容过大，请精简后再试' });
    }
    sendJson(res, 500, { error: 'server_error', message: '服务器内部错误' });
  }
});

server.listen(PORT, () => {
  const urls = lanAddresses().map(entryUrl);
  console.log('实验平台已启动（服务器部署模式）');
  console.log(`  管理端：http://localhost:${PORT}/（根路径就是管理端，未登录时先显示登录卡片）`);
  if (urls.length) console.log(`  本机内网地址（本机调试用）：${urls.join('   ')}`);
  console.log('  · 各组被试链接 / 二维码在管理端「问卷管理」生成（可保存成图片打印或发给被试）。');
  console.log('  停止服务：关闭本窗口（进行中的被试会话数据已实时落库，不会丢失）。');
  if (process.env.OPEN_PAGE === '1') {
    try {
      require('node:child_process').exec(`start "" "http://localhost:${PORT}/"`, { windowsHide: true });
    } catch { /* 自动打开浏览器失败不影响服务 */ }
  }
});
