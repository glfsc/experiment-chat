'use strict';

import { $, $main, state } from '../core/state.js';
import { api, maybeSessionExpired, reloadQuestionnaires } from '../core/api.js';
import { el, toast, closeModal, showModalError, makeField, sectionHead, copyText } from '../core/ui.js';
import { setSidebarMode } from '../core/layout.js';
import { editorShell, markPreviewStale } from '../features/editor-shell.js';
import { editorContext } from '../features/editor-context.js';
import { buildItemEditor } from '../features/item-editor.js';
import { renderOutline, restoreOutlineOnEnter } from '../features/outline.js';
import { openQrModal, fillParticipantLink, qrIconSvg } from '../core/qr.js';
import { UNNAMED_Q, stripLocal, questionCount } from '../features/item-model.js';

async function renderQEditor(id) {
  let questionnaire;
  try {
    questionnaire = (await api(`/api/admin/questionnaire?id=${encodeURIComponent(id)}`)).questionnaire;
  } catch (err) {
    if (maybeSessionExpired(err)) return;
    $main.className = 'admin-main';
    $main.innerHTML = '';
    $main.appendChild(el('p', 'data-empty', err.message || '问卷不存在'));
    return;
  }
  state.editingQ = {
    id: questionnaire.id,
    title: questionnaire.title,
    items: questionnaire.items.map((it) => ({ ...it, collapsed: false }))
  };
  state.selected = null;
  state.qBaseline = JSON.stringify({ n: questionnaire.title, i: questionnaire.items.map(stripLocal) });
  setSidebarMode('outline');       // 题目已就绪，切到题目大纲
  renderQEditorBody();
}

function renderQEditorBody() {
  editorContext.ctx = null;               // 页面重建期间先失效，构建完由 buildItemEditor 重新挂上
  const q = state.editingQ;
  const body = el('div');

  const secBasic = sectionHead('问卷信息', '问卷 = 一条链接 + 一列题目 + 计时默认值。链接自动生成（8 位不透明短码），被试打开即作答。');
  secBasic.id = 'sec-basic';
  const titleField = makeField('问卷名称', q.title === UNNAMED_Q ? '' : q.title, 1);
  titleField.input.placeholder = '请填写问卷名称';
  titleField.input.addEventListener('input', () => { q.title = titleField.input.value; });
  secBasic.appendChild(titleField.wrap);
  const linkRow = el('div', 'link-row');
  const linkInput = el('input');
  linkInput.type = 'text';
  linkInput.readOnly = true;
  fillParticipantLink(linkInput, `/chat?q=${q.id}`);
  linkInput.addEventListener('click', () => linkInput.select());
  const copyBtn = el('button', 'ghost-btn', '复制链接');
  copyBtn.onclick = () => copyText(linkInput.value, '链接已复制');
  const qrBtn = el('button', 'ghost-btn qr-btn', '二维码');
  qrBtn.type = 'button';
  qrBtn.title = '二维码（扫码直达本问卷）';
  qrBtn.prepend(qrIconSvg(14));
  qrBtn.onclick = () => openQrModal({
    title: `问卷二维码 · ${q.title}`,
    posterTitle: q.title,
    path: `/chat?q=${q.id}`,
    note: '被试扫码直达本问卷的作答页。'
  });
  linkRow.append(linkInput, copyBtn, qrBtn);
  secBasic.appendChild(linkRow);
  body.appendChild(secBasic);

  const secItems = sectionHead(`题目编排（${questionCount(q.items)} 道 · 默认全部展开）`, '问卷默认已含欢迎语（空）、知情同意页、结束语（空）、结束说明页，均可编辑或删除。可逐题插入、批量插入打分题，或整组插入实验模板后逐条修改。');
  secItems.id = 'sec-items';
  const editor = buildItemEditor(q.items, {
    withTemplateInsert: true,
    onChange: () => {
      secItems.querySelector('.section-title').textContent = `题目编排（${questionCount(q.items)} 道 · 默认全部展开）`;
      markPreviewStale();
      renderOutline();
    }
  });
  secItems.appendChild(editor.wrap);
  body.appendChild(secItems);
  editorContext.ctx = editor;          // 关键：点大纲 / 点题卡时靠它就地更新选中态（否则编辑区不会跟着选中）

  // 「显示全卷」：把每道题的正文拼成一份全文，通读 + 整卷统一改排版（字号 / 加粗等）。
  // 按钮就放在「保存问卷」左边；进全卷后文案变成「返回分题编辑」。
  const fullBtn = el('button', 'ghost-btn', '显示全卷');
  fullBtn.type = 'button';
  fullBtn.title = '把每道题的正文拼成一份全文：通读全卷、整卷统一改字号 / 加粗（每题之间用分割线分开）';
  fullBtn.onclick = () => {
    if (editor.inFullView()) {
      if (editor.exitFullView()) fullBtn.textContent = '显示全卷';
      return;
    }
    editor.showFullView();
    fullBtn.textContent = '返回分题编辑';
  };

  // 保存：名称必填。按钮保存留在编辑页（继续改，不想改了由用户自己点「← 返回列表」）；
  // 只有「返回列表」确认弹窗里的保存（opts.exit）才保存完直接回列表。
  const doSave = async (opts = {}) => {
    const title = (q.title || '').trim();
    if (!title || title === UNNAMED_Q) {
      const msg = '请先填写问卷名称';
      if (opts.modal) { showModalError(msg); return false; }
      toast(msg);
      titleField.input.focus();
      return false;
    }
    // 在全卷视图里点保存：先按分割线切分写回分题（切分不合法就中止，别把整卷写成一道题）
    const applied = editor.applyFullView();
    if (applied !== true) {
      const msg = `分割线数量不对：识别到 ${applied.got} 段 / 应为 ${applied.want} 题。每题之间要留一条分割线（不要增删），改好再保存。`;
      if (opts.modal) { showModalError(msg); return false; }
      toast(msg);
      return false;
    }
    shell.saveBtn.disabled = true;
    try {
      await api('/api/admin/questionnaire/update', {
        body: { id: q.id, title, items: q.items.map(stripLocal) }
      });
      await reloadQuestionnaires();
      state.qBaseline = JSON.stringify({ n: title, i: q.items.map(stripLocal) });
      toast('已保存问卷');
      if (opts.modal) closeModal();
      if (opts.exit) location.hash = '#/q';
      else shell.setTitle(`修改问卷 · ${title}`);      // 留在编辑页：改了名字标题也立刻跟着变
      return true;
    } catch (err) {
      toast(err.message || '保存失败，请重试');
      return false;
    } finally {
      shell.saveBtn.disabled = false;
    }
  };

  const shell = editorShell({
    title: `修改问卷 · ${(q.title && q.title !== UNNAMED_Q) ? q.title : '未命名'}`,
    backHash: '#/q',
    saveLabel: '保存问卷',
    hint: `共 ${questionCount(q.items)} 道题`,
    body,
    phoneTitle: q.title || '未命名问卷',
    withTrial: true,
    onSave: doSave,
    barButtons: [fullBtn],
    isDirty: () => (editor.inFullView() && editor.fullDirty()) || JSON.stringify({ n: q.title, i: q.items.map(stripLocal) }) !== state.qBaseline
  });
  markPreviewStale();
  // 题卡已挂载：装回大纲状态（默认折叠到最高层 / 恢复上次退出的展开状态与所在题目）
  restoreOutlineOnEnter();
}


export { renderQEditor, renderQEditorBody };
