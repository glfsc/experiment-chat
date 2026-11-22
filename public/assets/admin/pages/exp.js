'use strict';

import { $, $main, state, currentEditing } from '../core/state.js';
import { api, maybeSessionExpired, reloadExperiments } from '../core/api.js';
import { el, toast, openModal, closeModal, showModalError, makeField, sectionHead } from '../core/ui.js';
import { setSidebarMode } from '../core/layout.js';
import { editorShell, markPreviewStale } from '../features/editor-shell.js';
import { editorContext } from '../features/editor-context.js';
import { buildItemEditor } from '../features/item-editor.js';
import { renderOutline, restoreOutlineOnEnter } from '../features/outline.js';
import { numberedCopyTitle, openShareModal } from '../features/create-share.js';
import { openNewItemModal } from '../features/new-item.js';
import { UNNAMED_EXP, stripLocal, questionCount } from '../features/item-model.js';

function renderExpList() {
  $main.className = 'admin-main';
  $main.innerHTML = '';
  const head = el('div', 'panel-head');
  const box = el('div', 'grow');
  box.append(
    el('h2', '', '实验管理'),
    el('p', 'panel-sub', '实验是可复用的题目模板：一套题目 + 计时默认值。问卷「插入实验」时整组复制其题目，复制后即可逐条修改。')
  );
  const btn = el('button', 'primary-btn', '+ 新建实验');
  btn.onclick = () => openNewItemModal({ kind: 'exp' });
  head.append(box, btn);
  $main.appendChild(head);

  if (!state.experiments.length) {
    $main.appendChild(el('p', 'data-empty', '还没有实验模板。点击右上角「+ 新建实验」，或先复制一份既有模板再修改。'));
    return;
  }
  const wrap = el('div', 'data-table-wrap');
  const table = el('table', 'data-table exp-table');
  const thead = el('thead');
  const tr = el('tr');
  for (const t of ['实验名称', '模板 ID', '题目数', '被问卷引用', '操作']) tr.appendChild(el('th', '', t));
  thead.appendChild(tr);
  const tbody = el('tbody');
  for (const exp of state.experiments) {
    const row = el('tr');
    const td1 = el('td');
    td1.append(el('div', 'cell-strong', exp.name), el('code', 'cell-code', exp.id));
    row.appendChild(td1);
    row.appendChild(el('td', '', exp.id));
    row.appendChild(el('td', '', `${exp.itemCount} 道`));
    row.appendChild(el('td', '', `${exp.usedBy} 份`));
    const td6 = el('td');
    const actions = el('div', 'row-actions');
    const bCopy = el('button', 'ghost-btn', '复制');
    bCopy.onclick = (e) => { e.stopPropagation(); createExperimentDirect({ copyFrom: exp }); };
    const bShare = el('button', 'ghost-btn', '分享');
    bShare.onclick = (e) => { e.stopPropagation(); openShareModal({ kind: 'exp', id: exp.id, name: exp.name }); };
    const bDel = el('button', 'ghost-btn danger', '删除');
    bDel.onclick = (e) => { e.stopPropagation(); removeExperiment(exp); };
    const bEdit = el('button', 'ghost-btn', '进入编辑');
    bEdit.onclick = (e) => { e.stopPropagation(); location.hash = `#/exp/${exp.id}`; };
    actions.append(bCopy, bShare, bDel, bEdit);
    td6.appendChild(actions);
    row.appendChild(td6);
    row.onclick = () => { location.hash = `#/exp/${exp.id}`; };
    tbody.appendChild(row);
  }
  table.append(thead, tbody);
  wrap.appendChild(table);
  $main.appendChild(wrap);
}

async function renderExpEditor(id) {
  let experiment;
  try {
    experiment = (await api(`/api/admin/experiment?id=${encodeURIComponent(id)}`)).experiment;
  } catch (err) {
    if (maybeSessionExpired(err)) return;
    $main.className = 'admin-main';
    $main.innerHTML = '';
    $main.appendChild(el('p', 'data-empty', err.message || '实验不存在'));
    return;
  }
  state.editingExp = { id: experiment.id, name: experiment.name, items: experiment.items.map((it) => ({ ...it, collapsed: false })) };
  state.selected = null;
  state.expBaseline = JSON.stringify({ n: experiment.name, i: experiment.items.map(stripLocal) });
  setSidebarMode('outline');       // 题目已就绪，切到题目大纲
  renderExpEditorBody();
}

// 未命名占位名：编辑器里显示为空，保存 / 返回保存时强制填写
function renderExpEditorBody() {
  editorContext.ctx = null;               // 页面重建期间先失效，构建完由 buildItemEditor 重新挂上
  const exp = state.editingExp;
  const body = el('div');

  const secBasic = sectionHead('模板信息', '实验是可复用的题目模板：一套题目。问卷「插入实验」时整组复制其题目，复制后即可逐条修改。');
  secBasic.id = 'sec-basic';
  const nameField = makeField('实验名称', exp.name === UNNAMED_EXP ? '' : exp.name, 1);
  nameField.input.placeholder = '请填写实验名称';
  nameField.input.addEventListener('input', () => { exp.name = nameField.input.value; });
  secBasic.appendChild(nameField.wrap);
  body.appendChild(secBasic);

  const secItems = sectionHead(`题目编排（${questionCount(exp.items)} 道 · 默认全部展开）`, '拖动左侧手柄排序；点题卡即选中并展开，点「折叠」收起。被试端按此顺序呈现。');
  secItems.id = 'sec-items';
  const editor = buildItemEditor(exp.items, {
    onChange: () => {
      secItems.querySelector('.section-title').textContent = `题目编排（${questionCount(exp.items)} 道 · 默认全部展开）`;
      markPreviewStale();
      renderOutline();
    }
  });
  secItems.appendChild(editor.wrap);
  body.appendChild(secItems);
  editorContext.ctx = editor;          // 关键：点大纲 / 点题卡时靠它就地更新选中态（否则编辑区不会跟着选中）

  // 保存：名称必填。按钮保存留在编辑页（与问卷编辑器同一套行为）；
  // 只有「返回列表」确认弹窗里的保存（opts.exit）才保存完直接回列表。
  const doSave = async (opts = {}) => {
    const name = (exp.name || '').trim();
    if (!name || name === UNNAMED_EXP) {
      const msg = '请先填写实验名称';
      if (opts.modal) { showModalError(msg); return false; }
      toast(msg);
      nameField.input.focus();
      return false;
    }
    shell.saveBtn.disabled = true;
    try {
      await api('/api/admin/experiment/update', {
        body: { id: exp.id, name, items: exp.items.map(stripLocal) }
      });
      await reloadExperiments();
      state.expBaseline = JSON.stringify({ n: name, i: exp.items.map(stripLocal) });
      toast('已保存该实验模板');
      if (opts.modal) closeModal();
      if (opts.exit) location.hash = '#/exp';
      else shell.setTitle(`实验 · ${name}`);           // 留在编辑页：改了名字标题也立刻跟着变
      return true;
    } catch (err) {
      toast(err.message || '保存失败，请重试');
      return false;
    } finally {
      shell.saveBtn.disabled = false;
    }
  };

  const shell = editorShell({
    title: `实验 · ${(exp.name && exp.name !== UNNAMED_EXP) ? exp.name : '未命名'}`,
    backHash: '#/exp',
    saveLabel: '保存该实验',
    hint: `模板共 ${exp.items.length} 道题`,
    body,
    phoneTitle: '实验模板预览',
    withTrial: true,
    onSave: doSave,
    isDirty: () => JSON.stringify({ n: exp.name, i: exp.items.map(stripLocal) }) !== state.expBaseline
  });
  markPreviewStale();
  // 题卡已挂载：装回大纲状态（默认折叠到最高层 / 恢复上次退出的展开状态与所在题目）
  restoreOutlineOnEnter();
}


async function createExperimentDirect({ copyFrom, name: customName }) {
  let created;
  try {
    const name = copyFrom
      ? numberedCopyTitle(copyFrom.name, state.experiments.map((e) => e.name))
      : (String(customName || '').trim() || UNNAMED_EXP);
    created = (await api('/api/admin/experiment/create', { body: { name, copyFrom: copyFrom ? copyFrom.id : '' } })).experiment;
  } catch (err) {
    toast(err.message || '创建失败，请重试');
    return;
  }
  await reloadExperiments();
  if (copyFrom) {
    toast(`已复制为「${created.name}」，点击「进入编辑」修改`);
    renderExpList();
    return;
  }
  toast('已创建实验模板，进入编辑');
  location.hash = `#/exp/${created.id}`;
}

function removeExperiment(exp) {
  openModal({
    title: '删除实验模板',
    body: el('p', 'modal-note', `确定删除实验模板「${exp.name}」？删除不影响已插入到问卷里的题目（插入即复制）。`),
    confirmLabel: '确认删除',
    danger: true,
    onConfirm: async () => {
      try {
        await api('/api/admin/experiment/delete', { body: { id: exp.id } });
      } catch (err) {
        return showModalError(err.message || '删除失败，请重试');
      }
      await reloadExperiments();
      closeModal();
      toast('已删除实验模板');
      renderExpList();
    }
  });
}


export {
  renderExpList,
  renderExpEditor,
  renderExpEditorBody,
  createExperimentDirect,
  removeExperiment
};
