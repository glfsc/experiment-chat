'use strict';

import { api } from '../core/api.js';
import { el, makeField, openModal, closeModal } from '../core/ui.js';
import { extractShareCode } from './create-share.js';
import { UNNAMED_EXP, UNNAMED_Q } from './item-model.js';

// 新建 / 复制弹窗要回头刷新列表并进入编辑器；由 main.js 注入页面函数，
// 避免 features -> pages 的反向依赖（也是 ESM 循环依赖的来源）。
let handlers = null;
export function initNewItem(next) { handlers = next; }


// 「新建」弹窗：编号留空 = 新建空白（与原来「+ 新建」一键行为一致）；填了编号 = 按编号复制（可跨账号）
function openNewItemModal({ kind, prefillCode = '' }) {
  const isExp = kind === 'exp';
  const body = el('div');
  const nameField = makeField(isExp ? '实验名称（可选）' : '问卷名称（可选）', '');
  nameField.input.placeholder = isExp ? UNNAMED_EXP : UNNAMED_Q;
  const codeField = makeField('分享编号（可选）', prefillCode);
  codeField.input.placeholder = '粘贴编号，或整条问卷 / 分享链接';
  body.append(nameField.wrap, codeField.wrap);
  body.appendChild(el('p', 'modal-note',
    `填写分享编号会按编号复制一份${isExp ? '实验模板' : '问卷'}到你的账号（题目相同，链接与作答数据独立）；留空则新建空白${isExp ? '实验模板' : '问卷'}。`));
  openModal({
    title: isExp ? '新建实验模板' : '新建问卷',
    body,
    confirmLabel: '创建',
    onConfirm: async () => {
      const rawCode = codeField.input.value.trim();
      const code = extractShareCode(rawCode);
      if (rawCode && !code) throw new Error('编号格式不正确：请粘贴编号，或完整的问卷 / 分享链接');
      const title = nameField.input.value.trim();
      if (code) {
        const res = await api(isExp ? '/api/admin/experiment/import' : '/api/admin/questionnaire/import',
          { body: isExp ? { code, name: title } : { code, title } });
        closeModal();
        if (handlers && handlers.onImported) await handlers.onImported(kind, res);
        return;
      }
      // 空白新建：立即创建并进入编辑器，与原来的「+ 新建」按钮行为一致
      closeModal();
      if (handlers && handlers.onCreate) await handlers.onCreate(kind, title);
    }
  });
  nameField.input.focus();
}

// 分享链接 /admin?import=CODE[&as=exp]：登录进入后跳到对应列表并打开「新建」弹窗预填编号
function consumePendingImport() {
  const params = new URLSearchParams(location.search);
  const raw = params.get('import') || '';
  if (!raw) return;
  const kind = params.get('as') === 'exp' ? 'exp' : 'q';
  const code = extractShareCode(raw);
  try { history.replaceState(null, '', location.pathname + location.hash); } catch { /* 忽略 */ }
  location.hash = kind === 'exp' ? '#/exp' : '#/q';
  if (code) openNewItemModal({ kind, prefillCode: code });
}

export { openNewItemModal, consumePendingImport };
