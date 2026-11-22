'use strict';

import { $, $main, state } from '../core/state.js';
import { api, maybeSessionExpired, reloadQuestionnaires } from '../core/api.js';
import { el, toast, copyText, openModal, closeModal, showModalError, formatTime } from '../core/ui.js';
import { openQrModal, fillParticipantLink, qrIconSvg } from '../core/qr.js';
import { numberedCopyTitle, openShareModal } from '../features/create-share.js';
import { openNewItemModal } from '../features/new-item.js';
import { UNNAMED_Q, itemSummary } from '../features/item-model.js';

function renderQList() {
  $main.className = 'admin-main';
  $main.innerHTML = '';
  const head = el('div', 'panel-head');
  const box = el('div', 'grow');
  box.append(
    el('h2', '', '问卷管理'),
    el('p', 'panel-sub', '每份问卷 = 一条链接 + 一列题目 + 计时默认值。可逐题插入、批量插入打分题，或整组插入实验模板后逐条修改；数据按问卷隔离，被试编号按进入顺序自动分配。')
  );
  const headActions = el('div', 'head-actions');
  const btn = el('button', 'primary-btn', '+ 新建问卷');
  btn.onclick = () => openNewItemModal({ kind: 'q' });
  headActions.append(btn);
  head.append(box, headActions);
  $main.appendChild(head);

  if (!state.questionnaires.length) {
    $main.appendChild(el('p', 'data-empty', '还没有问卷。点击右上角「+ 新建问卷」创建：默认含欢迎语（空）、知情同意页、结束语（空）、结束说明页。'));
    return;
  }
  const wrap = el('div', 'data-table-wrap');
  const table = el('table', 'data-table q-table');
  const thead = el('thead');
  const tr = el('tr');
  for (const t of ['问卷名称', '被试链接', '题目数', '数据量', '创建时间', '操作']) tr.appendChild(el('th', '', t));
  thead.appendChild(tr);
  const tbody = el('tbody');
  for (const q of state.questionnaires) {
    const row = el('tr');
    const td1 = el('td');
    td1.append(el('div', 'cell-strong', q.title), el('code', 'cell-code', q.id));
    row.appendChild(td1);

    const td2 = el('td', 'q-link-cell');
    const linkRow = el('div', 'link-row');
    const input = el('input');
    input.type = 'text';
    input.readOnly = true;
    fillParticipantLink(input, `/chat?q=${q.id}`);
    input.addEventListener('click', () => input.select());
    const copy = el('button', 'ghost-btn', '复制');
    copy.onclick = (e) => { e.stopPropagation(); copyText(input.value, '链接已复制'); };
    linkRow.append(input, copy);
    td2.appendChild(linkRow);
    row.appendChild(td2);

    row.appendChild(el('td', '', `${q.itemCount} 道`));
    row.appendChild(el('td', '', `${q.sessionCount} 份`));
    row.appendChild(el('td', '', formatTime(q.createdAt)));

    const td6 = el('td');
    const actions = el('div', 'row-actions');
    const bQr = el('button', 'ghost-btn qr-icon-btn');
    bQr.type = 'button';
    bQr.title = '二维码（扫码直达本问卷）';
    bQr.appendChild(qrIconSvg(14));
    bQr.onclick = (e) => {
      e.stopPropagation();
      openQrModal({
        title: `问卷二维码 · ${q.title}`,
        posterTitle: q.title,
        path: `/chat?q=${q.id}`,
        note: '被试扫码直达本问卷的作答页。可保存图片后打印张贴或发到群里，被试扫一扫即可开始，不用再粘贴链接。'
      });
    };
    const bEdit = el('button', 'ghost-btn', '编辑');
    bEdit.onclick = (e) => { e.stopPropagation(); location.hash = `#/q/${q.id}`; };
    const bData = el('button', 'ghost-btn', '数据');
    bData.onclick = (e) => { e.stopPropagation(); location.hash = `#/q/${q.id}/data`; };
    const bCopy = el('button', 'ghost-btn', '复制');
    bCopy.onclick = (e) => { e.stopPropagation(); createQuestionnaireDirect({ copyFrom: q }); };
    const bShare = el('button', 'ghost-btn', '分享');
    bShare.onclick = (e) => { e.stopPropagation(); openShareModal({ kind: 'q', id: q.id, name: q.title }); };
    const bDel = el('button', 'ghost-btn danger', '删除');
    bDel.onclick = (e) => { e.stopPropagation(); removeQuestionnaire(q); };
    actions.append(bQr, bEdit, bData, bShare, bCopy, bDel);
    td6.appendChild(actions);
    row.appendChild(td6);
    row.addEventListener('dblclick', () => { location.hash = `#/q/${q.id}`; });
    tbody.appendChild(row);
  }
  table.append(thead, tbody);
  wrap.appendChild(table);
  $main.appendChild(wrap);
}

// 直接创建（免填名）：新建立即进入编辑器；复制停留在列表页（自动编号（1）（2）…）
async function createQuestionnaireDirect({ copyFrom, title: customTitle }) {
  let created;
  try {
    const title = copyFrom
      ? numberedCopyTitle(copyFrom.title, state.questionnaires.map((q) => q.title))
      : (String(customTitle || '').trim() || UNNAMED_Q);
    created = (await api('/api/admin/questionnaire/create', { body: { title, copyFrom: copyFrom ? copyFrom.id : '' } })).questionnaire;
  } catch (err) {
    toast(err.message || '创建失败，请重试');
    return;
  }
  await reloadQuestionnaires();
  if (copyFrom) {
    toast(`已复制为「${created.title}」，点击「编辑」修改`);
    renderQList();
    return;
  }
  toast('已创建问卷，进入编辑');
  location.hash = `#/q/${created.id}`;
}

function removeQuestionnaire(q) {
  let force = q.sessionCount > 0;
  openModal({
    title: '删除问卷',
    body: el('p', 'modal-note', force
      ? `「${q.title}」已有 ${q.sessionCount} 份被试数据，删除将连同全部作答与对话记录一并清空，且不可恢复。`
      : `确定删除问卷「${q.title}」？该操作不可恢复。`),
    confirmLabel: '确认删除',
    danger: true,
    onConfirm: async () => {
      try {
        await api('/api/admin/questionnaire/delete', { body: { id: q.id, force } });
      } catch (err) {
        if (err.code === 'has_sessions') force = true;
        return showModalError(err.message || '删除失败，请重试');
      }
      await reloadQuestionnaires();
      closeModal();
      toast('已删除问卷');
      renderQList();
    }
  });
}


export { renderQList, createQuestionnaireDirect, removeQuestionnaire };
