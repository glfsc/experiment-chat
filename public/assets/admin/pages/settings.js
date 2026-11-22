'use strict';

import { $, $main, state, LOGIN_REMEMBER_KEY, loadRememberedTokenRecord, clearTokens, storeToken } from '../core/state.js';
import { api, maybeSessionExpired } from '../core/api.js';
import { showLogin } from './login.js';
import { el, toast, openModal, makeField, makeNumberField, avatarNode, renderSidebarAvatar, sectionHead } from '../core/ui.js';

async function saveMyAvatar(dataUrl) {
  const res = await api('/api/auth/avatar', { body: { avatar: dataUrl } });
  state.user.avatar = res.avatar;
  renderSidebarAvatar();          // 侧边栏「设置」行的头像同步更新
}

// 侧边栏「设置」行最右侧的当前账号头像（未上传时显示用户名首字母）

function assistantNode(size) {
  const wrap = el('div', 'assistant-preview' + (state.user.assistantAvatar ? ' has-img' : ''));
  wrap.style.width = `${size}px`;
  wrap.style.height = `${size}px`;
  if (state.user.assistantAvatar) {
    const img = el('img');
    img.src = state.user.assistantAvatar;
    img.alt = '助手头像';
    wrap.appendChild(img);
  }
  return wrap;
}

// 保存本账号的助手展示配置（头像 / 名称），成功后回填 state.user
async function saveAssistantConfig(patch) {
  const res = await api('/api/auth/assistant', { body: patch });
  state.user.assistantAvatar = res.assistant.avatar;
  state.user.assistantName = res.assistant.name;
}

// 头像裁剪弹窗：圆形视窗内拖动照片 / 滚轮缩放，确认后按可视区裁成 256×256
function openAvatarCropper(src, onDone) {
  const SIZE = 220;
  const body = el('div', 'crop-wrap');
  const viewport = el('div', 'crop-viewport');
  const img = el('img', 'crop-img');
  img.src = src;
  img.draggable = false;
  viewport.appendChild(img);
  body.appendChild(viewport);
  body.appendChild(el('p', 'crop-hint', '拖动照片调整位置 · 滚轮缩放'));

  let baseScale = 1;
  let scale = 1;
  let x = 0;
  let y = 0;
  const apply = () => {
    const w = img.naturalWidth * scale;
    const h = img.naturalHeight * scale;
    img.style.width = `${w}px`;
    img.style.height = `${h}px`;
    img.style.left = `${(SIZE - w) / 2 + x}px`;
    img.style.top = `${(SIZE - h) / 2 + y}px`;
  };
  const clampXY = () => {
    const maxX = Math.max(0, (img.naturalWidth * scale - SIZE) / 2);
    const maxY = Math.max(0, (img.naturalHeight * scale - SIZE) / 2);
    x = Math.min(maxX, Math.max(-maxX, x));
    y = Math.min(maxY, Math.max(-maxY, y));
  };
  img.onload = () => {
    baseScale = Math.max(SIZE / img.naturalWidth, SIZE / img.naturalHeight);
    scale = baseScale;
    apply();
  };

  let drag = null;
  viewport.addEventListener('pointerdown', (e) => {
    drag = { sx: e.clientX, sy: e.clientY, ox: x, oy: y };
    viewport.setPointerCapture(e.pointerId);
    viewport.classList.add('grabbing');
  });
  viewport.addEventListener('pointermove', (e) => {
    if (!drag) return;
    x = drag.ox + (e.clientX - drag.sx);
    y = drag.oy + (e.clientY - drag.sy);
    clampXY();
    apply();
  });
  const endDrag = () => { drag = null; viewport.classList.remove('grabbing'); };
  viewport.addEventListener('pointerup', endDrag);
  viewport.addEventListener('pointercancel', endDrag);
  viewport.addEventListener('wheel', (e) => {
    e.preventDefault();
    scale = Math.min(baseScale * 4, Math.max(baseScale, scale * (e.deltaY < 0 ? 1.12 : 0.89)));
    clampXY();
    apply();
  }, { passive: false });

  openModal({
    title: '裁剪头像',
    body,
    confirmLabel: '使用这张',
    onConfirm: async () => {
      const out = document.createElement('canvas');
      out.width = out.height = 256;
      // 源矩形 = 圆形视口在图片上的可视区：图片先按 (SIZE - w) / 2 居中摆放，拖动再叠加 x/y，
      // 所以起点除了 -x / scale，还必须带上居中量 (natural*scale - SIZE) / 2 / scale。
      // 漏掉居中量时，非正方形图片（宽或高超出视口）会裁到偏左上的一半——
      // 表现就是「上传后头像只显示一半、有偏移」。
      const sx = (img.naturalWidth * scale - SIZE) / (2 * scale) - x / scale;
      const sy = (img.naturalHeight * scale - SIZE) / (2 * scale) - y / scale;
      out.getContext('2d').drawImage(img, sx, sy, SIZE / scale, SIZE / scale, 0, 0, 256, 256);
      await onDone(out.toDataURL('image/jpeg', 0.88));
    }
  });
}

function renderSettings() {
  $main.innerHTML = '';
  const panel = el('div', 'page-panel');

  // 左上角返回
  const back = el('button', 'ghost-btn settings-back', '← 返回');
  back.type = 'button';
  back.addEventListener('click', () => { location.hash = '#/exp'; });
  panel.appendChild(back);

  const head = el('div', 'settings-head');
  head.appendChild(el('h2', 'page-title', '个人设置'));
  head.appendChild(el('p', 'page-sub', '管理您的账号信息与登录密码。'));
  panel.appendChild(head);

  // 全局设置（仅管理员）：未完成会话的自动作废时限 / 恢复窗口 / 普通账号资源配额
  if (state.user && state.user.role === 'admin') {
    const secGlobal = sectionHead('全局设置（仅管理员）', '影响所有问卷的会话生命周期与普通账号的资源配额。');
    const grid = el('div', 'grid2');
    const abandonField = makeNumberField('未完成会话自动作废时限（分钟）', '', 0, 1440,
      '超过这个时长没有任何活动（答题 / 刷新 / 心跳）的进行中会话，下次打开时会被标记为「已作废」并释放设备；0 = 不自动作废');
    const resumeField = makeNumberField('中途退出可恢复窗口（小时）', '', 0, 720,
      '超出窗口后重新打开链接会从知情同意页重新开始（旧会话仍留档）；0 = 不限制');
    const qLimitField = makeNumberField('普通用户问卷数量上限（份）', '', 1, 10000,
      '普通账号可创建的问卷数量；管理员账号不受此限制。默认 10。');
    const eLimitField = makeNumberField('普通用户实验模板上限（个）', '', 1, 10000,
      '普通账号可创建/导入的实验模板数量；管理员账号不受此限制。默认 10。');
    grid.append(abandonField.wrap, resumeField.wrap, qLimitField.wrap, eLimitField.wrap);
    const saveRow = el('div', 'avatar-btns');
    const saveBtn = el('button', 'primary-btn', '保存全局设置');
    saveBtn.type = 'button';
    saveBtn.onclick = async () => {
      saveBtn.disabled = true;
      try {
        const res = await api('/api/admin/settings', {
          body: {
            abandonAfterMinutes: Number(abandonField.input.value) || 0,
            resumeWindowHours: Number(resumeField.input.value) || 0,
            maxQuestionnairesPerUser: Number(qLimitField.input.value) || 10,
            maxExperimentsPerUser: Number(eLimitField.input.value) || 10
          }
        });
        toast('全局设置已保存');
        abandonField.input.value = String(res.settings.abandonAfterMinutes);
        resumeField.input.value = String(res.settings.resumeWindowHours);
        qLimitField.input.value = String(res.settings.maxQuestionnairesPerUser);
        eLimitField.input.value = String(res.settings.maxExperimentsPerUser);
      } catch (err) {
        toast(err.message || '保存失败，请重试');
      } finally {
        saveBtn.disabled = false;
      }
    };
    saveRow.appendChild(saveBtn);
    secGlobal.append(grid, saveRow);
    panel.appendChild(secGlobal);
    api('/api/admin/settings').then((res) => {
      abandonField.input.value = String(res.settings.abandonAfterMinutes);
      resumeField.input.value = String(res.settings.resumeWindowHours);
      qLimitField.input.value = String(res.settings.maxQuestionnairesPerUser);
      eLimitField.input.value = String(res.settings.maxExperimentsPerUser);
    }).catch(() => { /* 非管理员或未登录：忽略 */ });
  }

  // 头像
  const secAvatar = sectionHead('头像', '支持 PNG / JPG / WebP，自动压缩后保存。');
  const avatarRow = el('div', 'avatar-row');
  const avatarBox = avatarNode(state.user, 72);
  avatarRow.appendChild(avatarBox);
  const fileBtn = el('button', 'ghost-btn', '上传新头像');
  fileBtn.type = 'button';
  const fileInput = el('input');
  fileInput.type = 'file';
  fileInput.accept = 'image/*';
  fileInput.classList.add('hidden');
  const removeBtn = el('button', 'ghost-btn', '移除头像');
  removeBtn.type = 'button';
  const btnRow = el('div', 'avatar-btns');
  btnRow.append(fileBtn, removeBtn);
  avatarRow.appendChild(btnRow);
  secAvatar.appendChild(avatarRow);
  panel.appendChild(secAvatar);

  fileBtn.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    const file = fileInput.files && fileInput.files[0];
    fileInput.value = '';
    if (!file) return;
    if (!/^image\//.test(file.type)) { toast('请选择图片文件'); return; }
    const reader = new FileReader();
    reader.onload = () => {
      // 圆形裁剪预览：拖动调整位置、滚轮缩放，确认后输出 256×256
      openAvatarCropper(reader.result, async (dataUrl) => {
        try {
          await saveMyAvatar(dataUrl);
          const fresh = avatarNode(state.user, 72);
          avatarBox.replaceWith(fresh);
          toast('头像已更新');
        } catch (err) {
          if (!maybeSessionExpired(err)) toast(err.message || '头像保存失败');
        }
      });
    };
    reader.readAsDataURL(file);
  });
  removeBtn.addEventListener('click', async () => {
    try {
      await saveMyAvatar('');
      const fresh = avatarNode(state.user, 72);
      avatarBox.replaceWith(fresh);
      toast('已移除头像');
    } catch (err) {
      if (!maybeSessionExpired(err)) toast(err.message || '操作失败');
    }
  });
  panel.appendChild(fileInput);

  // 智能助手（头像 / 名称）：被试端聊天页顶栏与每条助手消息旁展示；跟随本账号，未设置回落默认
  const secAssistant = sectionHead('智能助手', '被试端聊天页顶部与每条助手消息旁展示。头像支持 PNG / JPG / WebP，自动压缩后保存；名称留空则使用默认名称。');
  const assistantRow = el('div', 'avatar-row');
  const assistantBox = assistantNode(72);
  assistantRow.appendChild(assistantBox);
  const aFileBtn = el('button', 'ghost-btn', '上传助手头像');
  aFileBtn.type = 'button';
  const aFileInput = el('input');
  aFileInput.type = 'file';
  aFileInput.accept = 'image/*';
  aFileInput.classList.add('hidden');
  const aResetBtn = el('button', 'ghost-btn', '恢复默认圆形');
  aResetBtn.type = 'button';
  const aBtnRow = el('div', 'avatar-btns');
  aBtnRow.append(aFileBtn, aResetBtn);
  assistantRow.appendChild(aBtnRow);
  secAssistant.appendChild(assistantRow);

  const assistantNameField = makeField('助手名称（留空使用默认）', state.user.assistantName || '');
  assistantNameField.input.placeholder = '人工智能助手';
  assistantNameField.input.maxLength = 40;
  secAssistant.appendChild(assistantNameField.wrap);
  const aNameRow = el('div', 'avatar-btns');
  const aNameSaveBtn = el('button', 'primary-btn', '保存助手名称');
  aNameSaveBtn.type = 'button';
  aNameSaveBtn.onclick = async () => {
    const name = assistantNameField.input.value.trim();
    aNameSaveBtn.disabled = true;
    try {
      await saveAssistantConfig({ name });
      toast(name ? '助手名称已更新' : '已恢复默认助手名称');
    } catch (err) {
      if (!maybeSessionExpired(err)) toast(err.message || '保存失败，请重试');
    } finally {
      aNameSaveBtn.disabled = false;
    }
  };
  aNameRow.appendChild(aNameSaveBtn);
  secAssistant.appendChild(aNameRow);
  panel.appendChild(secAssistant);

  aFileBtn.addEventListener('click', () => aFileInput.click());
  aFileInput.addEventListener('change', () => {
    const file = aFileInput.files && aFileInput.files[0];
    aFileInput.value = '';
    if (!file) return;
    if (!/^image\//.test(file.type)) { toast('请选择图片文件'); return; }
    const reader = new FileReader();
    reader.onload = () => {
      openAvatarCropper(reader.result, async (dataUrl) => {
        try {
          await saveAssistantConfig({ avatar: dataUrl });
          assistantBox.replaceWith(assistantNode(72));
          toast('助手头像已更新');
        } catch (err) {
          if (!maybeSessionExpired(err)) toast(err.message || '助手头像保存失败');
        }
      });
    };
    reader.readAsDataURL(file);
  });
  aResetBtn.addEventListener('click', async () => {
    try {
      await saveAssistantConfig({ avatar: '' });
      assistantBox.replaceWith(assistantNode(72));
      toast('已恢复默认助手头像');
    } catch (err) {
      if (!maybeSessionExpired(err)) toast(err.message || '操作失败');
    }
  });
  panel.appendChild(aFileInput);

  // 账号信息
  const secInfo = sectionHead('账号信息');
  const infoRow = el('div', 'kv-row');
  infoRow.appendChild(el('span', 'kv-key', '用户账号'));
  infoRow.appendChild(el('span', 'kv-val', state.user.username));
  secInfo.appendChild(infoRow);
  const roleRow = el('div', 'kv-row');
  roleRow.appendChild(el('span', 'kv-key', '角色'));
  roleRow.appendChild(el('span', 'kv-val', state.user.role === 'admin' ? '管理员' : '普通主试'));
  secInfo.appendChild(roleRow);
  if (state.user.role === 'admin') {
    const usersBtn = el('button', 'ghost-btn', '用户管理');
    usersBtn.type = 'button';
    usersBtn.addEventListener('click', () => { location.hash = '#/users'; });
    secInfo.appendChild(usersBtn);
  }
  panel.appendChild(secInfo);

  // 修改密码
  const secPwd = sectionHead('修改密码', '修改后其他设备上的登录会立即失效（需用新密码重新登录），本设备继续使用。');
  const oldField = makeField('当前密码', '');
  oldField.input.type = 'password';
  const newField = makeField('新密码（至少 10 位）', '');
  newField.input.type = 'password';
  const newField2 = makeField('确认新密码', '');
  newField2.input.type = 'password';
  secPwd.append(oldField.wrap, newField.wrap, newField2.wrap);
  const pwdBtn = el('button', 'primary-btn', '保存新密码');
  pwdBtn.type = 'button';
  pwdBtn.addEventListener('click', async () => {
    const oldPassword = oldField.input.value;
    const newPassword = newField.input.value;
    if (!oldPassword || newPassword.length < 10) { toast('请填写当前密码，新密码至少 10 位'); return; }
    if (newPassword !== newField2.input.value) { toast('两次输入的新密码不一致'); return; }
    pwdBtn.disabled = true;
    // 改密会让旧 token 全部失效（踢下线），当前设备用服务端换发的新 token 继续
    const remembered = !!loadRememberedTokenRecord();
    try {
      const res = await api('/api/auth/password', { body: { oldPassword, newPassword, remember: remembered } });
      if (res && res.token) storeToken(res.token, remembered);
      // 「记住账号密码」里存的是旧密码：同步成新密码，下次自动填充才能登录
      try {
        const rec = JSON.parse(localStorage.getItem(LOGIN_REMEMBER_KEY) || 'null');
        if (rec && rec.username) {
          rec.password = newPassword;
          rec.expiresAt = Date.now() + 30 * 24 * 60 * 60 * 1000;
          localStorage.setItem(LOGIN_REMEMBER_KEY, JSON.stringify(rec));
        }
      } catch { /* 忽略 */ }
      oldField.input.value = newField.input.value = newField2.input.value = '';
      toast('密码已修改，其他设备上的登录已失效');
    } catch (err) {
      if (!maybeSessionExpired(err)) toast(err.message || '密码修改失败');
    } finally {
      pwdBtn.disabled = false;
    }
  });
  secPwd.appendChild(pwdBtn);
  panel.appendChild(secPwd);

  // 退出登录
  const secOut = sectionHead('登录状态');
  const outBtn = el('button', 'ghost-btn danger', '退出登录');
  outBtn.type = 'button';
  outBtn.addEventListener('click', async () => {
    try { await api('/api/auth/logout', { body: {} }); } catch { /* 忽略 */ }
    state.token = '';
    state.user = null;
    clearTokens();
    showLogin('');
  });
  secOut.appendChild(outBtn);
  panel.appendChild(secOut);

  $main.appendChild(panel);
}


export { saveMyAvatar, assistantNode, saveAssistantConfig, openAvatarCropper, renderSettings };
