'use strict';

const os = require('node:os');
const qrcode = require('../../vendor/qrcode');
const { sendJson } = require('../http');
const { requireUser } = require('../auth');
const { PORT } = require('../config');

// ---------------------------------------------------------------- 局域网预实验 · 连接页与二维码

// 枚举本机局域网 IPv4：排除回环/链路本地（169.254.*）与重复项，
// 常见私网网段优先（192.168 > 10 > 172.16-31），用于手机同 WiFi 直连。
function lanAddresses() {
  const seen = new Set();
  const list = [];
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const ni of ifaces || []) {
      if (ni.family !== 'IPv4' || ni.internal || seen.has(ni.address)) continue;
      seen.add(ni.address);
      if (/^169\.254\./.test(ni.address)) continue;
      list.push(ni.address);
    }
  }
  const rank = (ip) => (/^192\.168\./.test(ip) ? 0 : /^10\./.test(ip) ? 1 : /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ? 2 : 3);
  return list.sort((a, b) => rank(a) - rank(b));
}

function entryUrl(ip) {
  return `http://${ip || 'localhost'}:${PORT}/`;
}

function makeQr(text) {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  return qr;
}

function qrSvgFor(text, cellSize = 6, margin = 2) {
  return makeQr(text).createSvgTag({ cellSize, margin, scalable: true });
}

// 管理端「被试链接 / 二维码」用：返回端口与本机所有可用局域网地址（无尾斜杠，前端自行拼路径）。
// 前端在 localhost 打开时用这里的地址，避免把 localhost 链接/二维码发给手机；公网部署时前端直接用自身域名。
// 需要登录：内网 IP 属于不该给匿名访问者的信息（唯一调用方管理端走带 token 的 api()）。
// 注意 /qr.svg 不能同样加鉴权——它由 <img src> 加载，带不了请求头；它只渲染传入的文本，不泄露信息。
function handleNetInfo(req, res) {
  if (!requireUser(req, res)) return;
  sendJson(res, 200, {
    port: PORT,
    local: `http://localhost:${PORT}`,
    urls: lanAddresses().map((ip) => `http://${ip}:${PORT}`)
  });
}

function handleQrSvg(req, res, url) {
  const target = (url.searchParams.get('u') || '').trim();
  if (!target || target.length > 512 || !/^https?:\/\//.test(target)) {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('bad request');
    return;
  }
  res.writeHead(200, { 'Content-Type': 'image/svg+xml; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(qrSvgFor(target, 8, 2));
}

module.exports = {
  lanAddresses,
  entryUrl,
  handleNetInfo,
  handleQrSvg
};
