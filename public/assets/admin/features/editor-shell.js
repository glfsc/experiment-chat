'use strict';

import { $, $main, state, currentEditing, isMobile } from '../core/state.js';
import { el, toast, openModal, closeModal } from '../core/ui.js';
import { api } from '../core/api.js';
import { fitPhoneScale, saveLayout, startDrag, setTopbar, setTopbarBack } from '../core/layout.js';
import { editorContext } from './editor-context.js';
import { syncOutlineActive } from './outline.js';

import { stripLocal } from './item-model.js';

let previewCtl = null;          // 手机预览：{ url, markStale }（由 editorShell 装配）

// 编辑内容变化时：提示「预览需要刷新」，而不是实时重渲染
// （预览是真页面、真会话，重渲染会把正在试填的进度打断）
function markPreviewStale() {
  if (previewCtl && previewCtl.markStale) previewCtl.markStale();
}

// 手机预览缩放：真机 393 × 852 等比缩放到手机栏的可用空间
// （内部仍是真机视口 → 预览与真机是 1:1 的布局，只是整体缩小以便一屏看全）
// 关键：宽屏下可用高度按「主区域底边」算（不是窗口高）——否则手机壳会把主区域撑出可滚动高度，
// 一旦发生滚动，手机栏就被顶出视口，只剩最下面一条（用户报的「手机界面无法模拟」）。

// 编辑页骨架：头部（返回）+ 中间编辑区（顶部操作条：标题 + 保存）+ 右侧手机预览（真 iframe）
function editorShell({ title, backHash, saveLabel, hint, body, phoneTitle, withTrial, onSave, isDirty, barButtons }) {
  $main.className = 'admin-main editing';
  $main.innerHTML = '';
  setTopbar(title);              // 手机端顶栏显示当前问卷 / 模板名；返回键走顶栏 ←
  setTopbarBack(true);

  const head = el('div', 'editor-head');
  const back = el('button', 'ghost-btn', '← 返回列表');
  // 未修改直接返回；有修改才弹确认（保存 / 不保存返回）
  back.onclick = () => {
    if (isDirty && !isDirty()) {
      location.hash = backHash;
      return;
    }
    openModal({
      title: '返回列表',
      body: el('p', 'modal-note', '当前内容尚未保存，是否保存后返回？'),
      confirmLabel: '保存',
      extraLabel: '不保存返回',
      hideCancel: true,
      onExtra: async () => {
        closeModal();
        location.hash = backHash;
      },
      onConfirm: async () => {
        if (onSave) await onSave({ exit: true, modal: true });
      }
    });
  };
  head.append(back);                 // 标题与保存按钮移进中间列顶部（见下），头部只留返回
  $main.appendChild(head);

  const cols = el('div', 'editor-cols');
  const scroll = el('div', 'editor-scroll');
  // 中间板块顶部的操作条：左边问卷标题、右边「保存问卷」。
  // 不再钉在整页右上角——相对位置 = 手机预览的左上角 / 问卷标题的右边（issue 8）。
  const actionBar = el('div', 'editor-actionbar');
  actionBar.appendChild(el('span', 'editor-actionbar-title', title));
  const barRight = el('div', 'editor-actionbar-right');
  if (hint) barRight.appendChild(el('span', 'hint', hint));
  for (const extra of (barButtons || [])) barRight.appendChild(extra);   // 自定义按钮一律排在「保存」左边
  const save = el('button', 'primary-btn', saveLabel);
  save.type = 'button';
  save.onclick = () => onSave && onSave({ exit: false });
  barRight.appendChild(save);
  actionBar.appendChild(barRight);
  scroll.appendChild(actionBar);
  const bodyWrap = el('div');
  bodyWrap.appendChild(body);
  scroll.appendChild(bodyWrap);
  cols.appendChild(scroll);

  const col = el('div', 'phone-col');
  const bar = el('div', 'phone-bar');
  bar.appendChild(el('span', 'pv-tag', '预览'));
  const refreshBtn = el('button', 'mini-btn', '⟳ 刷新预览');
  refreshBtn.type = 'button';
  refreshBtn.title = '同步编辑内容并从头试填（预览不落库）';
  bar.appendChild(refreshBtn);
  // 重做：不等整页刷新，直接把这次模拟从头再走一遍（作废当前预览会话，回到知情同意页）
  const redoPvBtn = el('button', 'mini-btn', '↺ 重做');
  redoPvBtn.type = 'button';
  redoPvBtn.title = '把这次模拟从头再走一遍（作废当前预览会话，回到知情同意页；题目内容不变）';
  redoPvBtn.addEventListener('click', async () => {
    warnIfStale();
    const b = previewCtl.bridge();
    if (!b) { toast('预览还没就绪，稍等一下再重做'); return; }
    try {
      if (b.restart) await b.restart();
      else { const u = previewCtl.url || frame.src; if (u) frame.src = u; }   // 老版本桥：退化成重载
      previewCtl.syncScrub();
    } catch (err) {
      toast(err.message || '重做失败，请重试');
    }
  });
  bar.appendChild(redoPvBtn);
  if (withTrial) {
    // 倍速：弹字 / 思考面板 / 门控计时**一起**按倍速加速，切换时只改速度、不重建会话
    const speedSel = el('select', 'pv-speed');
    for (const [v, label] of [['1', '1× 真实节奏'], ['5', '5× 加速'], ['10', '10× 加速'], ['20', '20× 快速']]) {
      const o = el('option', '', label);
      o.value = v;
      speedSel.appendChild(o);
    }
    speedSel.value = String(state.previewSpeed || 1);
    speedSel.addEventListener('change', () => {
      state.previewSpeed = Number(speedSel.value) || 1;
      applyPreviewSpeed(state.previewSpeed);        // 不重建会话：已填的作答、未提交的选择都保留
    });
    bar.appendChild(speedSel);
    var previewSpeedSel = speedSel;
    var speedSelEl = speedSel;                     // 手机端全屏预览层复用（提层时一起搬走）
  }
  col.appendChild(bar);
  col.appendChild(el('p', 'phone-note', withTrial
    ? '这里是真实的被试端页面（iframe）：所见、所点就是正式实验的样子。改完题目点「⟳ 刷新预览」同步；下面的进度条 / 题号框可直接跳到某道题开始试填。'
    : '这里是真实的被试端页面（iframe）：所见、所点就是正式实验的样子。'));
  // 进度条：拖动直接跳到第 N 题（题号与卡面一致；知情同意 / 确认页这类不占题号）
  const scrubWrap = el('div', 'pv-scrub hidden');
  const scrub = el('input', 'pv-scrub-range');
  scrub.type = 'range';
  scrub.min = '1';
  scrub.max = '1';
  scrub.value = '1';
  const scrubLabel = el('span', 'pv-scrub-label', '第 1 / 1 题');
  // 题号输入框：手输题号回车直接跳（等同拖进度条，方便跳到很靠后的题目）
  const jumpInput = el('input', 'pv-scrub-jump');
  jumpInput.type = 'number';
  jumpInput.min = '1';
  jumpInput.step = '1';
  jumpInput.placeholder = '题号';
  jumpInput.title = '输入题号后回车，直接跳到该题（等同拖动进度条）';
  const doJumpByNumber = async () => {
    warnIfStale();
    const b = previewCtl.bridge();
    if (!b) { toast('预览还没就绪，稍等一下再跳'); return; }
    const total = Math.max(1, (b.totalQuestions ? b.totalQuestions() : b.total()) || 1);
    const n = Math.round(Number(jumpInput.value));
    if (!Number.isFinite(n) || n < 1 || n > total) {
      toast(`请输入 1–${total} 之间的题号`);
      jumpInput.value = '';
      return;
    }
    try {
      await seekToQuestion(b, n);      // 按题号跳：前 n-1 题合成已作答，直接停在第 n 题
      jumpInput.value = '';
      previewCtl.syncScrub();
    } catch (err) {
      toast(err.message || '跳转失败，请重试');
    }
  };
  jumpInput.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') { e.preventDefault(); doJumpByNumber(); }
    if (e.key === 'Escape') jumpInput.value = '';
  });
  jumpInput.addEventListener('blur', () => { if (String(jumpInput.value).trim() !== '') doJumpByNumber(); });
  scrubWrap.append(scrub, scrubLabel, jumpInput);
  if (withTrial) col.appendChild(scrubWrap);
  // 手机壳：按真机尺寸（393 × 852）渲染，再用 transform 等比缩放塞进这一栏
  const holder = el('div', 'phone-holder');
  const phone = el('div', 'phone');
  const frame = document.createElement('iframe');
  frame.className = 'phone-frame';
  frame.title = '被试端预览';
  phone.appendChild(frame);
  holder.appendChild(phone);
  col.appendChild(holder);

  // 预览会话：把编辑器里（可能还没保存）的题目发给服务端建一个内存会话，iframe 就是这个会话的页面
  const ctl = {
    url: '',
    markStale: () => {
      if (!previewCtl.url) return;
      refreshBtn.textContent = '⟳ 有改动，点此刷新';
      refreshBtn.classList.add('stale');
    },
    // 预览页里暴露的桥（同源 iframe）：改倍速 / 拖进度都不重建会话
    bridge: () => {
      try { return frame.contentWindow && frame.contentWindow.__preview ? frame.contentWindow.__preview : null; } catch { return null; }
    },
    syncScrub: () => {
      const b = previewCtl.bridge();
      if (!b) return;
      // 进度按「题号」报：分母是真实题数，当前值 = 当前是第几题（与卡面写法一致）
      const total = Math.max(1, (b.totalQuestions ? b.totalQuestions() : b.total()) || 1);
      const cur = Math.min(total, Math.max(1, (b.currentQno ? b.currentQno() : (b.answered() || 0) + 1) || 1));
      scrub.max = String(total);
      if (document.activeElement !== scrub) scrub.value = String(cur);
      scrubLabel.textContent = `第 ${cur} / ${total} 题`;
      const wasHidden = scrubWrap.classList.contains('hidden');
      scrubWrap.classList.remove('hidden');
      if (wasHidden) fitPhoneScale();      // 进度条出现会占掉一行高度 → 重新按可用高度缩放，别让手机被裁掉
    }
  };
  previewCtl = ctl;
  // 预览是「点刷新那一刻」的题目快照：有未同步的改动时提醒一句，
  // 否则用户改了「呈现前清空」这类参数却以为已经生效（真机链接同理，用的是已保存的问卷）
  const warnIfStale = () => {
    if (refreshBtn.classList.contains('stale')) toast('预览还没同步改动：点「⟳ 刷新预览」后，改动（含「呈现前清空」）才会在预览里生效');
  };

  // 按题号跳（老版本桥只有 seek(单元序号)，这里做兼容）
  const seekToQuestion = (b, qno) => (b.seekQuestion ? b.seekQuestion(qno) : b.seek(qno - 1));
  // 倍速：优先走 iframe 里的桥（只改速度、不重建会话）；桥还没就绪就先记下来，等 iframe 加载完补发
  let pendingSpeed = null;
  const applyPreviewSpeed = (speed) => {
    warnIfStale();
    const b = previewCtl.bridge();
    if (b && b.setSpeed) { b.setSpeed(speed).catch(() => toast('倍速设置失败')); return; }
    if (!previewCtl.url) { pendingSpeed = speed; return; }        // 首次加载中：URL 已带 speed，无需重建
    pendingSpeed = speed;                                          // iframe 正在换页：load 后补发，不重建
  };
  let scrubTimer = null;
  scrub.addEventListener('input', () => { scrubLabel.textContent = `第 ${scrub.value} 题（松手后跳转）`; });
  scrub.addEventListener('change', async () => {
    warnIfStale();
    const b = previewCtl.bridge();
    if (!b) return;
    try {
      await seekToQuestion(b, Number(scrub.value));
      previewCtl.syncScrub();
    } catch (err) {
      toast(err.message || '跳转失败');
    }
  });
  frame.addEventListener('load', () => {
    window.setTimeout(() => {
      if (previewCtl !== ctl) return;         // 已离开编辑页：不再触碰预览
      previewCtl.syncScrub();
      // iframe 换页期间改过倍速：现在补发（只改速度，不重建会话）
      if (pendingSpeed != null) {
        const b = previewCtl.bridge();
        const want = pendingSpeed;
        pendingSpeed = null;
        if (b && b.setSpeed) b.setSpeed(want).catch(() => toast('倍速设置失败'));
      }
    }, 400);
    window.clearInterval(scrubTimer);
    scrubTimer = window.setInterval(() => previewCtl.syncScrub(), 1500);
  });
  const reloadPreview = async () => {
    refreshBtn.disabled = true;
    try {
      // 点「刷新预览」= 丢弃这一次模拟：先把旧预览会话销毁（不等 30 分钟空闲回收），再建新的
      const oldUrl = previewCtl.url || '';
      const oldId = (oldUrl.match(/preview=([^&]+)/) || [])[1];
      if (oldId) api('/api/preview/destroy', { body: { previewId: decodeURIComponent(oldId) } }).catch(() => {});
      const editing = currentEditing();
      const items = ((editing && editing.items) || []).map(stripLocal);
      const speed = previewSpeedSel ? Number(previewSpeedSel.value) : 1;
      const res = await api('/api/preview/create', { body: { items, speed: speed > 1 ? speed : 1 } });
      pendingSpeed = null;
      previewCtl.url = `${res.url}&speed=${speed > 1 ? speed : 1}`;   // 倍速随 URL 一起带上：首次加载就生效
      frame.src = previewCtl.url;
      refreshBtn.textContent = '⟳ 刷新预览';
      refreshBtn.classList.remove('stale');
    } catch (err) {
      toast(err.message || '预览失败，请重试');
    } finally {
      refreshBtn.disabled = false;
    }
  };
  refreshBtn.onclick = () => reloadPreview();

  // 手机端全屏预览层：顶部一条 = 关闭 / 刷新 / 进度条 / 倍速；下面整块 = 真被试端 iframe 1:1 铺满
  // （不再缩小成手机壳，也没有多余留白——窗口多大，被试端就多大）。
  // 只在第一次点「预览」时创建并建预览会话；关闭只是隐藏，元素与 iframe 都留着（重复打开不重载）。
  let pvLayerEl = null;
  const openPreviewLayer = () => {
    if (!pvLayerEl) {
      pvLayerEl = el('div', 'pv-layer');
      const top = el('div', 'pv-top');
      const close = el('button', 'pv-close', '✕');
      close.type = 'button';
      close.title = '关闭预览，回到编辑';
      close.onclick = () => pvLayerEl.classList.add('hidden');
      top.append(close, refreshBtn);
      if (withTrial) top.appendChild(scrubWrap);     // 进度条 + 第 x / y 题（题号输入框在层内收起）
      if (speedSelEl) top.appendChild(speedSelEl);
      const pvBody = el('div', 'pv-body');
      pvBody.appendChild(holder);
      pvLayerEl.append(top, pvBody);
      document.body.appendChild(pvLayerEl);
    }
    pvLayerEl.classList.remove('hidden');
    if (!previewCtl.url) reloadPreview();          // 首次打开才建预览会话（手机端进编辑页不预载）
  };

  if (isMobile()) {
    // 手机端：不渲染手机预览列（屏幕放不下），预览收进操作条上的「预览」按钮
    const pvOpenBtn = el('button', 'ghost-btn', '预览');
    pvOpenBtn.type = 'button';
    pvOpenBtn.title = '全屏打开被试端预览（所见即真机，不落库）';
    pvOpenBtn.onclick = () => openPreviewLayer();
    barRight.insertBefore(pvOpenBtn, save);
  } else {
    window.setTimeout(() => { fitPhoneScale(); reloadPreview(); }, 0);
  }
  requestAnimationFrame(fitPhoneScale);
  // 编辑栏与手机栏之间的分隔线：拖动调整手机栏宽度（双击复位）。手机端不渲染预览列，也没有这条线
  const split = el('div', 'splitter');
  split.title = '拖动调整手机预览宽度 · 双击复位';
  split.addEventListener('mousedown', (e) => startDrag(e, 'phone'));
  split.addEventListener('dblclick', () => { saveLayout({ phone: LAYOUT_DEF.phone }); toast('手机栏宽度已复位'); });
  if (!isMobile()) cols.append(split, col);
  $main.appendChild(cols);
  // 编辑区内容渲染完之后同步一次大纲高亮（否则首次进入时大纲不会跟随定位）
  requestAnimationFrame(() => syncOutlineActive());

  // 离开编辑页时释放资源：停止进度轮询 + 销毁这次预览会话（服务端还有 TTL/LRU 兜底）。
  // 以前 scrubTimer 会一直空转，反复进出编辑页会累积一堆指向废 iframe 的定时器。
  const dispose = () => {
    window.clearInterval(scrubTimer);
    scrubTimer = null;
    const m = ((previewCtl && previewCtl.url) || '').match(/preview=([^&]+)/);
    if (m) api('/api/preview/destroy', { body: { previewId: decodeURIComponent(m[1]) } }).catch(() => {});
    if (previewCtl === ctl) previewCtl = null;
    if (pvLayerEl) { pvLayerEl.remove(); pvLayerEl = null; }   // 全屏预览层随编辑页一起销毁
  };
  editorContext.dispose = dispose;

  // setTitle：保存后不退出编辑页时，用来把顶部标题同步成新名字
  const setTitle = (text) => {
    actionBar.querySelector('.editor-actionbar-title').textContent = text;
    setTopbar(text);
  };
  return { saveBtn: save, scroll, reloadPreview, dispose, setTitle };
}


export { markPreviewStale, editorShell };
