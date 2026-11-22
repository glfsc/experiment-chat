'use strict';

import { el, toast, copyText, openModal, closeModal } from '../core/ui.js';

// 复制命名：在原名末尾加编号（1）（2）…，取第一个未占用的
function numberedCopyTitle(base, existingTitles) {
  const used = new Set((existingTitles || []).map((t) => String(t || '').trim()));
  for (let n = 1; ; n += 1) {
    const t = `${base}（${n}）`;
    if (!used.has(t)) return t;
  }
}

// 分享编号解析：接受纯编号，也接受整条链接（被试链接 ?q= / 分享链接 ?import=）；解析不出来返回空串
function extractShareCode(raw) {
  const text = String(raw || '').trim();
  if (!text) return '';
  const hit = text.match(/[?&](?:q|import)=([A-Za-z0-9_-]+)/);
  const candidate = hit ? hit[1] : text;
  return /^[A-Za-z0-9_-]{4,64}$/.test(candidate) ? candidate.toLowerCase() : '';
}

// 分享弹窗：编号 = 问卷 / 实验自身 id（列表里已显示的那串），其他管理者在「新建」弹窗中粘贴即复制
function openShareModal({ kind, id, name }) {
  const isExp = kind === 'exp';
  const body = el('div');
  body.appendChild(el('p', 'modal-note',
    `把「${name}」的编号发给其他管理者账号：在「${isExp ? '实验管理' : '问卷管理'} → 新建」弹窗里粘贴编号，即可复制一份完全相同的${isExp ? '实验模板' : '问卷'}（新编号、新链接，作答数据互不影响）。`));
  const codeRow = el('div', 'link-row');
  const codeInput = el('input');
  codeInput.type = 'text';
  codeInput.readOnly = true;
  codeInput.value = id;
  codeInput.addEventListener('click', () => codeInput.select());
  const codeCopy = el('button', 'ghost-btn', '复制编号');
  codeCopy.type = 'button';
  codeCopy.onclick = () => copyText(id, '编号已复制');
  codeRow.append(codeInput, codeCopy);
  body.appendChild(codeRow);
  const shareUrl = `${location.origin}/admin?import=${encodeURIComponent(id)}${isExp ? '&as=exp' : ''}`;
  const linkRow = el('div', 'link-row');
  const linkInput = el('input');
  linkInput.type = 'text';
  linkInput.readOnly = true;
  linkInput.value = shareUrl;
  linkInput.addEventListener('click', () => linkInput.select());
  const linkCopy = el('button', 'ghost-btn', '复制链接');
  linkCopy.type = 'button';
  linkCopy.onclick = () => copyText(shareUrl, '分享链接已复制');
  linkRow.append(linkInput, linkCopy);
  body.appendChild(linkRow);
  openModal({ title: isExp ? '分享实验模板' : '分享问卷', body, confirmLabel: '完成', hideCancel: true, onConfirm: closeModal });
}

export { numberedCopyTitle, extractShareCode, openShareModal };
