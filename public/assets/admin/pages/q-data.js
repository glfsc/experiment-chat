'use strict';

import { $, $main, state } from '../core/state.js';
import { api, maybeSessionExpired } from '../core/api.js';
import { el, toast, copyText, openModal, closeModal, showModalError, formatTime, formatDuration, sectionHead } from '../core/ui.js';
import { setTopbar, setTopbarBack } from '../core/layout.js';
import { fillParticipantLink } from '../core/qr.js';
import { RichText } from '../core/richtext.js';
import { questionCount } from '../features/item-model.js';

/* ---------------------------------------------------------------- 数据页 */

async function renderQData(id) {
  $main.className = 'admin-main';
  $main.innerHTML = '';
  const head = el('div', 'editor-head');
  const back = el('button', 'ghost-btn', '← 返回问卷列表');
  back.onclick = () => { location.hash = '#/q'; };
  head.appendChild(back);
  $main.appendChild(head);

  let data;
  try {
    data = await api(`/api/admin/questionnaire/sessions?id=${encodeURIComponent(id)}`);
  } catch (err) {
    if (maybeSessionExpired(err)) return;
    $main.appendChild(el('p', 'data-empty', err.message || '数据加载失败'));
    return;
  }
  // 口径 = 题号（与编辑器的「题目编排（N 道）」一致）：材料消息与页面环节（知情同意 / 确认 / 结束说明）不占题号
  const { questionnaire, sessions, totalQuestions } = data;
  const qCount = questionCount(questionnaire.items);
  setTopbar(`${questionnaire.title} · 数据`);      // 手机端顶栏
  setTopbarBack(true);

  const panel = el('div', 'data-panel');
  const phead = el('div', 'panel-head');
  const box = el('div', 'grow');
  box.append(el('h2', '', `${questionnaire.title} · 数据`), el('p', 'panel-sub', `共 ${sessions.length} 位被试 · 问卷共 ${qCount} 道题（另有 ${questionnaire.itemCount - qCount} 条材料与页面环节）。点击一行查看该被试的完整作答与对话。`));
  // 状态筛选先建好：下面的「导出 Excel」要读它的当前值（此前它在空数据集分支里不会被初始化，点导出会报错）
  const statusSel = el('select', 'filter-select');
  // 默认不含「已作废」（重做 / 太久没提交被系统作废的会话）——需要时选「全部（含已作废）」
  [['', '默认（不含已作废）'], ['in_progress', '进行中'], ['completed', '已完成'], ['abandoned', '已作废'], ['all', '全部（含已作废）']].forEach(([v, label]) => {
    const o = el('option', '', label);
    o.value = v;
    statusSel.appendChild(o);
  });
  const exportBtn = el('button', 'ghost-btn', '导出 Excel');
  // 导出跟随当前状态筛选：默认不含已作废（选了「已作废 / 全部（含已作废）」才导出它们）
  exportBtn.onclick = () => {
    const v = statusSel.value;
    exportXlsx(questionnaire, v === 'abandoned' || v === 'all');
  };
  const delBtn = el('button', 'ghost-btn danger', '删除数据');
  phead.append(box, exportBtn, delBtn);
  panel.appendChild(phead);

  const linkRow = el('div', 'link-row');
  const linkInput = el('input');
  linkInput.type = 'text';
  linkInput.readOnly = true;
  fillParticipantLink(linkInput, `/chat?q=${questionnaire.id}`);
  linkInput.addEventListener('click', () => linkInput.select());
  const copyBtn = el('button', 'ghost-btn', '复制链接');
  copyBtn.onclick = () => copyText(linkInput.value, '链接已复制');
  linkRow.append(linkInput, copyBtn);
  panel.appendChild(linkRow);

  if (!sessions.length) {
    panel.appendChild(el('p', 'data-empty', '暂无被试数据。把链接发给被试，提交后这里会实时汇总。'));
    $main.appendChild(panel);
    return;
  }

  // 筛选：状态 / 最短时长（分钟）；statusSel 已在上面创建（导出按钮要读它），这里只挂进筛选行
  const filterRow = el('div', 'data-filters');
  filterRow.appendChild(el('span', 'lbl', '筛选：'));
  const minDur = el('input', 'filter-num');
  minDur.type = 'number';
  minDur.min = '0';
  minDur.placeholder = '时长≥(分钟)';
  const resetBtn = el('button', 'mini-btn', '重置');
  resetBtn.type = 'button';
  resetBtn.onclick = () => { statusSel.value = ''; minDur.value = ''; applyFilters(); };
  filterRow.append(statusSel, minDur, resetBtn);
  panel.appendChild(filterRow);

  const wrap = el('div', 'data-table-wrap');
  const countBar = el('p', 'filter-count');
  const table = el('table', 'data-table');
  const thead = el('thead');
  const tr = el('tr');
  const checkTh = el('th', 'check-col hidden');
  const checkAll = el('input');
  checkAll.type = 'checkbox';
  checkTh.appendChild(checkAll);
  tr.appendChild(checkTh);
  for (const t of ['编号', '状态', '作答进度', '开始时间', '结束时间', '时长']) tr.appendChild(el('th', '', t));
  thead.appendChild(tr);
  const tbody = el('tbody');
  table.append(thead, tbody);
  wrap.appendChild(table);
  wrap.appendChild(countBar);
  panel.appendChild(wrap);
  $main.appendChild(panel);

  // 勾选删除模式
  let deleteMode = false;
  const selectedIds = new Set();

  const syncActionButtons = () => {
    checkTh.classList.toggle('hidden', !deleteMode);
    checkAll.checked = selectedIds.size > 0 && selectedIds.size === visibleRows().length;
    delBtn.textContent = deleteMode ? `删除所选（${selectedIds.size}）` : '删除数据';
    delBtn.classList.toggle('danger', true);
    if (deleteMode && selectedIds.size) delBtn.textContent = `删除所选（${selectedIds.size}）`;
  };

  const visibleRows = () => sessions.filter((s) => {
    // 默认（空值）不含「已作废」；'all' = 全部；其余按状态精确筛选
    if (statusSel.value === 'all') { /* 全部 */ }
    else if (statusSel.value) { if (s.status !== statusSel.value) return false; }
    else if (s.status === 'abandoned') return false;
    const minMinutes = Number(minDur.value) || 0;
    if (minMinutes > 0 && (s.durationSec == null || s.durationSec < minMinutes * 60)) return false;
    return true;
  });

  function renderRows() {
    const rows = visibleRows();
    tbody.innerHTML = '';
    countBar.textContent = `显示 ${rows.length} / ${sessions.length} 条记录`;
    for (const s of rows) {
      const row = el('tr', deleteMode ? 'delete-mode' : '');
      const checkTd = el('td', 'check-col' + (deleteMode ? '' : ' hidden'));
      const cb = el('input');
      cb.type = 'checkbox';
      cb.checked = selectedIds.has(s.id);
      cb.addEventListener('change', () => {
        if (cb.checked) selectedIds.add(s.id);
        else selectedIds.delete(s.id);
        syncActionButtons();
      });
      checkTd.appendChild(cb);
      row.appendChild(checkTd);
      row.append(
        el('td', 'cell-strong', s.seq == null ? '—' : `#${s.seq}`),
        el('td', '', s.statusLabel),
        el('td', '', `${s.answeredQuestions} / ${totalQuestions}`),
        el('td', '', formatTime(s.startedAt)),
        el('td', '', formatTime(s.endedAt)),
        el('td', '', formatDuration(s.durationSec))
      );
      row.onclick = (e) => {
        if (deleteMode) {
          if (e.target.tagName !== 'INPUT') cb.checked = !cb.checked;
          if (cb.checked) selectedIds.add(s.id);
          else selectedIds.delete(s.id);
          syncActionButtons();
          return;
        }
        location.hash = `#/q/${questionnaire.id}/s/${s.id}`;
      };
      tbody.appendChild(row);
    }
    syncActionButtons();
  }

  function applyFilters() {
    selectedIds.clear();
    renderRows();
  }
  statusSel.addEventListener('change', applyFilters);
  minDur.addEventListener('input', applyFilters);
  checkAll.addEventListener('change', () => {
    const rows = visibleRows();
    if (checkAll.checked) rows.forEach((s) => selectedIds.add(s.id));
    else selectedIds.clear();
    renderRows();
  });

  delBtn.onclick = () => {
    if (!deleteMode) {
      deleteMode = true;
      selectedIds.clear();
      renderRows();
      return;
    }
    if (!selectedIds.size) { toast('请先勾选要删除的记录'); return; }
    openModal({
      title: '删除数据',
      body: el('p', 'modal-note', `确定删除所选的 ${selectedIds.size} 条被试记录吗？连同其全部作答与对话记录一并清空，且不可恢复。`),
      confirmLabel: '确认删除',
      danger: true,
      onConfirm: async () => {
        try {
          await api('/api/admin/questionnaire/sessions/delete', { body: { id: questionnaire.id, ids: [...selectedIds] } });
        } catch (err) {
          return showModalError(err.message || '删除失败，请重试');
        }
        closeModal();
        toast(`已删除 ${selectedIds.size} 条记录`);
        // 重新加载本页数据
        renderQData(id);
      }
    });
  };

  renderRows();
}

async function exportXlsx(questionnaire, includeAbandoned) {
  try {
    const qs = `id=${encodeURIComponent(questionnaire.id)}${includeAbandoned ? '&includeAbandoned=1' : ''}`;
    const res = await fetch(`/api/admin/questionnaire/export.xlsx?${qs}`, {
      headers: { Authorization: `Bearer ${state.token}` }
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.message || `导出失败（${res.status}）`);
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${questionnaire.title}.xlsx`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 3000);
    toast(`已开始下载：${questionnaire.title}.xlsx`);
  } catch (err) {
    toast(err.message || '导出失败，请重试');
  }
}

async function renderQSession(id, sid) {
  $main.className = 'admin-main';
  $main.innerHTML = '';
  const head = el('div', 'editor-head');
  const back = el('button', 'ghost-btn', '← 返回数据列表');
  back.onclick = () => { location.hash = `#/q/${id}/data`; };
  head.appendChild(back);
  $main.appendChild(head);

  let data;
  try {
    data = await api(`/api/admin/questionnaire/session?id=${encodeURIComponent(id)}&sid=${encodeURIComponent(sid)}`);
  } catch (err) {
    if (maybeSessionExpired(err)) return;
    $main.appendChild(el('p', 'data-empty', err.message || '会话加载失败'));
    return;
  }
  const { questionnaire, session, messages, responses } = data;
  setTopbar(`${questionnaire.title} · 被试 #${session.seq == null ? '—' : session.seq}`);   // 手机端顶栏
  setTopbarBack(true);

  const panel = el('div', 'data-panel');
  const ph = el('div', 'panel-head');
  const box = el('div', 'grow');
  box.append(el('h2', '', `${questionnaire.title} · 被试 #${session.seq == null ? '—' : session.seq}`));
  ph.appendChild(box);
  panel.appendChild(ph);

  const secMeta = sectionHead('会话信息');
  const grid = el('div', 'meta-grid');
  for (const [label, value] of [
    ['状态', session.statusLabel],
    ['开始时间', formatTime(session.startedAt)],
    ['结束时间', formatTime(session.endedAt)],
    ['时长', formatDuration(session.durationSec)],
    ['作答进度', `${session.answeredQuestions} / ${session.totalQuestions} 题`],
    ['浏览器', (session.userAgent || '').slice(0, 60) || '——']
  ]) {
    const item = el('div', 'meta-item');
    item.append(el('span', 'meta-label', label), el('span', 'meta-value', value));
    grid.appendChild(item);
  }
  secMeta.appendChild(grid);
  panel.appendChild(secMeta);

  const secResp = sectionHead('作答明细', '按题目顺序排列；呈现/作答时间为服务端记录，耗时为前端上报。');
  const tw = el('div', 'data-table-wrap');
  const table = el('table', 'data-table resp-table');
  const thead = el('thead');
  const tr = el('tr');
  for (const t of ['题目', '题型', '作答', '对错', '呈现时间', '作答时间', '耗时']) tr.appendChild(el('th', '', t));
  thead.appendChild(tr);
  const tbody = el('tbody');
  for (const r of responses) {
    const row = el('tr');
    row.append(
      el('td', 'cell-strong', r.itemLabel),
      el('td', '', r.itemTypeLabel),
      el('td', '', r.itemType === 'text' ? r.text : r.optionLabel || '—'),
      el('td', '', r.isCorrect || '—'),
      el('td', '', formatTime(r.presentedAt)),
      el('td', '', formatTime(r.answeredAt)),
      el('td', '', r.elapsedMs == null ? '—' : `${Math.round(r.elapsedMs / 100) / 10} 秒`)
    );
    tbody.appendChild(row);
  }
  table.append(thead, tbody);
  tw.appendChild(table);
  secResp.appendChild(tw);
  panel.appendChild(secResp);

  const secMsg = sectionHead('对话记录', '被试端界面中实际呈现的全部消息（正文为其清洗后的富文本）。');
  const timeline = el('div', 'msg-timeline');
  for (const m of messages) {
    const item = el('div', m.role === 'user' ? 'msg-item' : 'msg-item msg-ai');
    const h = el('div', 'msg-head');
    // 「延迟发出」参数已从平台移除：这里只对历史数据（旧库里带 visible_at 的消息）显示
    const delayed = m.visible_at && new Date(m.visible_at).getTime() > new Date(m.created_at).getTime() + 1000;
    h.append(
      el('span', 'msg-role', m.role === 'user' ? '被试' : '系统'),
      el('span', 'msg-time', formatTime(m.created_at) + (delayed ? ' · 延迟发出' : ''))
    );
    item.append(h);
    // 思考过程：被试端在正文之前以此面板呈现（默认折叠），此处同样可折叠展开核对
    if (m.thinking) {
      const det = el('details', 'msg-think');
      const thinkSec = Math.round(Number(m.think_ms) / 100) / 10;
      det.appendChild(el('summary', '', `深度思考面板（用时 ${Number.isInteger(thinkSec) ? thinkSec : thinkSec.toFixed(1)} 秒）`));
      det.appendChild(el('p', 'msg-content msg-content-think', m.thinking));
      item.appendChild(det);
    }
    const contentNode = el('div', 'msg-content rich');
    contentNode.innerHTML = RichText.sanitizeHtml(m.content);
    item.appendChild(contentNode);
    timeline.appendChild(item);
  }
  secMsg.appendChild(timeline);
  panel.appendChild(secMsg);
  $main.appendChild(panel);
}


export { renderQData, exportXlsx, renderQSession };
