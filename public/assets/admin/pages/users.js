'use strict';

import { $, $main, state } from '../core/state.js';
import { api, maybeSessionExpired } from '../core/api.js';
import { el, toast, openModal, makeField, formatTime, avatarNode } from '../core/ui.js';

/* ---------------------------------------------------------------- 用户管理页（#/users，管理员） */

async function renderUsers() {
  if (!state.user || state.user.role !== 'admin') {
    location.replace('#/exp');
    return;
  }
  $main.innerHTML = '';
  const panel = el('div', 'page-panel');

  const head = el('div', 'settings-head');
  head.appendChild(el('h2', 'page-title', '用户管理'));
  head.appendChild(el('p', 'page-sub', '查看与维护系统用户：新增账号、修改资料、重置密码、删除用户。'));
  panel.appendChild(head);

  const addBtn = el('button', 'primary-btn', '＋ 新增用户');
  addBtn.type = 'button';
  addBtn.addEventListener('click', () => openUserEditor(null));
  panel.appendChild(addBtn);

  const box = el('div', 'users-list');
  panel.appendChild(box);
  $main.appendChild(panel);

  let users = [];
  try {
    users = (await api('/api/admin/users')).users;
  } catch (err) {
    if (!maybeSessionExpired(err)) toast(err.message || '用户列表加载失败');
    return;
  }

  const table = el('table', 'users-table');
  const thead = el('thead');
  thead.appendChild(el('tr', '', '')).append(
    el('th', '', '用户'), el('th', '', '角色'), el('th', '', '创建时间'), el('th', '', '操作')
  );
  const tbody = el('tbody');
  for (const u of users) {
    const tr = el('tr');
    const nameCell = el('td');
    const nameWrap = el('div', 'user-cell');
    nameWrap.appendChild(avatarNode(u, 34));
    nameWrap.appendChild(el('span', '', u.username));
    nameCell.appendChild(nameWrap);
    tr.appendChild(nameCell);
    tr.appendChild(el('td', '', u.role === 'admin' ? '管理员' : '普通主试'));
    tr.appendChild(el('td', '', formatTime(u.createdAt)));
    const ops = el('td');
    const bEdit = el('button', 'mini-btn', '编辑');
    bEdit.type = 'button';
    bEdit.addEventListener('click', () => openUserEditor(u));
    const bDel = el('button', 'mini-btn', '删除');
    bDel.type = 'button';
    if (u.id === state.user.id) bDel.disabled = true;
    bDel.addEventListener('click', () => {
      openModal({
        title: '删除用户',
        body: el('p', 'modal-text', `确定删除用户「${u.username}」吗？该操作不可恢复。`),
        confirmLabel: '删除',
        danger: true,
        onConfirm: async () => {
          await api('/api/admin/users/delete', { body: { id: u.id } });
          toast('已删除');
          renderUsers();
        }
      });
    });
    ops.append(bEdit, bDel);
    tr.appendChild(ops);
    tbody.appendChild(tr);
  }
  table.append(thead, tbody);
  box.appendChild(table);
}

// 新增 / 编辑用户弹窗
function openUserEditor(user) {
  const isEdit = !!user;
  const body = el('div', 'form-grid');
  const nameField = makeField('用户账号', isEdit ? user.username : '');
  const roleField = el('label', 'field');
  roleField.appendChild(el('span', '', '角色'));
  const roleSel = el('select');
  ['user', 'admin'].forEach((r) => {
    const opt = el('option', '', r === 'admin' ? '管理员' : '普通主试');
    opt.value = r;
    roleSel.appendChild(opt);
  });
  roleSel.value = isEdit ? user.role : 'user';
  roleField.appendChild(roleSel);
  const pwdLabel = isEdit ? '重置密码（留空则不修改，至少 10 位）' : '初始密码（至少 10 位）';
  const pwdField = makeField(pwdLabel, '');
  pwdField.input.type = 'password';
  body.append(nameField.wrap, roleField, pwdField.wrap);

  openModal({
    title: isEdit ? `编辑用户 · ${user.username}` : '新增用户',
    body,
    onConfirm: async () => {
      if (isEdit) {
        await api('/api/admin/users/update', {
          body: {
            id: user.id,
            username: nameField.input.value.trim(),
            role: roleSel.value,
            password: pwdField.input.value || undefined
          }
        });
        toast('已保存');
      } else {
        await api('/api/admin/users/create', {
          body: { username: nameField.input.value.trim(), role: roleSel.value, password: pwdField.input.value }
        });
        toast('已创建');
      }
      renderUsers();
    }
  });
}

export { renderUsers, openUserEditor };
