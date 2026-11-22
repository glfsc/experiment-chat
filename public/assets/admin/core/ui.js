'use strict';

import {
  $, $toast, $modal, $modalTitle, $modalBody, $modalError, $modalCancel, $modalConfirm,
  state
} from './state.js';

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

let toastTimer = null;
function toast(message) {
  $toast.textContent = message;
  $toast.classList.remove('hidden');
  requestAnimationFrame(() => $toast.classList.add('show'));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    $toast.classList.remove('show');
    setTimeout(() => $toast.classList.add('hidden'), 220);
  }, 2200);
}

async function copyText(text, okMessage) {
  try {
    await navigator.clipboard.writeText(text);
    toast(okMessage || '已复制');
    return;
  } catch { /* 降级 */ }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand('copy'); toast(okMessage || '已复制'); } catch { toast('复制失败，请手动复制'); }
  ta.remove();
}

function formatTime(iso) {
  if (!iso) return '——';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('zh-CN', { hour12: false });
}

function formatDuration(sec) {
  const n = Number(sec);
  if (!Number.isFinite(n) || n <= 0) return '——';
  const m = Math.floor(n / 60);
  const s = n % 60;
  return m > 0 ? `${m} 分 ${s} 秒` : `${s} 秒`;
}

function sectionHead(title, hint) {
  const section = el('div', 'section');
  const head = el('div', 'section-head');
  head.appendChild(el('h3', 'section-title', title));
  section.appendChild(head);
  if (hint) section.appendChild(el('p', 'section-hint', hint));
  return section;
}

// 文本域自动增高：高度跟随内容（下限为 rows 对应高度），避免固定高度内部滚动（issue 9）
// 也允许手动往下拖：拖高后把当时的高度记成下限，继续输入不会被自动增高顶回去（issue 3）
function autoGrowTextarea(textarea, minRows) {
  const minHeight = Math.max(1, Number(minRows) || 1) * 22 + 22;
  const resize = () => {
    textarea.style.height = 'auto';
    const floor = Math.max(minHeight, Number(textarea.dataset.minH) || 0);
    textarea.style.height = `${Math.max(textarea.scrollHeight, floor)}px`;
  };
  textarea.style.overflow = 'auto';
  const applyResize = (v) => { textarea.dataset.minH = String(Math.max(minHeight, Number(v) || 0)); resize(); };
  textarea.addEventListener('input', resize);
  textarea.addEventListener('mouseup', () => {
    if (textarea.scrollHeight < textarea.clientHeight) applyResize(textarea.clientHeight);
  });
  window.setTimeout(() => { applyResize(textarea.dataset.minH); }, 0);
  return resize;
}

function makeField(labelText, value, rows) {
  const wrap = el('label', 'field');
  wrap.appendChild(el('span', '', labelText));
  let input;
  if (rows && rows > 1) {
    input = el('textarea');
    input.rows = rows;
    autoGrowTextarea(input, rows);
  } else {
    input = el('input');
    input.type = 'text';
  }
  input.value = value == null ? '' : String(value);
  wrap.appendChild(input);
  return { wrap, input };
}

function makeNumberField(labelText, value, min, max, hint) {
  const wrap = el('label', 'field');
  wrap.appendChild(el('span', '', labelText));
  const input = el('input');
  input.type = 'number';
  input.min = String(min);
  input.max = String(max);
  input.value = value == null ? '' : String(value);
  wrap.appendChild(input);
  if (hint) wrap.appendChild(el('em', 'field-hint', hint));
  return { wrap, input };
}


/* ---------------------------------------------------------------- 弹窗 */

let modalOnConfirm = null;
let modalOnExtra = null;

function openModal({ title, body, confirmLabel = '确定', danger = false, onConfirm, extraLabel, onExtra, hideCancel = false }) {
  $modalTitle.textContent = title;
  $modalBody.innerHTML = '';
  if (body) $modalBody.appendChild(body);
  $modalError.classList.add('hidden');
  $modalConfirm.textContent = confirmLabel;
  $modalConfirm.classList.toggle('danger', Boolean(danger));
  $modalConfirm.disabled = false;
  $modalCancel.classList.toggle('hidden', hideCancel);
  modalOnConfirm = onConfirm || null;
  modalOnExtra = onExtra || null;
  let extra = document.getElementById('modal-extra');
  if (extraLabel && onExtra) {
    if (!extra) {
      extra = el('button', 'ghost-btn');
      extra.id = 'modal-extra';
      extra.type = 'button';
      extra.addEventListener('click', async () => {
        if (!modalOnExtra) return;
        extra.disabled = true;
        try { await modalOnExtra(); } catch (err) { showModalError(err.message || '操作失败，请重试'); } finally { extra.disabled = false; }
      });
      $modalCancel.parentElement.insertBefore(extra, $modalCancel);
    }
    extra.textContent = extraLabel;
    extra.classList.remove('hidden');
  } else if (extra) {
    extra.classList.add('hidden');
  }
  $modal.classList.remove('hidden');
}

function closeModal() {
  $modal.classList.add('hidden');
  modalOnConfirm = null;
  modalOnExtra = null;
}

function showModalError(message) {
  $modalError.textContent = message;
  $modalError.classList.remove('hidden');
}

$modalCancel.addEventListener('click', closeModal);
$modal.addEventListener('click', (e) => { if (e.target === $modal) closeModal(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$modal.classList.contains('hidden')) closeModal(); });
$modalConfirm.addEventListener('click', async () => {
  if (!modalOnConfirm) return;
  $modalConfirm.disabled = true;
  try { await modalOnConfirm(); } catch (err) { showModalError(err.message || '操作失败，请重试'); } finally { $modalConfirm.disabled = false; }
});


function avatarNode(user, size) {
  const wrap = el('div', 'avatar' + (user.avatar ? '' : ' empty'));
  wrap.style.width = `${size}px`;
  wrap.style.height = `${size}px`;
  if (user.avatar) {
    const img = el('img');
    img.src = user.avatar;
    img.alt = '头像';
    wrap.appendChild(img);
  } else {
    wrap.textContent = (user.username || '?').slice(0, 1).toUpperCase();
  }
  return wrap;
}


function renderSidebarAvatar() {
  const slot = $('sidebar-user-avatar');
  if (!slot || !state.user) return;
  slot.innerHTML = '';
  slot.appendChild(avatarNode(state.user, 22));
}


export {
  el,
  toast,
  copyText,
  formatTime,
  formatDuration,
  sectionHead,
  autoGrowTextarea,
  makeField,
  makeNumberField,
  openModal,
  closeModal,
  showModalError,
  avatarNode,
  renderSidebarAvatar
};
