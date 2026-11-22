'use strict';

import { $, state, TYPE, TYPE_LABEL, TYPE_LIMITS, LIMIT_META, LIMIT_DEFAULTS, itemTypeLabel } from '../core/state.js';
import { el, makeField, makeNumberField, openModal, closeModal, toast, autoGrowTextarea } from '../core/ui.js';
import { RichText, makeRichField } from '../core/richtext.js';
import { api } from '../core/api.js';
import { editorContext } from './editor-context.js';
import {
  effLimit, questionTypes, isQuestionType, questionNos, itemLevel, levelRank, levelDepth,
  limitBadges, itemSummary
} from './item-model.js';
import { TYPE_ICON, focusItem, updateOutlineTitle, renderOutline } from './outline.js';
import { markPreviewStale } from './editor-shell.js';
import { setSidebarMode } from '../core/layout.js';

/* ---------------------------------------------------------------- 「插入题目」二级选择
   一级列出题型；鼠标悬停到有二级形态的题型（目前只有知情同意页）时，右侧展开二级栏再选。
   触屏没有 hover，所以点一级项同样能展开。 */

let openInsertPicker = null;
document.addEventListener('click', (e) => {
  if (openInsertPicker && !openInsertPicker.contains(e.target)) {
    openInsertPicker.close();
    openInsertPicker = null;
  }
});

function buildInsertPicker(labelText, onPick) {
  const wrap = el('div', 'ins-picker');
  const btn = el('button', 'mini-btn', labelText || '＋ 插入题目');
  btn.type = 'button';
  const panel = el('div', 'ins-panel hidden');
  const sub = el('div', 'ins-sub hidden');
  const variantsOf = (t) => (state.meta.itemVariants || {})[t] || null;

  const close = () => { panel.classList.add('hidden'); sub.classList.add('hidden'); };
  const openSub = (type, row) => {
    const variants = variantsOf(type);
    if (!variants) { sub.classList.add('hidden'); return; }
    sub.innerHTML = '';
    for (const v of variants) {
      const b = el('button', 'ins-item', v.label);
      b.type = 'button';
      b.onclick = (e) => { e.stopPropagation(); close(); onPick(v.key, v.label); };
      sub.appendChild(b);
    }
    sub.style.top = `${row.offsetTop}px`;
    sub.classList.remove('hidden');
  };

  for (const t of TYPE()) {
    const hasSub = !!variantsOf(t);
    const row = el('button', 'ins-item' + (hasSub ? ' has-sub' : ''), `${TYPE_ICON(t)} ${TYPE_LABEL(t)}`);
    row.type = 'button';
    if (hasSub) {
      row.addEventListener('mouseenter', () => openSub(t, row));
      row.onclick = (e) => { e.stopPropagation(); openSub(t, row); };
    } else {
      row.addEventListener('mouseenter', () => sub.classList.add('hidden'));
      row.onclick = (e) => { e.stopPropagation(); close(); onPick(t, TYPE_LABEL(t)); };
    }
    panel.appendChild(row);
  }

  btn.onclick = (e) => {
    e.stopPropagation();
    const willOpen = panel.classList.contains('hidden');
    close();
    if (willOpen) { panel.classList.remove('hidden'); openInsertPicker = wrap; }
    else openInsertPicker = null;
  };
  wrap.close = close;
  // 二级栏挂在一级面板内部：这样它的定位基准是一级面板，紧贴其右缘（挂在外层会以按钮为基准而重叠）
  panel.appendChild(sub);
  wrap.append(btn, panel);
  return wrap;
}


/* ---------------------------------------------------------------- 题目编辑器 */

// 新建消息默认带上「思考过程」参数（可删）：「思考中提示」从此是题目上的一个显式参数，
// 没写思考稿、也没显式配时长时，被试端不会再凭空冒出「正在思考」。
function applyNewItemDefaults(item) {
  if (!item) return item;
  // 大纲标题留空 = 自动取正文首行（正文才是被试看到的内容，标题只服务于管理端列表 / 大纲）
  item.title = '';
  item.html = item.html || '';
  if (item.type === 'message' && item.thinking == null && !item.__thinkingOn) {
    item.__thinkingOn = true;
    if (!item.limits) item.limits = {};
    if (item.limits.thinkMs == null) item.limits.thinkMs = 20000;    // 思考时长默认 20 秒
  }
  return item;
}

// 层级控件（题卡右上角、折叠按钮左边）：下拉可选，也可以双击输入数字。
// 0 = 默认（与顶层同级）；1–4 = 依次缩进。无效输入（a / 9 / 空）一律不改动、保持原值。
function buildLevelControl(item, rerender) {
  const wrap = el('span', 'lv-ctl');
  wrap.appendChild(el('span', 'lv-label', '层级'));
  const input = el('input', 'lv-input');
  input.type = 'text';
  input.inputMode = 'numeric';
  input.value = String(itemLevel(item));
  input.title = '题目层级：1 = 最高级（不缩进，适合当小标题）、2/3/4 依次降低、0 = 最低级（默认，缩进最深）。只影响管理端大纲，被试端无感知';
  const commit = (raw) => {
    const text = String(raw == null ? '' : raw).trim();
    if (!/^\d+$/.test(text)) { input.value = String(itemLevel(item)); return; }   // 非数字（如 a）→ 保持原值
    const n = Number(text);
    if (n < 0 || n > 4) { input.value = String(itemLevel(item)); return; }        // 越界（如 9）→ 保持原值
    if (n > 0) item.level = n; else delete item.level;
    input.value = String(n);
    renderOutline();
  };
  input.addEventListener('mousedown', (e) => e.stopPropagation());
  input.addEventListener('click', (e) => e.stopPropagation());
  input.addEventListener('change', () => commit(input.value));
  input.addEventListener('blur', () => commit(input.value));
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') { commit(input.value); input.blur(); }
    if (e.key === 'Escape') { input.value = String(itemLevel(item)); input.blur(); }
  });
  input.addEventListener('dblclick', (e) => { e.stopPropagation(); input.select(); });

  const caret = el('button', 'mini-btn lv-caret', '▾');
  caret.type = 'button';
  caret.title = '选择层级';
  const panel = el('div', 'lv-panel hidden');
  // 从高到低：1 级 … 4 级，最后是 0（默认·最低级）
  for (const lv of [1, 2, 3, 4, 0]) {
    const text = lv === 0 ? '0 · 默认（最低级）' : lv + ' 级' + (lv === 1 ? '（最高级）' : '');
    const b = el('button', 'mini-btn', text);
    b.type = 'button';
    b.onclick = (e) => { e.stopPropagation(); panel.classList.add('hidden'); commit(String(lv)); };
    panel.appendChild(b);
  }
  caret.addEventListener('mousedown', (e) => e.stopPropagation());
  caret.onclick = (e) => { e.stopPropagation(); panel.classList.toggle('hidden'); };
  wrap.append(input, caret, panel);
  return wrap;
}

function buildItemEditor(list, opts = {}) {
  const wrap = el('div');
  let onChange = opts.onChange || (() => {});

  function rerender() { render(); }

  // 头部工具条上的小按钮（点它别把「选中该题」也一起触发）
  function miniTool(label, title, fn) {
    const b = el('button', 'mini-btn', label);
    b.title = title;
    b.onclick = (ev) => { ev.stopPropagation(); fn(); };
    return b;
  }

  // 选中题卡正下方的「插入题目」入口。它跟着选中项走，所以单独建：
  // 点大纲 / 点题卡时只把这一行搬过去（先撤掉旧的），不必重建整列题卡。
  function buildInsertRow(item) {
    const ins = el('div', 'insert-row');
    // ① 插入单题
    ins.appendChild(el('span', 'lbl', '在此题下方插入题目：'));
    ins.appendChild(buildInsertPicker('＋ 选择题型', (key, label) => {
      const base = JSON.parse(JSON.stringify(state.meta.itemDefaults[key] || { type: key }));
      const created = applyNewItemDefaults({ ...base, id: `new${Date.now().toString(36)}`, limits: {}, collapsed: false, title: base.title || label || TYPE_LABEL(key) });
      list.splice(list.indexOf(item) + 1, 0, created);
      state.selected = created.id;
      toast('已在该题下方插入：' + (label || TYPE_LABEL(key)));
      render();
    }));
    // ② 插入整组实验模板（与「+ 插入整组」等价，但落在选中题下方）
    if (state.experiments.length) {
      ins.appendChild(el('span', 'lbl', '　或插入实验模板：'));
      const tsel = el('select', 'add-select');
      for (const e of state.experiments) {
        const o = el('option', '', e.name);
        o.value = e.id;
        tsel.appendChild(o);
      }
      const tbtn = el('button', 'mini-btn', '+ 插入整组');
      tbtn.onclick = async () => {
        const exp = state.experiments.find((x) => x.id === tsel.value);
        if (!exp) return;
        const full = (await api(`/api/admin/experiment?id=${encodeURIComponent(exp.id)}`)).experiment;
        const stamp = Date.now().toString(36);
        const copies = full.items.map((it2, i) => ({
          ...JSON.parse(JSON.stringify(it2)),
          id: `${stamp}_${i}_${it2.id}`,
          fromTemplateId: full.id,
          fromTemplateName: full.name
        }));
        list.splice(list.indexOf(item) + 1, 0, ...copies);
        state.selected = null;
        toast(`已在下方插入模板「${full.name}」的 ${copies.length} 道题`);
        render();
      };
      ins.append(tsel, tbtn);
    }
    return ins;
  }

  // 单张题卡。结构没变时复用它（整列重建会为每道题重造一次正文编辑器，几十道题连点几下就卡）。
  function buildCard(item, qnos) {
    const card = el('div', 'qcard' + (state.selected === item.id ? ' selected' : '') + (item.collapsed ? ' collapsed' : ''));
    card.dataset.id = item.id;

    const head = el('div', 'qcard-head');
    const handle = el('span', 'drag', '⠿');
    handle.title = '拖动排序';
    handle.draggable = true;
    handle.addEventListener('dragstart', (e) => {
      state.dragId = item.id;
      card.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', item.id);
    });
    handle.addEventListener('dragend', () => {
      state.dragId = null;
      card.classList.remove('dragging');
      wrap.querySelectorAll('.drop-before,.drop-after').forEach((n) => n.classList.remove('drop-before', 'drop-after'));
    });
    card.addEventListener('dragover', (e) => {
      if (!state.dragId || state.dragId === item.id) return;
      e.preventDefault();
      const r = card.getBoundingClientRect();
      const after = e.clientY > r.top + r.height / 2;
      card.classList.toggle('drop-before', !after);
      card.classList.toggle('drop-after', after);
    });
    card.addEventListener('dragleave', () => card.classList.remove('drop-before', 'drop-after'));
    card.addEventListener('drop', (e) => {
      e.preventDefault();
      const r = card.getBoundingClientRect();
      const after = e.clientY > r.top + r.height / 2;
      moveItem(list, state.dragId, item.id, after);
      state.dragId = null;
      toast('已调整顺序');
      render();
    });

    head.appendChild(handle);
    const qno = qnos.get(item.id);
    if (qno) head.appendChild(el('span', 'qnum', `第 ${qno} 题`));
    head.appendChild(el('span', 'qtype', `${TYPE_ICON(item.type)} ${itemTypeLabel(item)}`));
    head.appendChild(el('span', 'qtitle', item.title || '（未命名）'));
    const badges = el('div', 'qbadges');
    for (const b of limitBadges(item)) badges.appendChild(el('span', 'qbadge limit', b));
    head.appendChild(badges);

    const tools = el('div', 'qtools');
    tools.append(
      buildLevelControl(item, render),
      miniTool(item.collapsed ? '展开' : '折叠', '折叠 / 展开该题', () => { item.collapsed = !item.collapsed; render(); }),
      miniTool('复制', '复制该题', () => { const c = JSON.parse(JSON.stringify(item)); c.id = `copy${Date.now()}`; delete c.fromTemplateId; delete c.fromTemplateName; list.splice(list.indexOf(item) + 1, 0, c); toast('已复制'); render(); }),
      miniTool('删除', '删除该题', () => { list.splice(list.indexOf(item), 1); if (state.selected === item.id) state.selected = null; render(); })
    );
    head.appendChild(tools);
    card.appendChild(head);

    if (item.collapsed) {
      card.appendChild(el('p', 'qsum', itemSummary(item)));
    } else {
      const body = el('div', 'qbody');
      body.appendChild(buildItemFields(item, rerender));
      card.appendChild(body);
    }

    // 点题卡头部 = 与点大纲同一条路：选中 + 平滑滑到开头 + 大纲高亮跟着过去
    head.addEventListener('click', () => focusItem(item.id));
    return card;
  }

  // 只更新「选中态」：切 .selected、把「就地插入」行搬过去、必要时展开这一张卡。
  // O(1) 更新——旧实现每次点大纲都整列重建（每道题重造一次正文编辑器 + 重画两遍大纲），连点几下就卡。
  function select(id) {
    const item = list.find((x) => x.id === id);
    if (!item) return false;
    if (item.collapsed) {
      item.collapsed = false;
      const old = wrap.querySelector(`.qcard[data-id="${id}"]`);
      if (old) old.replaceWith(buildCard(item, questionNos(list)));
    }
    wrap.querySelectorAll('.qcard').forEach((c) => c.classList.toggle('selected', c.dataset.id === id));
    wrap.querySelectorAll('.insert-row').forEach((n) => n.remove());
    const card = wrap.querySelector(`.qcard[data-id="${id}"]`);
    if (card) card.insertAdjacentElement('afterend', buildInsertRow(item));
    return true;
  }

  function render() {
    // 保留滚动位置：增删 / 选择 / 拖动后的重渲染不做视觉跳动
    const sc = wrap.closest('.editor-scroll');
    const scrollTop = sc ? sc.scrollTop : 0;
    wrap.innerHTML = '';
    let lastBand = null;
    const qnos = questionNos(list);

    list.forEach((item) => {
      if (item.fromTemplateId && item.fromTemplateId !== lastBand) {
        lastBand = item.fromTemplateId;
        const band = el('div', 'group-band');
        band.append(el('span', 'label', '来自模板：' + (item.fromTemplateName || item.fromTemplateId)), el('span', 'line'));
        const del = el('button', 'mini-btn', '整组删除');
        del.onclick = () => {
          for (let i = list.length - 1; i >= 0; i -= 1) {
            if (list[i].fromTemplateId === item.fromTemplateId) list.splice(i, 1);
          }
          toast('已删除该模板插入的整组题目');
          render();
        };
        band.appendChild(del);
        wrap.appendChild(band);
      } else if (!item.fromTemplateId) lastBand = null;

      wrap.appendChild(buildCard(item, qnos));

      // 选中该题时，在其正下方给出「插入题目」入口（参考问卷星 / Notion 的就地插入）
      if (state.selected === item.id) wrap.appendChild(buildInsertRow(item));
    });

    // 插入区
    const addRow = el('div', 'add-row');
    addRow.appendChild(el('span', 'lbl', '插入题目：'));
    addRow.appendChild(buildInsertPicker('＋ 选择题型', (key, label) => {
      const base = JSON.parse(JSON.stringify(state.meta.itemDefaults[key] || { type: key }));
      const item = applyNewItemDefaults({ ...base, id: `new${Date.now().toString(36)}`, limits: {}, collapsed: false, title: base.title || label || TYPE_LABEL(key) });
      insertItem(list, item);
      state.selected = item.id;
      toast('已插入：' + (label || TYPE_LABEL(key)));
      render();
    }));

    // 批量插入打分题（量表就是多道打分题）
    addRow.appendChild(el('span', 'lbl', '　批量打分题：'));
    const num = el('input', 'add-num');
    num.type = 'number';
    num.value = '5';
    num.min = '1';
    const bulk = el('button', 'mini-btn', '+ 插入 N 道');
    bulk.onclick = () => {
      const n = Math.max(1, Math.min(30, Number(num.value) || 1));
      const items = [];
      for (let i = 0; i < n; i += 1) {
        // 题干进正文（title 置空后由正文首行自动回填），与「插入题目」的默认项同一口径
        const text = `打分题 ${i + 1}`;
        items.push(applyNewItemDefaults({
          id: `rate${Date.now().toString(36)}${i}`,
          type: 'rating',
          title: text,
          html: RichText.textToHtml(text),
          min: 1,
          max: 5,
          anchor: '1 = 完全不同意　·　5 = 完全同意',
          limits: {},
          collapsed: false
        }));
      }
      insertItem(list, ...items);
      toast(`已插入 ${n} 道打分题`);
      render();
    };
    addRow.append(num, bulk);

    if (opts.withTemplateInsert) {
      addRow.appendChild(el('span', 'lbl', '　插入实验模板：'));
      const tsel = el('select', 'add-select');
      for (const e of state.experiments) {
        const o = el('option', '', e.name);
        o.value = e.id;
        tsel.appendChild(o);
      }
      const tbtn = el('button', 'mini-btn', '+ 插入整组');
      tbtn.onclick = async () => {
        const exp = state.experiments.find((x) => x.id === tsel.value);
        if (!exp) return;
        const full = (await api(`/api/admin/experiment?id=${encodeURIComponent(exp.id)}`)).experiment;
        const stamp = Date.now().toString(36);
        const copies = full.items.map((it, i) => ({
          ...JSON.parse(JSON.stringify(it)),
          id: `${stamp}_${i}_${it.id}`,
          fromTemplateId: full.id,
          fromTemplateName: full.name
        }));
        insertItem(list, ...copies);
        toast(`已插入模板「${full.name}」的 ${copies.length} 道题（可逐条修改）`);
        render();
      };
      addRow.append(tsel, tbtn);
    }
    wrap.appendChild(addRow);
    onChange(list);
    if (sc) sc.scrollTop = scrollTop;
  }

  /* ---------------------------------------------------------------- 显示全卷
     把每道题的正文按顺序拼成**一个大编辑器**：题与题之间一条分割线（<hr>），每题正文上方一行
     不可编辑的题目标识（第 N 题 · 题型 · 大纲标题）。
     用途：通读全卷文本、整卷统一改排版（全选 → 改字号 / 加粗）。
     切回分题：按 <hr> 切分（分割线是唯一的分界，标识行自动忽略），段数必须等于题目数。
     字号 / 加粗再怎么改都不影响切分 —— 分割线是元素、不是文字，改不动它。
     只呈现每题的正文（题干）：选项 / 标准答案 / 锚点等字段不进来，不会被批量改字号破坏。 */
  let fullEl = null;
  let fullRich = null;
  let fullActive = false;
  let fullDirty = false;                    // 全卷视图里改过、还没写回分题
  // 分割线带一个 class：题目正文自己若也含 <hr>（粘贴进来的），不会跟分界混为一谈
  const FULL_SEP_CLASS = 'fullv-sep';
  const isFullSep = (node) => !!node.classList && node.classList.contains(FULL_SEP_CLASS);

  const fullLocatorText = (item) => {
    const qno = questionNos(list).get(item.id);
    return `${qno ? `第 ${qno} 题 · ` : ''}${itemTypeLabel(item)} · ${item.title || '（未命名）'}`;
  };
  const buildFullHtml = () => list.map((it) => {
    const loc = `<div class="fullv-head" contenteditable="false">${RichText.escapeText(fullLocatorText(it))}</div>`;
    return `${loc}${it.html || ''}`;
  }).join(`<hr class="${FULL_SEP_CLASS}">`);

  // 按分割线切分编辑器 DOM（浏览器可能把分割线套进段落里，所以递归处理）；
  // isSep 决定哪些 <hr> 算分割线；返回每段的内 HTML 字符串数组 —— 只读原 DOM，不改它。
  const splitByHr = (root, isSep) => {
    const sections = [];
    let curRoot = null;
    let curStack = [];
    let ancestors = [];                       // 当前所在的原 DOM 祖先链（不含 root）
    const openSection = () => {
      curRoot = document.createElement('div');
      sections.push(curRoot);
      curStack = [curRoot];
      for (const a of ancestors) {            // 切段后重建外壳（保留标签与样式）
        const shell = a.cloneNode(false);
        curStack[curStack.length - 1].appendChild(shell);
        curStack.push(shell);
      }
    };
    const walk = (el2) => {
      for (const child of Array.from(el2.childNodes)) {
        if (child.nodeType === 1 && child.tagName === 'HR' && isSep(child)) { openSection(); continue; }
        if (child.nodeType === 1 && child.querySelector && child.querySelector('hr')) {
          const nested = Array.from(child.querySelectorAll('hr')).some(isSep);
          if (!nested) {                       // 里面的分割线不算分界（题目正文自带的）→ 原样搬过去
            curStack[curStack.length - 1].appendChild(child.cloneNode(true));
            continue;
          }
          ancestors.push(child);
          const shell = child.cloneNode(false);
          curStack[curStack.length - 1].appendChild(shell);
          curStack.push(shell);
          walk(child);
          curStack.pop();
          ancestors.pop();
          continue;
        }
        curStack[curStack.length - 1].appendChild(child.cloneNode(true));
      }
    };
    openSection();
    walk(root);
    return sections.map((s) => s.innerHTML);
  };

  // 一段 → item.html：去掉视图内的题目标识行，再走一遍标准清洗
  const cleanSection = (html) => {
    const box = document.createElement('div');
    box.innerHTML = html;
    box.querySelectorAll('.fullv-head, [contenteditable="false"]').forEach((n) => n.remove());
    return RichText.sanitizeHtml(box.innerHTML);
  };

  // 全卷 → 逐题：成功返回 true；分割线数量对不上时返回 { got, want }（不写回任何东西）
  const applyFullView = () => {
    if (!fullActive || !fullRich) return true;
    const root = fullRich.editor;
    // 先按「带 class 的分割线」切；段数不对再退一步按「所有分割线」切（用户删掉再加回来时分界会丢 class）
    let sections = splitByHr(root, isFullSep);
    if (sections.length !== list.length) {
      const all = splitByHr(root, () => true);
      if (all.length === list.length) sections = all;
    }
    if (sections.length !== list.length) return { got: sections.length, want: list.length };
    list.forEach((it, i) => {
      const html = cleanSection(sections[i]);
      if (html === it.html) return;
      it.html = html;
      it.text = RichText.htmlToText(html);            // 正文一改，「正文为空」的判定跟着更新
      if (!String(it.title || '').trim()) it.title = RichText.firstLine(html, 40);
    });
    fullDirty = false;                                 // 已写回分题：不再是「未保存的全卷改动」
    onChange(list);
    return true;
  };

  const fullFailMsg = (res) => `分割线数量不对：识别到 ${res.got} 段 / 应为 ${res.want} 题。`
    + '每题之间要留一条分割线（不要增删），改好再返回。';

  const exitFullView = (opts2 = {}) => {
    if (!fullActive) return true;
    if (!opts2.discard) {
      const res = applyFullView();
      if (res !== true) { toast(fullFailMsg(res)); return false; }
    }
    fullActive = false;
    if (fullEl) fullEl.classList.add('hidden');
    wrap.classList.remove('hidden');
    render();                                  // 用（写回后的）item.html 重画题目列
    setSidebarMode('outline');
    toast(opts2.discard ? '已放弃全卷修改' : '已切回分题编辑');
    return true;
  };

  const buildFullView = () => {
    fullEl = el('div', 'fullview');
    const bar = el('div', 'fullview-bar');
    bar.appendChild(el('span', 'fullview-tip',
      '全卷视图：每道题的正文按顺序排列，题与题之间是一条分割线。'
      + '上方灰色那行是题目标识（不可编辑、不参与切分）；'
      + '分割线是唯一的分界，请不要增删 —— 改完点「返回分题编辑」或直接「保存问卷」。'));
    const backBtn = el('button', 'primary-btn', '返回分题编辑');
    backBtn.type = 'button';
    backBtn.onclick = () => exitFullView();
    const discardBtn = el('button', 'ghost-btn', '放弃修改');
    discardBtn.type = 'button';
    discardBtn.onclick = () => openModal({
      title: '放弃全卷修改',
      body: el('p', 'modal-note', '本次在全卷视图里的改动都不会写回（题目回到进入全卷前的样子）。'),
      confirmLabel: '放弃修改',
      danger: true,
      onConfirm: () => { closeModal(); exitFullView({ discard: true }); }
    });
    bar.append(backBtn, discardBtn);
    fullEl.appendChild(bar);
    fullRich = makeRichField('全卷正文（每道题的正文按顺序排列；分割线 = 题目分界）', '', {
      raw: true, hint: '',
      onChange: () => { fullDirty = true; markPreviewStale(); }   // 全卷里改过 = 有未保存内容（返回时会被问）
    });
    fullEl.appendChild(fullRich.wrap);
    fullEl.appendChild(el('p', 'fullview-note',
      `共 ${list.length} 题。这里只呈现每题的正文（题干）：选项、标准答案、锚点、参数等字段不进入全卷视图，改动不会牵连它们。`));
  };

  // 全卷工具条吸顶的落点：量「顶部操作条」的高度写进 .rich-bar 的 style.top。
  // 操作条自己 sticky 在 top:0（z-index 更高），工具条要吸在它下面，不然会被盖住。
  const stickFullToolbar = () => {
    if (!fullRich) return;
    const barEl = fullRich.wrap.querySelector('.rich-bar');
    if (!barEl) return;
    const ab = document.querySelector('.editor-scroll .editor-actionbar');
    barEl.style.top = `${ab ? Math.round(ab.offsetHeight) : 0}px`;
  };
  window.addEventListener('resize', () => { if (fullActive) stickFullToolbar(); });

  const showFullView = () => {
    if (fullActive) return true;
    if (!fullEl) buildFullView();
    if (!fullEl.parentNode) wrap.insertAdjacentElement('afterend', fullEl);   // 与题目列并列，render() 不会清掉它
    fullRich.setHtml(buildFullHtml());
    fullDirty = false;                         // 装载本身不算改动（setHtml 会触发一次 onChange）
    fullActive = true;
    wrap.classList.add('hidden');
    fullEl.classList.remove('hidden');
    setSidebarMode('menu');                    // 全卷视图里点大纲没有落点，先切回菜单，免得误跳
    stickFullToolbar();                        // 滚动时工具条（字号 / 加粗…）跟着吸在顶部
    toast('已切到全卷视图：可以全选后统一改字号 / 加粗');
    return true;
  };

  render();
  return { wrap, render, select, showFullView, exitFullView, applyFullView, inFullView: () => fullActive, fullDirty: () => fullActive && fullDirty };
}

function moveItem(list, dragId, targetId, after) {
  const from = list.findIndex((x) => x.id === dragId);
  const to = list.findIndex((x) => x.id === targetId);
  if (from < 0 || to < 0 || from === to) return;
  const [item] = list.splice(from, 1);
  let at = list.findIndex((x) => x.id === targetId);
  if (after) at += 1;
  list.splice(at, 0, item);
}

// 插入位置：跳过开头的欢迎语 / 知情同意与结尾的结束语 / 结束说明
function insertItem(list, ...items) {
  let at = list.length;
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const t = list[i].type;
    if (t === 'debrief' || (t === 'message' && /结束语/.test(list[i].title || ''))) at = i;
    else break;
  }
  let min = 0;
  if (list[0] && list[0].type === 'message') min = 1;
  if (list[min] && list[min].type === 'gate') min += 1;
  list.splice(Math.max(at, min), 0, ...items);
}

function buildItemFields(item, rerender) {
  const frag = document.createDocumentFragment();
  const onInput = () => markPreviewStale();
  let syncClearNote = null;      // 「呈现前清空」的说明行：正文变化时也要重算（空正文 = 清屏不会生效）

  const syncCardTitle = () => {
    const card = document.querySelector(`.qcard[data-id="${item.id}"] .qtitle`);
    if (card) card.textContent = item.title || '（未命名）';
  };

  // 大纲标题：只用于管理端列表 / 大纲（被试看不到这一项）；留空 = 自动取正文首行
  const ttlField = makeField('大纲标题（仅管理端列表 / 大纲显示；留空 = 自动取正文首行）', item.title, 2);
  const titleInput = ttlField.input;
  titleInput.addEventListener('input', () => {
    item.title = titleInput.value;
    syncCardTitle();
    updateOutlineTitle(item.id);      // 左侧大纲那一行的标题跟着改（以前要等重画才更新）
    onInput();
  });
  frag.appendChild(ttlField.wrap);

  // 正文（被试可见）：类 Word 编辑。第一行想当标题，就选中它、在工具条点「标题 1」。
  const BODY_LABEL = {
    message: '消息正文（被试可见；留空则该题自动跳过）',
    gate: '正文（含标题；被试勾选同意后才能开始）',
    confirm: '正文（含标题；被试读完点按钮继续）',
    debrief: '正文（含标题；实验结束后的说明）',
    group: '题组正文（含标题与题组说明）'
  };
  // 正文区不再有任何说明文字（历史上的「被试端逐字流式呈现…」这类提示全部去掉）
  const rich = makeRichField(BODY_LABEL[item.type] || '题干 / 正文（被试可见）', item.html, {
    hint: '',
    onChange: (html) => {
      item.html = html;
      item.text = RichText.htmlToText(html);      // 让「正文为空」的判定跟着更新
      if (syncClearNote) syncClearNote();
      if (!String(item.title || '').trim()) {
        item.title = RichText.firstLine(html, 40);
        titleInput.value = item.title;
        syncCardTitle();
        updateOutlineTitle(item.id);
      }
      onInput();
    }
  });
  frag.appendChild(rich.wrap);

  if (item.type === 'message') {
    // 思考过程是消息题的一个参数（正文区下方「参数」里），不在这里编辑
  } else if (item.type === 'confirm') {
    const b = makeField('按钮文案', item.button || '', 1);
    b.input.addEventListener('input', () => { item.button = b.input.value; onInput(); });
    frag.appendChild(b.wrap);
  } else if (item.type === 'gate') {
    // 形态（仅勾选 / 需填编号）在「插入题目」时已经选定，这里不再重复给一个下拉：
    // 需要换形态就删掉这一题、用另一种形态重新插入。
    // 「需填编号」形态的说明也不再显示（插入时已选过形态，字段名/提示语本身够清楚）
    for (const [label, key, rows] of [['勾选文案（正文下方的同意项）', 'check', 2], ['按钮文案', 'button', 1]]) {
      const f = makeField(label, item[key] || '', rows);
      f.input.addEventListener('input', () => { item[key] = f.input.value; onInput(); });
      frag.appendChild(f.wrap);
    }
    if (item.variant === 'id') {
      for (const [label, key] of [['编号字段名（页面上显示）', 'idLabel'], ['编号输入框提示语', 'idPlaceholder']]) {
        const f = makeField(label, item[key] || '', 1);
        f.input.addEventListener('input', () => { item[key] = f.input.value; onInput(); });
        frag.appendChild(f.wrap);
      }
    }
  } else if (item.type === 'rating') {
    const row = el('div', 'grid2');
    const min = makeNumberField('最低分', item.min, 0, 10);
    min.input.addEventListener('input', () => { item.min = Number(min.input.value) || 0; onInput(); });
    const max = makeNumberField('最高分', item.max, 1, 12);
    max.input.addEventListener('input', () => { item.max = Number(max.input.value) || 1; onInput(); });
    row.append(min.wrap, max.wrap);
    const anchor = makeField('锚点文字', item.anchor || '', 2);
    anchor.input.addEventListener('input', () => { item.anchor = anchor.input.value; onInput(); });
    frag.append(row, anchor.wrap);
  } else if (item.type === 'single' || item.type === 'multi') {
    const f = makeField('选项（一行一个）', (item.options || []).join('\n'), 5);
    f.input.addEventListener('input', () => {
      item.options = f.input.value.split('\n').map((s) => s.trim()).filter(Boolean);
      onInput();
    });
    frag.appendChild(f.wrap);
    if (item.type === 'single') {
      const c = makeNumberField('正确答案序号（1 = A；0 = 不计对错）', item.correct || 0, 0, 8);
      c.input.addEventListener('input', () => { item.correct = Number(c.input.value) || 0; onInput(); });
      frag.appendChild(c.wrap);
    }
  } else if (item.type === 'rank') {
    const f = makeField('排序项（一行一个）', (item.options || []).join('\n'), 5);
    f.input.addEventListener('input', () => {
      item.options = f.input.value.split('\n').map((s) => s.trim()).filter(Boolean);
      onInput();
    });
    frag.appendChild(f.wrap);
  } else if (item.type === 'text') {
    if (item.variant === 'match') {
      // 二级形态「需输入指定内容」：被试在底部输入框里输入，点「发送」先由服务端断言——
      // 内容为空或不一致时不发送（不落库、不进聊天流），只在输入框上方给出下面这条提示。
      const ans = makeField('标准答案（一行一个；任一行匹配即通过）', item.answer || '', 2);
      ans.input.addEventListener('input', () => { item.answer = ans.input.value; onInput(); });
      const err = makeField('匹配失败时的提示（被试可见；留空 = 答案错误）', item.errorText || '', 1);
      err.input.addEventListener('input', () => { item.errorText = err.input.value; onInput(); });
      const ph = makeField('输入框提示语', item.placeholder || '', 1);
      ph.input.addEventListener('input', () => { item.placeholder = ph.input.value; onInput(); });
      frag.append(ans.wrap, err.wrap, ph.wrap);
    } else {
      const row = el('div', 'grid2');
      const rows = makeNumberField('输入框高度（行数；1 = 单行）', item.rows || 1, 1, 12);
      rows.input.addEventListener('input', () => { item.rows = Math.max(1, Math.min(12, Number(rows.input.value) || 1)); onInput(); });
      const maxLen = makeNumberField('字数上限（0 = 不限）', item.maxLen || 0, 0, 5000);
      maxLen.input.addEventListener('input', () => { item.maxLen = Number(maxLen.input.value) || 0; onInput(); });
      row.append(rows.wrap, maxLen.wrap);
      const ph = makeField('输入框提示语', item.placeholder || '', 2);
      ph.input.addEventListener('input', () => { item.placeholder = ph.input.value; onInput(); });
      const req = el('label', 'inline-check');
      const cb = el('input');
      cb.type = 'checkbox';
      cb.checked = item.required !== false;
      cb.addEventListener('change', () => { item.required = cb.checked; onInput(); });
      req.append(cb, el('span', '', '必答'));
      frag.append(row, ph.wrap, req);
    }
  }

  if (item.type === 'group') {
    const layout = el('label', 'field');
    layout.appendChild(el('span', '', '子题排布'));
    const lsel = el('select');
    for (const [v, label] of [['column', '竖排（逐行）'], ['row', '横排（并排）']]) {
      const o = el('option', '', label);
      o.value = v;
      lsel.appendChild(o);
    }
    lsel.value = item.layout === 'row' ? 'row' : 'column';
    lsel.addEventListener('change', () => { item.layout = lsel.value; onInput(); });
    layout.appendChild(lsel);
    frag.appendChild(layout);

    const subsWrap = el('div', 'subs-editor');
    const rebuild = () => {
      subsWrap.innerHTML = '';
      (item.subs || []).forEach((sub, si) => {
        const box = el('div', 'sub-editor');
        const head = el('div', 'sub-editor-head');
        head.appendChild(el('span', 'qnum', `子题 ${si + 1}`));
        head.appendChild(el('span', 'qtype', `${TYPE_ICON(sub.type)} ${TYPE_LABEL(sub.type)}`));
        const tools = el('div', 'qtools');
        const mk = (label2, title2, fn, disabled) => {
          const b = el('button', 'mini-btn', label2);
          b.type = 'button';
          b.title = title2;
          b.disabled = !!disabled;
          b.onclick = fn;
          return b;
        };
        tools.append(
          mk('↑', '上移', () => { if (si > 0) { [item.subs[si - 1], item.subs[si]] = [item.subs[si], item.subs[si - 1]]; onInput(); rebuild(); } }, si === 0),
          mk('↓', '下移', () => { if (si < item.subs.length - 1) { [item.subs[si + 1], item.subs[si]] = [item.subs[si], item.subs[si + 1]]; onInput(); rebuild(); } }, si === item.subs.length - 1),
          mk('删除', '删除子题', () => { item.subs.splice(si, 1); onInput(); rebuild(); }, item.subs.length <= 1)
        );
        head.appendChild(tools);
        box.appendChild(head);

        const ttl = makeField('子题题干', sub.title || '', 2);
        ttl.input.addEventListener('input', () => { sub.title = ttl.input.value; onInput(); });
        box.appendChild(ttl.wrap);
        box.appendChild(buildSubFields(sub, onInput));
        subsWrap.appendChild(box);
      });
      const addRow = el('div', 'add-row');
      addRow.appendChild(el('span', 'lbl', '添加子题：'));
      const sel = el('select', 'add-select');
      for (const t2 of ['text', 'rating', 'single', 'multi', 'rank']) {
        const o = el('option', '', `${TYPE_ICON(t2)} ${TYPE_LABEL(t2)}`);
        o.value = t2;
        sel.appendChild(o);
      }
      const add = el('button', 'mini-btn', '+ 添加');
      add.onclick = () => {
        const base = JSON.parse(JSON.stringify(state.meta.itemDefaults[sel.value] || { type: sel.value }));
        const sub = { ...base, id: `s${Date.now().toString(36)}`, title: base.title || TYPE_LABEL(sel.value), limits: {} };
        delete sub.limits;
        item.subs = item.subs || [];
        item.subs.push(sub);
        onInput();
        rebuild();
      };
      addRow.append(sel, add);
      subsWrap.appendChild(addRow);
    };
    rebuild();
    frag.appendChild(subsWrap);
  }

  // 「呈现前清空」那行的说明要跟着正文变（正文空了 → 清屏不生效），所以把登记函数交下去
  const params = buildParamSection(item, onInput, rerender, (fn) => { syncClearNote = fn; });
  if (params) frag.appendChild(params);
  return frag;
}

// 计时限制：勾选即启用并填数值；未勾选用问卷默认值
// 子题字段：按题型给出必需配置（与顶层题目一致，但不含计时限制与嵌套）
function buildSubFields(sub, onInput) {
  const frag = document.createDocumentFragment();
  if (sub.type === 'text') {
    const row = el('div', 'grid2');
    const rows = makeNumberField('输入框高度（行数）', sub.rows || 1, 1, 12);
    rows.input.addEventListener('input', () => { sub.rows = Math.max(1, Math.min(12, Number(rows.input.value) || 1)); onInput(); });
    const maxLen = makeNumberField('字数上限（0 = 不限）', sub.maxLen || 0, 0, 5000);
    maxLen.input.addEventListener('input', () => { sub.maxLen = Number(maxLen.input.value) || 0; onInput(); });
    row.append(rows.wrap, maxLen.wrap);
    const ph = makeField('输入框提示语', sub.placeholder || '', 2);
    ph.input.addEventListener('input', () => { sub.placeholder = ph.input.value; onInput(); });
    const req = el('label', 'inline-check');
    const cb = el('input');
    cb.type = 'checkbox';
    cb.checked = sub.required !== false;
    cb.addEventListener('change', () => { sub.required = cb.checked; onInput(); });
    req.append(cb, el('span', '', '必答'));
    frag.append(row, ph.wrap, req);
  } else if (sub.type === 'rating') {
    const row = el('div', 'grid2');
    const min = makeNumberField('最低分', sub.min, 0, 10);
    min.input.addEventListener('input', () => { sub.min = Number(min.input.value) || 0; onInput(); });
    const max = makeNumberField('最高分', sub.max, 1, 12);
    max.input.addEventListener('input', () => { sub.max = Number(max.input.value) || 1; onInput(); });
    row.append(min.wrap, max.wrap);
    const anchor = makeField('锚点文字', sub.anchor || '', 2);
    anchor.input.addEventListener('input', () => { sub.anchor = anchor.input.value; onInput(); });
    frag.append(row, anchor.wrap);
  } else if (sub.type === 'single' || sub.type === 'multi' || sub.type === 'rank') {
    const opts = makeField('选项 / 项目（一行一个）', (sub.options || []).join('\n'), 4);
    opts.input.addEventListener('input', () => { sub.options = opts.input.value.split('\n').map((x) => x.trim()).filter(Boolean); onInput(); });
    frag.appendChild(opts.wrap);
    if (sub.type === 'single') {
      const c = makeNumberField('正确答案序号（1 = A；0 = 不计对错）', sub.correct || 0, 0, 8);
      c.input.addEventListener('input', () => { sub.correct = Number(c.input.value) || 0; onInput(); });
      frag.appendChild(c.wrap);
    }
  }
  return frag;
}

/* ---------------------------------------------------------------- 题目参数区
   与题目同框、横线分隔、下方标注「参数」。没有添加任何参数时该区域不出现，
   只留一个「＋ 添加参数」入口；添加后按行列出（名称 + 值 + 删除），支持增删改。
   思考过程是消息题的一个特殊参数（内容项、被试可见），也在这里添加。 */

// 参数预设：常用组合，选了直接填入数值、仍可微调。只是「一组命名好的数值」，不引入新存储。
const PARAM_PRESETS = [
  // 思考时长不在这里：它挂在「思考过程」行里（就一个入口，别出现两个「AI 思考时长」）
  { key: 'typeMs', label: '流式输出 · 标准', value: 11 },
  { key: 'typeMs', label: '流式输出 · 慢', value: 30 },
  { key: 'typeMs', label: '流式输出 · 整段直出', value: 0 },
  { key: 'wait', label: '强制阅读 40 秒', value: 40 },
  { key: 'wait', label: '强制阅读 10 秒', value: 10 },
  { key: 'minSubmit', label: '创作窗口 · 最短 180 秒', value: 180 },
  { key: 'maxAnswer', label: '创作窗口 · 最长 300 秒', value: 300 }
];

// 参数行：名称 + 数值 + 单位 + 删除（开关型参数用勾选框，没有数值）
// onSyncClearNote：把「呈现前清空」那行的说明同步函数交回题目编辑器——
// 正文一改（空 ↔ 非空）就要重算那句话，所以它得由 buildItemFields 持有。
function buildParamRow(item, key, onInput, rerender, onSyncClearNote) {
  const meta = LIMIT_META()[key];
  const spec = (state.meta.limitSpec || {})[key] || { min: 0, max: 86400 };
  const row = el('div', 'param-row');
  row.appendChild(el('span', 'param-name', meta.label));
  // 说明行挂在「参数行外面」（param-cell）：勾选框那一行的布局不受说明出现 / 消失的影响，
  // 勾上前后勾选框的位置一模一样。
  const cell = el('div', 'param-cell');
  let note = null;
  if (meta.unit === '开关') {
    // 开关用真正的勾选框：之前固定显示「已启用」但存的是默认值 0，导致清屏点永远不生效（issue 7）
    const cb = el('input', 'param-check');
    cb.type = 'checkbox';
    cb.checked = Number(item.limits[key]) === 1;
    cb.title = meta.hint;
    // 只有「正文为空 → 这条消息被试端会跳过、清屏不会生效」这种会踩坑的情况才提示一句；
    // 正常开启不写任何说明（以前那句「已开启：……记得刷新预览」太啰嗦，已去掉）
    if (key === 'refresh') {
      note = el('p', 'param-note param-clear-note hidden', '');
      const syncNote = () => {
        const on = Number(item.limits.refresh) === 1;
        const blankMsg = on && item.type === 'message' && !String(item.text || '').trim();
        note.classList.toggle('hidden', !blankMsg);
        note.classList.toggle('warn', blankMsg);
        note.textContent = blankMsg
          ? '⚠ 这条消息的正文是空的 —— 被试端会跳过它，清屏不会生效。请先写正文，或把「呈现前清空」配到题目上。'
          : '';
      };
      cb.addEventListener('change', () => { item.limits[key] = cb.checked ? 1 : 0; syncNote(); onInput(); });
      row.appendChild(cb);
      row.appendChild(el('span', 'param-unit', meta.switchText || meta.label));
      if (onSyncClearNote) onSyncClearNote(syncNote);
      syncNote();
    } else {
      cb.addEventListener('change', () => { item.limits[key] = cb.checked ? 1 : 0; onInput(); });
      row.appendChild(cb);
      row.appendChild(el('span', 'param-unit', meta.switchText || meta.label));
    }
  } else {
    const num = el('input', 'param-num');
    num.type = 'number';
    num.min = String(spec.min);
    num.max = String(spec.max);
    num.value = String(item.limits[key]);
    num.title = meta.hint;
    num.addEventListener('input', () => {
      const raw = Number(num.value) || 0;
      item.limits[key] = Math.min(spec.max, Math.max(spec.min, raw));
      onInput();
    });
    row.appendChild(num);
    row.appendChild(el('span', 'param-unit', meta.unit));
  }
  const del = el('button', 'mini-btn', '删除');
  del.type = 'button';
  del.onclick = () => { delete item.limits[key]; rerender(); };
  row.appendChild(del);
  cell.appendChild(row);
  if (note) cell.appendChild(note);        // 说明行独立一行（不在参数行的 flex 里）
  return cell;
}

// 思考过程行：内容项（被试可见），不是数值；行内含「思考时长」（毫秒）——
// 就是 thinkMs 参数本身，所以不再需要单独添加「AI 思考时长」。
function buildThinkingRow(item, onInput, rerender) {
  const row = el('div', 'param-row param-row-think');
  const head = el('div', 'param-head');
  head.appendChild(el('span', 'param-name', '思考过程（被试可见）'));
  const del = el('button', 'mini-btn', '删除');
  del.type = 'button';
  del.onclick = () => {
    delete item.thinking;
    delete item.__thinkingOn;
    if (item.limits) delete item.limits.thinkMs;   // 删掉这个参数 = 被试端不再有思考提示
    rerender();
  };
  head.appendChild(del);
  row.appendChild(head);
  const ta = el('textarea', 'param-think');
  ta.rows = 6;
  ta.placeholder = '以「AI 的内心推演」口吻写：先复述任务要求，再对照评价标准逐条推演，最后收敛到下方正文的结论。\n留空则不显示思考面板（若配了时长，只显示一段「正在思考」提示）。';
  ta.value = item.thinking || '';
  autoGrowTextarea(ta, 6);
  ta.addEventListener('input', () => { item.thinking = ta.value; onInput(); });
  row.appendChild(ta);

  const spec = (state.meta.limitSpec || {}).thinkMs || { min: 0, max: 60000 };
  const msToSec = (ms) => Math.round((Number(ms) || 0) / 100) / 10;      // 毫秒 → 秒，保留一位小数
  const secToMs = (sec) => Math.min(spec.max, Math.max(spec.min, Math.round((Number(sec) || 0) * 10) * 100));
  const durRow = el('div', 'param-think-dur');
  durRow.appendChild(el('span', 'param-unit', '思考时长'));
  const dur = el('input', 'param-num');
  dur.type = 'number';
  dur.min = '0';
  dur.max = String(spec.max / 1000);
  dur.step = '0.1';
  dur.title = '思考面板 / 「正在思考」提示的时长（秒，最多一位小数，例如 15 / 30）。0 = 不显示';
  dur.value = String(msToSec(item.limits && item.limits.thinkMs != null ? item.limits.thinkMs : effLimit(item, 'thinkMs')));
  const writeDur = (sec) => {
    const v = secToMs(sec);
    if (!item.limits) item.limits = {};
    item.limits.thinkMs = v;
    dur.value = String(msToSec(v));
    onInput();
  };
  dur.addEventListener('input', () => { if (dur.value !== '') writeDur(dur.value); });
  // 失焦回显「当前生效值」：没配过 thinkMs 时回落默认（与输入框初始化同一口径，别显示成 0）
  dur.addEventListener('blur', () => {
    dur.value = String(msToSec(item.limits && item.limits.thinkMs != null ? item.limits.thinkMs : effLimit(item, 'thinkMs')));
  });
  durRow.appendChild(dur);
  durRow.appendChild(el('span', 'param-unit', '秒'));
  for (const [label, v] of [['5 秒', 5000], ['10 秒', 10000], ['20 秒', 20000], ['30 秒', 30000]]) {
    const b = el('button', 'mini-btn', label);
    b.type = 'button';
    b.onclick = () => writeDur(v / 1000);
    durRow.appendChild(b);
  }
  row.appendChild(durRow);
  row.appendChild(el('p', 'param-note', '被试端在正文之前以可折叠面板逐字呈现，输出完自动折叠、点击可回看；没写思考稿时只显示短暂的「正在思考」提示（0 = 完全跳过）。'));
  return row;
}

// 「＋ 添加参数」：一级列可用参数，下面列常用预设
function buildAddParam(item, onInput, rerender) {
  const keys = TYPE_LIMITS(item.type);
  const canThink = item.type === 'message';
  const thinkingOn = canThink && (item.thinking != null || item.__thinkingOn);
  const wrap = el('div', 'param-add');
  const btn = el('button', 'mini-btn', '＋ 添加参数');
  btn.type = 'button';
  const panel = el('div', 'param-panel hidden');

  const close = () => panel.classList.add('hidden');
  const pick = (key, value) => {
    if (key === 'thinking') item.__thinkingOn = true;      // 允许「先添加、再写内容」，标记不落库
    else item.limits[key] = value;
    close();
    rerender();
  };

  for (const k of keys) {
    if (item.limits[k] != null) continue;                       // 已添加的不再列出
    if (k === 'thinkMs' && thinkingOn) continue;                // 时长已在「思考过程」行里
    const meta = LIMIT_META()[k];
    // 开关型参数添加即启用：refresh 默认值 0（不启用就永远不生效），redo 的默认值本身就是 1
    const def = k === 'refresh' ? 1 : (Number(LIMIT_DEFAULTS()[k]) || 0);
    const b = el('button', 'param-opt', `${meta.label}（${meta.unit}）`);
    b.type = 'button';
    b.title = meta.hint;
    b.onclick = (e) => { e.stopPropagation(); pick(k, def); };
    panel.appendChild(b);
  }
  if (canThink && item.thinking == null && !item.__thinkingOn) {
    const b = el('button', 'param-opt', '思考过程（被试可见）');
    b.type = 'button';
    b.title = '在反馈正文之前先输出一段「AI 的思考过程」，输出完自动折叠；行内含思考时长';
    b.onclick = (e) => { e.stopPropagation(); pick('thinking'); };
    panel.appendChild(b);
  }
  const usable = PARAM_PRESETS.filter((p) => keys.includes(p.key) && item.limits[p.key] == null && !(thinkingOn && p.key === 'thinkMs'));
  if (usable.length) {
    panel.appendChild(el('p', 'param-group', '常用预设'));
    for (const p of usable) {
      const b = el('button', 'param-opt param-opt-preset', p.label);
      b.type = 'button';
      b.onclick = (e) => { e.stopPropagation(); pick(p.key, p.value); };
      panel.appendChild(b);
    }
  }
  if (!panel.childElementCount) {
    panel.appendChild(el('p', 'param-group', '该题型没有可添加的参数'));
  }

  btn.onclick = (e) => {
    e.stopPropagation();
    panel.classList.toggle('hidden');
    if (!panel.classList.contains('hidden')) openParamPanel = wrap;
  };
  wrap.close = close;
  wrap.append(btn, panel);
  return wrap;
}

// 参数区整体：无参数时只返回「＋ 添加参数」；有参数时补横线 + 区域名 + 各行
function buildParamSection(item, onInput, rerender, onSyncClearNote) {
  const keys = TYPE_LIMITS(item.type);
  const canThink = item.type === 'message';
  if (!keys.length && !canThink) return null;

  const wrap = el('div', 'params');
  const hasThinking = canThink && (item.thinking != null || item.__thinkingOn);
  // thinkMs 只在「思考过程」行里改 —— 开了那一行就不要再单独渲染「AI 思考时长」（否则同一参数出现两次）
  const activeKeys = keys.filter((k) => item.limits[k] != null && !(k === 'thinkMs' && hasThinking));
  if (activeKeys.length || hasThinking) {
    const band = el('div', 'param-band');
    band.append(el('span', 'label', '参数'), el('span', 'line'));
    wrap.appendChild(band);
    for (const k of activeKeys) wrap.appendChild(buildParamRow(item, k, onInput, rerender, onSyncClearNote));
    if (hasThinking) wrap.appendChild(buildThinkingRow(item, onInput, rerender));
  }
  wrap.appendChild(buildAddParam(item, onInput, rerender));
  return wrap;
}

// 点击别处收起「添加参数」面板（全局只装一次监听）
let openParamPanel = null;
document.addEventListener('click', (e) => {
  if (openParamPanel && !openParamPanel.contains(e.target)) {
    openParamPanel.close();
    openParamPanel = null;
  }
});


export {
  openInsertPicker,
  buildInsertPicker,
  buildLevelControl,
  buildItemEditor,
  moveItem,
  insertItem,
  buildItemFields,
  buildSubFields,
  PARAM_PRESETS,
  buildParamRow,
  buildThinkingRow,
  buildAddParam,
  buildParamSection
};
