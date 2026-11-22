'use strict';

import { api } from './api.js';
import { el, toast, copyText, openModal, closeModal } from './ui.js';

/* ---------------------------------------------------------------- 手机地址与二维码 */

// 二维码与被试链接都必须是手机能打开的地址：管理端用 localhost 打开时换成局域网 IP
// （由 /api/net-info 上报），用域名（含公网部署）打开时直接用当前 origin。结果缓存，只取一次。
let netInfoPromise = null;
function getNetInfo() {
  if (!netInfoPromise) netInfoPromise = api('/api/net-info').catch(() => null);
  return netInfoPromise;
}

async function participantBase() {
  const h = location.hostname;
  if (h === 'localhost' || h === '127.0.0.1' || h === '::1') {
    const info = await getNetInfo();
    const first = info && Array.isArray(info.urls) ? info.urls[0] : '';
    if (first) return first;
  }
  return location.origin;
}

// 链接行：先立即显示 origin 版本，拿到局域网地址后原地替换（复制按钮读 input.value，无需额外处理）
async function fillParticipantLink(input, path) {
  input.value = location.origin + path;
  const base = await participantBase();
  input.value = base + path;
}

// 四宫格二维码图标（按钮用，跟随 currentColor）
function qrIconSvg(size = 14) {
  const holder = document.createElement('span');
  holder.innerHTML = '<svg viewBox="0 0 24 24" width="' + size + '" height="' + size + '" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
    + '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/>'
    + '<path d="M14 14h3.5v3.5H14zM20.6 14.2v.1M14 20.6h3.5M20.6 17.5v3.1"/></svg>';
  return holder.firstChild;
}

function qrFileName(title) {
  const safe = String(title || '').replace(/[\\/:*?"<>|\s]+/g, '-').replace(/^-+|-+$/g, '');
  return '二维码-' + (safe || '未命名') + '.png';
}

// 二维码弹窗（不跳页面）：二维码 + 地址行（可复制）+ 备选地址提示；「保存图片」存海报式 PNG。
// 备选地址只在「localhost 打开、已换成局域网地址」时列出；公网部署（地址 = 域名）时不列，
// 否则会把服务器自己的内网 IP 列给被试，反而误导。
async function openQrModal({ title, posterTitle, path, note }) {
  const info = await getNetInfo();
  const base = await participantBase();
  const url = base + path;
  const lanSubstituted = base !== location.origin;
  const alts = lanSubstituted && info && Array.isArray(info.urls) ? info.urls.filter((u) => u !== base) : [];

  const body = el('div');
  const figure = el('div', 'qr-figure');
  const img = el('img');
  img.alt = '二维码';
  img.src = '/qr.svg?u=' + encodeURIComponent(url);
  figure.appendChild(img);
  body.appendChild(figure);
  if (note) body.appendChild(el('p', 'qr-note', note));
  if (/^https?:\/\/(localhost|127\.0\.0\.1)/.test(url)) {
    body.appendChild(el('p', 'qr-warn', '未检测到局域网地址：请确认这台电脑已连上网络，否则手机打不开这个地址。'));
  }
  const row = el('div', 'link-row');
  const input = el('input');
  input.type = 'text';
  input.readOnly = true;
  input.value = url;
  input.addEventListener('click', () => input.select());
  const copy = el('button', 'ghost-btn', '复制');
  copy.onclick = () => copyText(input.value, '链接已复制');
  row.append(input, copy);
  body.appendChild(row);
  if (alts.length) {
    const altBox = el('p', 'qr-alts', '若上面的地址手机打不开，可改用备选地址：');
    for (const a of alts) altBox.appendChild(el('code', 'qr-alt-item', a + path));
    body.appendChild(altBox);
  }
  openModal({
    title,
    body,
    confirmLabel: '保存图片',
    onConfirm: () => saveQrPoster({ title: posterTitle || title, url, filename: qrFileName(posterTitle || title) }),
    extraLabel: '关闭',
    onExtra: closeModal,
    hideCancel: true
  });
}

// 保存海报式 PNG（标题 + 二维码 + 完整网址 + 一行说明）：fetch /qr.svg 后按 viewBox 整数倍栅格化，
// 保证二维码模块边缘清晰；纯浏览器实现，局域网与公网部署行为一致。
async function saveQrPoster({ title, url, filename }) {
  const res = await fetch('/qr.svg?u=' + encodeURIComponent(url));
  if (!res.ok) throw new Error('二维码生成失败，请重试');
  const raw = await res.text();
  const vb = /viewBox="0 0 ([0-9.]+) ([0-9.]+)"/.exec(raw);
  const box = vb ? Number(vb[1]) : 264;
  const qrPx = Math.max(320, Math.round(640 / box) * box);
  const svg = raw.replace('<svg ', '<svg width="' + qrPx + '" height="' + qrPx + '" ');
  const img = new Image();
  img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  await img.decode();

  const pad = Math.round(qrPx * 0.09);
  const width = qrPx + pad * 2;
  const family = getComputedStyle(document.body).fontFamily || 'sans-serif';
  const titleFont = '600 ' + Math.round(qrPx * 0.088) + 'px ' + family;
  const urlFont = '500 ' + Math.round(qrPx * 0.055) + 'px ' + family;
  const hintFont = '400 ' + Math.round(qrPx * 0.045) + 'px ' + family;

  const cv = document.createElement('canvas');
  const ctx = cv.getContext('2d');
  const wrap = (text, font) => {
    ctx.font = font;
    const lines = [];
    let line = '';
    for (const ch of String(text)) {
      if (line && ctx.measureText(line + ch).width > width - pad * 2) { lines.push(line); line = ch; }
      else line += ch;
    }
    lines.push(line);
    return lines;
  };
  const lineH = (font) => Math.round(parseFloat(font.split(' ')[1]) * 1.55);
  const titleLines = wrap(title, titleFont);
  const urlLines = wrap(url, urlFont);
  const hintLines = wrap('扫码开始作答', hintFont);
  const gapTitle = Math.round(qrPx * 0.1);
  const gapUrl = Math.round(qrPx * 0.09);
  const gapHint = Math.round(qrPx * 0.03);
  const top = Math.round(pad * 0.9);
  const height = top
    + titleLines.length * lineH(titleFont) + gapTitle
    + qrPx + gapUrl
    + urlLines.length * lineH(urlFont) + gapHint
    + hintLines.length * lineH(hintFont) + Math.round(pad * 0.9);

  cv.width = width;
  cv.height = height;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, width, height);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  let y = top;
  const drawLines = (lines, font, color) => {
    ctx.font = font;
    ctx.fillStyle = color;
    const lh = lineH(font);
    for (const line of lines) { ctx.fillText(line, width / 2, y + lh / 2); y += lh; }
  };
  drawLines(titleLines, titleFont, '#111213');
  y += gapTitle;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(img, pad, y, qrPx, qrPx);
  y += qrPx + gapUrl;
  drawLines(urlLines, urlFont, '#3a3a3f');
  y += gapHint;
  drawLines(hintLines, hintFont, '#7a7a80');

  const blob = await new Promise((resolve) => cv.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error('图片生成失败，可改用右键「图片另存为」');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  toast('图片已保存');
}


export {
  getNetInfo,
  participantBase,
  fillParticipantLink,
  qrIconSvg,
  qrFileName,
  openQrModal,
  saveQrPoster
};
