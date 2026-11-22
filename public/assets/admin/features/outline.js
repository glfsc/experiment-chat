'use strict';

import { $, $sidebarOutline, state, currentEditing, itemTypeLabel, isMobile } from '../core/state.js';
import { el } from '../core/ui.js';
import { editorContext } from './editor-context.js';
import {
  itemLevel, levelRank, levelDepth, limitBadges, itemSummary, questionCount, questionNos
} from './item-model.js';

// 大纲：层级树（高级包含低级）+ 折叠箭头 + 跟随编辑区滚动的高亮
// 层级 0 = 默认（顶层）；1–4 = 依次缩进。「紧跟其后、层级更深」的题目视为下属。
// 折叠状态与「看到哪儿了」都记在本机（见下面的 OUTLINE_KEY_PREFIX 一段）：
//   进入编辑页默认**折叠到最高层**（只显示最大级别，下属不显示），点行 / 滚到某一题会自动展开它的上级。
const outlineCollapsed = new Set();      // 大纲里被折叠的题目 id（进入时按本机记录恢复，没记录 = 只显示最高层）
let outlineActiveId = null;              // 大纲里当前高亮的那一行（滚动跟随 / 点击都改它）
let outlineSyncing = false;
let outlineSyncRaf = null;

/* ---- 大纲状态本机记忆 ------------------------------------------------
   键：expchat_outline_<q|exp>_<实体 id>（按问卷 / 模板分开记，互不串）。
   值：{ collapsed: [被折叠的题 id], selected: 当前题 id, scrollTop: 编辑区滚动位置, outlineScroll: 大纲滚动位置 }。
   为什么要记：编辑一份 40 道题的问卷，中途离开（返回列表 / 关掉页面）后再进来，
   除了「大纲长什么样」要还原，还应该直接落回上次看到的那道题，而不是回到第一题。 */
const OUTLINE_KEY_PREFIX = 'expchat_outline_';
function outlineStorageKey() {
  const target = currentEditing();
  if (!target || !target.id) return '';
  return `${OUTLINE_KEY_PREFIX}${state.view === 'exp-editor' ? 'exp' : 'q'}_${target.id}`;
}
function loadOutlineState() {
  const key = outlineStorageKey();
  if (!key) return null;
  try { const raw = localStorage.getItem(key); return raw ? JSON.parse(raw) || null : null; } catch { return null; }
}
// 没有历史记录时的默认：所有「有下属」的题都折叠 → 大纲只剩最高层那几行
function outlineDefaultCollapsed(items) {
  const out = [];
  for (let i = 0; i < items.length; i += 1) if (outlineHasChildren(items, i)) out.push(items[i].id);
  return out;
}
// 写回本机记录：折叠集合 + 当前题 + 两处滚动位置（都已不在题里的 id 会被丢掉）
function saveOutlineState() {
  const key = outlineStorageKey();
  const target = currentEditing();
  if (!key || !target) return;
  const items = target.items || [];
  const ids = new Set(items.map((x) => x.id));
  const sc = document.querySelector('.editor-scroll');
  const payload = {
    collapsed: [...outlineCollapsed].filter((id) => ids.has(id)),
    selected: ids.has(state.selected) ? state.selected : '',
    // 「看到哪儿了」= 编辑区可见顶部的那一题（滚动跟随的高亮行）；没滚过就用选中的那一题
    at: ids.has(outlineActiveId) ? outlineActiveId : (ids.has(state.selected) ? state.selected : ''),
    scrollTop: Math.round((sc && sc.scrollTop) || 0),
    outlineScroll: Math.round(($sidebarOutline && $sidebarOutline.scrollTop) || 0)
  };
  try { localStorage.setItem(key, JSON.stringify(payload)); } catch { /* 忽略 */ }
}
let outlineSaveTimer = null;
function scheduleSaveOutlineState() {
  window.clearTimeout(outlineSaveTimer);
  outlineSaveTimer = window.setTimeout(saveOutlineState, 260);
}
// 进入编辑页：装回折叠状态 → 把上次看的那道题瞬时落回原处 → 高亮跟上。
// 题卡在这一步已经挂载（各编辑器 body 渲染完调用），所以可以直接定位。
function restoreOutlineOnEnter() {
  const target = currentEditing();
  if (!target) return;
  const saved = loadOutlineState();
  const items = target.items || [];
  const known = new Set(items.map((x) => x.id));
  outlineCollapsed.clear();
  if (isMobile()) {
    // 手机端：每次进入都默认折叠到最高层（小屏上整棵大纲铺开几乎不可用，也不恢复本机的展开 / 选中位置）。
    // 抽屉里点 ▸ 仍可临时展开看下属；点大纲行跳到该题并收起抽屉
    for (const id of outlineDefaultCollapsed(items)) outlineCollapsed.add(id);
    renderOutline();
    syncOutlineActive();
    return;
  }
  const ids = saved && Array.isArray(saved.collapsed) ? saved.collapsed : outlineDefaultCollapsed(items);
  for (const id of ids) if (known.has(id)) outlineCollapsed.add(id);
  renderOutline();
  const wantId = saved && saved.selected && known.has(saved.selected) ? saved.selected : '';
  const atId = saved && saved.at && known.has(saved.at) ? saved.at : '';
  if (wantId) {
    state.selected = wantId;
    outlineActiveId = wantId;
    if (editorContext.ctx && typeof editorContext.ctx.select === 'function') editorContext.ctx.select(wantId);
    const card = document.querySelector(`.qcard[data-id="${wantId}"]`);
    if (card) scrollEditorTo(card, false);      // 瞬时（不再是「滑过去」）：进来就该已在原处
  } else if (atId) {
    // 上次只是滚到了某一题（没有选中态）：把那一题落回可见顶部，不动选中态
    const card = document.querySelector(`.qcard[data-id="${atId}"]`);
    if (card) scrollEditorTo(card, false);
  } else if (saved && Number.isFinite(saved.scrollTop)) {
    const sc = document.querySelector('.editor-scroll');
    if (sc) sc.scrollTop = Math.max(0, saved.scrollTop);
  }
  if ($sidebarOutline && saved && Number.isFinite(saved.outlineScroll)) {
    $sidebarOutline.scrollTop = Math.max(0, saved.outlineScroll);
  }
  syncOutlineActive();
  saveOutlineState();                            // 恢复过程本身（自动展开上级）也记一笔
}
// 关页面 / 切到后台前把最后的位置落下来（滚动记录是节流的，可能还差最后一笔）
window.addEventListener('pagehide', saveOutlineState);
document.addEventListener('visibilitychange', () => { if (document.hidden) saveOutlineState(); });

function outlineHasChildren(items, i) {
  return i + 1 < items.length && levelRank(itemLevel(items[i + 1])) < levelRank(itemLevel(items[i]));
}
// 折叠之后仍然可见的行（被折叠父题的下属全部隐藏）
function outlineVisibleIndexes(items) {
  const rows = [];
  let hideLowerThan = null;
  for (let i = 0; i < items.length; i += 1) {
    const rank = levelRank(itemLevel(items[i]));
    if (hideLowerThan != null && rank < hideLowerThan) continue;      // 更小的级别 = 下属 → 藏起来
    hideLowerThan = null;
    rows.push(i);
    if (outlineCollapsed.has(items[i].id) && outlineHasChildren(items, i)) hideLowerThan = rank;
  }
  return rows;
}
// 某题的全部上级（用于「滚动到某题时自动展开它的上级」）
function outlineAncestors(items, index) {
  const chain = [];
  let rank = levelRank(itemLevel(items[index]));
  for (let i = index - 1; i >= 0 && rank < 4; i -= 1) {
    const up = levelRank(itemLevel(items[i]));
    if (up > rank) { chain.push(items[i]); rank = up; }
  }
  return chain;
}
// 编辑区滚到某道题的「开头」：
//   ① 只滚编辑区自身（不用 scrollIntoView —— 它会把外层 .admin-main 一起滚，整页一移，右边手机栏就只剩最下面一条）
//   ② 顶部要让开粘性操作条（否则题卡顶被压在操作条下面，看着像「跳到了题目下面」）
//   ③ 窄屏（≤980px）编辑区不自己滚（overflow: visible），这时改滚整页
//   ④ 默认平滑下滑（smooth），点一下就「滑」过去而不是瞬间闪过去
// 只把某一行「保持在可视区内」：超出才动，且动得最少（用户手动滚大纲时不会被拽回去）
function keepRowVisible(container, node, gap) {
  if (!container || !node) return;
  const gapPx = gap == null ? 10 : gap;
  const cRect = container.getBoundingClientRect();
  const nRect = node.getBoundingClientRect();
  if (nRect.top < cRect.top + gapPx) container.scrollTop += nRect.top - cRect.top - gapPx;
  else if (nRect.bottom > cRect.bottom - gapPx) container.scrollTop += nRect.bottom - cRect.bottom + gapPx;
}
function editorStickyPad() {
  const bar = document.querySelector('.editor-scroll .editor-actionbar');
  return (bar ? bar.getBoundingClientRect().height : 0) + 10;
}
// 平滑滚动：不用浏览器自带 behavior:'smooth'（长距离时它的时长不可控，几万像素要滑好几秒，
// 途中大纲高亮会一直跟着路过中间那些题）。这里自己做一段短缓动：150–300ms，落点精确。
let editorScrollAnim = null;
function animateScrollTop(el, target) {
  if (!el) return 0;
  if (editorScrollAnim) { window.cancelAnimationFrame(editorScrollAnim.raf); editorScrollAnim = null; }
  const from = el.scrollTop;
  const dist = target - from;
  const dur = Math.max(150, Math.min(300, 130 + Math.abs(dist) / 60));
  if (Math.abs(dist) < 2) { el.scrollTop = target; return 0; }
  const t0 = performance.now();
  const ease = (t) => 1 - Math.pow(1 - t, 3);
  const step = () => {
    const p = Math.min(1, (performance.now() - t0) / dur);
    el.scrollTop = from + dist * ease(p);
    if (p < 1) editorScrollAnim = { raf: window.requestAnimationFrame(step) };
    else { editorScrollAnim = null; el.scrollTop = target; }
  };
  editorScrollAnim = { raf: window.requestAnimationFrame(step) };
  return dur;
}
// 动画结束后按最终布局校正落点：只留最后一次（连点几下不再排出好几个迟到的校正，越点越晃）
let editorScrollFix = null;
function cancelEditorScrollFix() {
  if (editorScrollFix) { window.clearTimeout(editorScrollFix); editorScrollFix = null; }
}
// 用户一动手就停掉正在跑的滚动动画与待校正，并解除高亮钉住（立刻恢复「滚到哪高亮哪」）
function cancelEditorScrollAnim() {
  if (editorScrollAnim) { window.cancelAnimationFrame(editorScrollAnim.raf); editorScrollAnim = null; }
  cancelEditorScrollFix();
  outlinePin = null;
}
function scrollEditorTo(node, smooth = true) {
  const sc = document.querySelector('.editor-scroll');
  if (!sc || !node) return 0;
  const pad = editorStickyPad();
  // 目标位置：把这道题的开头放到「粘性操作条下面」
  const targetOf = (el) => {
    const delta = node.getBoundingClientRect().top - el.getBoundingClientRect().top - pad;
    return Math.max(0, Math.min(el.scrollHeight - el.clientHeight, el.scrollTop + delta));
  };
  // 选中态 / 「就地插入」行会让上方内容高度变化 → 动画结束后按最终布局校正一次（瞬时 ±几像素，不再是第二段动画）
  const correctLater = (el, dur) => {
    cancelEditorScrollFix();
    editorScrollFix = window.setTimeout(() => {
      editorScrollFix = null;
      const d = node.getBoundingClientRect().top - el.getBoundingClientRect().top - pad;
      if (Math.abs(d) > 4) el.scrollTop = Math.max(0, Math.min(el.scrollHeight - el.clientHeight, el.scrollTop + d));
    }, (dur || 200) + 60);
  };
  if (sc.scrollHeight > sc.clientHeight + 1) {
    if (!smooth) { cancelEditorScrollFix(); sc.scrollTop = targetOf(sc); return 0; }
    const dur = animateScrollTop(sc, targetOf(sc));
    correctLater(sc, dur);
    return dur;
  }
  // 编辑区不滚（窄屏堆叠）：滚整页
  const docEl = document.scrollingElement || document.documentElement;
  if (smooth) {
    const dur = animateScrollTop(docEl, targetOf(docEl));
    correctLater(docEl, dur);
    return dur;
  }
  cancelEditorScrollFix();
  for (let i = 0; i < 2; i += 1) {
    const d2 = node.getBoundingClientRect().top - (pad + 8);
    if (Math.abs(d2) < 2) break;
    window.scrollTo(0, Math.max(0, window.scrollY + d2));
  }
  return 0;
}
// 程序化滚动（平滑）期间把大纲高亮钉在目标题上：否则滚动途中跟随逻辑会把高亮甩到中途的题
let outlinePin = null;
let outlinePinTimer = null;
function pinOutlineHighlight(id, ms = 900) {
  outlinePin = { id, until: Date.now() + ms };
  // 钉住结束后自动重算一次：万一这期间用户滚过（高亮被钉住没跟），这里补上
  window.clearTimeout(outlinePinTimer);
  outlinePinTimer = window.setTimeout(() => { outlinePin = null; syncOutlineActive(); }, ms + 30);
}

// 大纲高亮：只有「高亮的那一行」真的换了才碰 DOM。
// 滚动跟随时每帧都会走到这里，连点大纲切换题目时也不该全表扫一遍。
let outlineActiveRow = null;
function paintOutlineActive(id) {
  const next = id ? $sidebarOutline.querySelector(`.ol-item[data-id="${id}"]`) : null;
  if (next !== outlineActiveRow) {
    if (outlineActiveRow) outlineActiveRow.classList.remove('on');
    if (next) next.classList.add('on');
    outlineActiveRow = next;
  }
  return next;
}

// 编辑区滚到哪一题，大纲里对应那一行就背景高亮（必要时自动展开它的上级）
function syncOutlineActive() {
  if (outlineSyncing || state.sidebarMode !== 'outline' || !$sidebarOutline) return;
  const sc = document.querySelector('.editor-scroll');
  if (!sc) return;
  // 平滑滚动进行中：高亮钉在目标题上（等滚完了再恢复按位置跟随），
  // 钉住期间不必扫位置——滚动每帧都会走到这里，省掉整列测量。
  let activeId = null;
  if (outlinePin && Date.now() < outlinePin.until) {
    activeId = outlinePin.id;
  } else {
    outlinePin = null;
    const top = sc.getBoundingClientRect().top;
    const topGap = editorStickyPad();      // 粘性操作条以下的区域才算「可见顶部」
    for (const card of sc.querySelectorAll('.qcard[data-id]')) {
      if (card.getBoundingClientRect().bottom - top > topGap) { activeId = card.dataset.id; break; }
    }
  }
  const target = currentEditing();
  let forceKeep = false;                     // 刚自动展开过上级 → 行位置全变了，这一行必须重新拉进视野
  if (activeId && target) {
    const idx = target.items.findIndex((x) => x.id === activeId);
    if (idx >= 0) {
      let changed = false;
      for (const parent of outlineAncestors(target.items, idx)) {
        if (outlineCollapsed.delete(parent.id)) changed = true;
      }
      if (changed) {
        outlineSyncing = true;
        try { renderOutline(); } finally { outlineSyncing = false; }
        forceKeep = true;
        // 不 return：重画后继续往下走，把高亮落到当前这一题上
        // （重画时 outlineSyncing 为真，里面那次 syncOutlineActive 会跳过）
      }
    }
  }
  const prevActiveId = outlineActiveId;
  outlineActiveId = activeId;
  const activeRow = paintOutlineActive(activeId);
  // 只「保持可见」：不把这一行硬拽到顶部 —— 否则用户手动滚大纲会被一次次拽回去（像是滚不动）。
  // 而且只在**高亮行真的换了**时才保持可见：跟随编辑区滚动时高亮会换行 → 大纲跟着走；
  // 用户自己滚大纲时编辑区没动、高亮行没换 → 一个字都不碰，往上往下都滚得动（issue：选完题后大纲锁住）。
  if (activeRow && (forceKeep || activeId !== prevActiveId)) keepRowVisible($sidebarOutline, activeRow, 10);
}
// 点大纲 / 点题卡共用的一条路：选中该题 → 就地更新选中态（含「就地插入」行）→ 平滑滑到它的开头。
// 滑动期间把大纲高亮钉在这一行上（否则跟随逻辑会把高亮甩到路过的题），滑动时长由滚动动画给出。
function focusItem(id) {
  const target = currentEditing();
  if (!target || !target.items.some((x) => x.id === id)) return;
  state.selected = id;
  outlineActiveId = id;
  if (editorContext.ctx && typeof editorContext.ctx.select === 'function') editorContext.ctx.select(id);
  const card = document.querySelector(`.qcard[data-id="${id}"]`);
  const dur = card ? scrollEditorTo(card, true) : 0;
  pinOutlineHighlight(id, dur + 140);
  syncOutlineActive();       // 立刻把高亮落到这一行；钉住期间跟随逻辑不会把它甩走
  scheduleSaveOutlineState();   // 「看到哪一题」也记在本机（平滑滚动期间节流写，落定后再写一次）
  window.setTimeout(() => { if (state.selected === id) saveOutlineState(); }, dur + 260);
}

// 用户自己滚动 / 点按编辑区时，立即停掉程序化滚动动画（不和用户抢）
document.addEventListener('wheel', cancelEditorScrollAnim, { capture: true, passive: true });
document.addEventListener('touchstart', cancelEditorScrollAnim, { capture: true, passive: true });
document.addEventListener('mousedown', (e) => { if (e.target && e.target.closest && e.target.closest('.editor-scroll')) cancelEditorScrollAnim(); }, true);

// 捕获阶段的 scroll 不冒泡，但用 capture 能收到所有后代的滚动（编辑区每次渲染都是新元素）
document.addEventListener('scroll', () => {
  if (outlineSyncRaf) return;
  outlineSyncRaf = window.requestAnimationFrame(() => {
    outlineSyncRaf = null;
    syncOutlineActive();
    scheduleSaveOutlineState();      // 编辑区 / 大纲滚到哪儿了，节流记一笔
  });
}, true);

function renderOutline() {
  const target = currentEditing();
  if (!target || !$sidebarOutline) return;
  const items = target.items;
  const outlineScroll = $sidebarOutline.scrollTop;
  $sidebarOutline.innerHTML = '';
  outlineActiveRow = null;          // 整表重画：原来记着的高亮行已随旧 DOM 一起丢掉

  for (const [label, anchor] of [
    [state.view === 'exp-editor' ? '模板信息' : '问卷信息', 'sec-basic'],
    [`题目编排（${questionCount(items)} 道）`, 'sec-items']
  ]) {
    const sec = el('div', 'ol-sec', label);
    sec.onclick = () => {
      const node = $(anchor);
      if (node) scrollEditorTo(node);
    };
    $sidebarOutline.appendChild(sec);
  }

  const qnos = questionNos(items);
  let lastBand = null;
  for (const idx of outlineVisibleIndexes(items)) {
    const it = items[idx];
    if (it.fromTemplateId && it.fromTemplateId !== lastBand) {
      lastBand = it.fromTemplateId;
      const band = el('div', 'ol-band');
      band.append(el('span', '', '来自模板'), el('span', 'line'));
      $sidebarOutline.appendChild(band);
    } else if (!it.fromTemplateId) lastBand = null;

    const lv = itemLevel(it);
    const qno = qnos.get(it.id);
    const row = el('div', 'ol-item d' + levelDepth(lv) + (qno ? '' : ' no-q'));
    row.dataset.id = it.id;

    // 有下属（紧跟其后、层级更深的题目）→ 左边给折叠箭头
    if (outlineHasChildren(items, idx)) {
      const folded = outlineCollapsed.has(it.id);
      const fold = el('button', 'ol-fold', folded ? '▸' : '▾');
      fold.type = 'button';
      fold.title = folded ? '展开下属题目' : '折叠下属题目';
      fold.addEventListener('click', (e) => {
        e.stopPropagation();
        if (folded) outlineCollapsed.delete(it.id); else outlineCollapsed.add(it.id);
        renderOutline();
        saveOutlineState();          // 折叠状态记在本机：下次进来还是这个样子
      });
      row.appendChild(fold);
    } else {
      row.appendChild(el('span', 'ol-fold-space'));
    }

    row.appendChild(el('span', 'ol-num', qno ? String(qno) : '·'));
    row.appendChild(el('span', 'ic', TYPE_ICON(it.type)));
    row.appendChild(el('span', 'tx', it.title || '（未命名）'));
    // 行里不再显示「x 级」与参数数量：层级靠缩进一眼可见，参数在题卡上另有徽标，
    // 这两块挤掉的是标题的显示宽度（大纲能看到更多标题字）
    row.title = `${itemTypeLabel(it)} · ${it.title || ''}`;
    // 点大纲：选中该题并「平滑滑」到该题开头（不是瞬间跳过去）。
    // 只就地更新选中态与高亮，不整列重建题卡、也不重画大纲——否则点一下就要为每道题重造一次正文编辑器。
    row.onclick = () => focusItem(it.id);
    $sidebarOutline.appendChild(row);
  }
  $sidebarOutline.scrollTop = outlineScroll;
  syncOutlineActive();
}

function TYPE_ICON(type) {
  return { message: '▤', gate: '⛨', confirm: '▣', debrief: '◎', group: '▦', rating: '☆', single: '◉', multi: '☑', text: '▭', rank: '↕' }[type] || '·';
}

// 大纲里的标题就地更新：改「大纲标题」输入框（或正文首行自动回填标题）时调用。
// 不整表重画 —— 重画会把大纲的滚动位置、折叠状态与高亮再算一遍，输入时每敲一个字都跳一下。
function updateOutlineTitle(id) {
  const target = currentEditing();
  if (!target || !$sidebarOutline) return;
  const it = target.items.find((x) => x.id === id);
  if (!it) return;
  const row = $sidebarOutline.querySelector(`.ol-item[data-id="${id}"]`);
  if (!row) return;                                   // 菜单模式 / 该题被折叠：不用管
  const tx = row.querySelector('.tx');
  if (tx) tx.textContent = it.title || '（未命名）';
  row.title = `${itemTypeLabel(it)} · ${it.title || ''}`;
}


export {
  outlineCollapsed,
  outlineActiveId,
  outlineSyncing,
  outlineSyncRaf,
  outlineStorageKey,
  loadOutlineState,
  outlineDefaultCollapsed,
  saveOutlineState,
  scheduleSaveOutlineState,
  restoreOutlineOnEnter,
  outlineHasChildren,
  outlineVisibleIndexes,
  outlineAncestors,
  keepRowVisible,
  editorStickyPad,
  animateScrollTop,
  cancelEditorScrollFix,
  cancelEditorScrollAnim,
  scrollEditorTo,
  pinOutlineHighlight,
  paintOutlineActive,
  syncOutlineActive,
  focusItem,
  renderOutline,
  TYPE_ICON,
  updateOutlineTitle
};
