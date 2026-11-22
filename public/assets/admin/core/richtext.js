'use strict';

import { el } from './ui.js';

// richtext.js 是 UMD：浏览器侧挂在 globalThis.RichText（Node 侧仍走 module.exports）。
// 这里显式取一次，模块内不再依赖裸全局。
const RichText = globalThis.RichText;
if (!RichText) throw new Error('richtext.js 未加载：请确认 admin.html 先加载 /assets/richtext.js');

/* ---------------------------------------------------------------- 富文本编辑控件（类 Word）
   正文一律用它编辑：正文 / 一至六级标题、字号、加粗 / 斜体 / 下划线 / 删除线、字体颜色、背景色、
   对齐、清除格式；从 Word 或网页粘贴保留格式（mso-* 之类垃圾样式在 richtext.js 里被丢掉）。
   被试端渲染的就是这里清洗后的 HTML——同一份 richtext.js。 */
function makeRichField(labelText, htmlValue, opts = {}) {
  // 注意：这里必须是 div，不能用 <label> —— label 会把点击转发给内部第一个表单控件（工具条的下拉），
  // 导致点正文区域编辑器拿不到焦点、输入不进去。
  const wrap = el('div', 'field rich-field');
  wrap.appendChild(el('span', '', labelText));
  const box = el('div', 'rich-box');
  const bar = el('div', 'rich-bar');

  const editor = el('div', 'rich-edit');
  editor.contentEditable = 'true';
  editor.spellcheck = false;
  // raw 模式（「显示全卷」视图用）：内容里带着「题目标识行」这类只在视图内成立的标记，
  // 不能每次同步都走一遍清洗（清洗会把 class / contenteditable 属性洗掉，标记就认不出来了）；
  // 统一在切回分题时按段清洗。界面上的富文本字段一律用默认（清洗）模式。
  const rawMode = !!opts.raw;
  const clean = (html) => (rawMode ? String(html == null ? '' : html) : RichText.sanitizeHtml(html));
  editor.innerHTML = clean(htmlValue || '');

  let lastHtml = typeof opts.initialHtml === 'string' ? opts.initialHtml : null;
  const sync = () => {
    const html = clean(editor.innerHTML);
    editor.dataset.empty = html ? '0' : '1';
    if (html === lastHtml) return;
    lastHtml = html;
    if (opts.onChange) opts.onChange(html, RichText.htmlToText(html));
  };

  const exec = (cmd, value) => {
    editor.focus();
    try { document.execCommand(cmd, false, value); } catch { /* 忽略 */ }
    sync();
  };
  const mkBtn = (label, title, fn, cls) => {
    const b = el('button', 'rich-btn' + (cls ? ' ' + cls : ''), label);
    b.type = 'button';
    b.title = title;
    // 别让按钮抢走选区，否则「选中文字再加粗」就失效了
    b.addEventListener('mousedown', (e) => e.preventDefault());
    b.addEventListener('click', (e) => { e.preventDefault(); fn(); });
    return b;
  };

  const blockSel = el('select', 'rich-select');
  blockSel.title = '段落样式（把第一行设为标题就用它）';
  for (const [v, t] of [['p', '正文'], ['h1', '标题 1'], ['h2', '标题 2'], ['h3', '标题 3'], ['h4', '标题 4'], ['h5', '标题 5'], ['h6', '标题 6']]) {
    const o = el('option', '', t);
    o.value = v;
    blockSel.appendChild(o);
  }
  blockSel.addEventListener('mousedown', (e) => e.stopPropagation());
  blockSel.addEventListener('change', () => exec('formatBlock', blockSel.value));

  // 精确字号：先给选区套 span（保留行内结构）；跨段落时报废，退化为「对涉及的整段生效」（和 Word 一致）
  const BLOCK_SEL = 'P,H1,H2,H3,H4,H5,H6,LI,BLOCKQUOTE,DIV';
  // 本编辑器里最后一次「有效选区」。点字号下拉时，原生 select 会把 contenteditable 的选区抢走
  // （选区跑到编辑器外或塌成光标），应用之前必须把它放回去 —— 否则要么没反应、要么改到别的地方
  // （issue：选中一片文字改字号改不动 / 离开这题又变回去）。
  let lastRange = null;
  const liveRange = () => {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return null;
    const r = sel.getRangeAt(0);
    const host = r.commonAncestorContainer.nodeType === 1 ? r.commonAncestorContainer : r.commonAncestorContainer.parentNode;
    return host && editor.contains(host) ? r : null;
  };
  const rememberRange = () => { const r = liveRange(); if (r) lastRange = r.cloneRange(); };
  // 应用目标：优先「还在编辑器里的选区」；已被下拉抢走（跑到外面 / 塌成光标）就用记着的那个
  const targetRange = () => {
    const live = liveRange();
    if (live && !live.collapsed) return live.cloneRange();
    if (lastRange && !lastRange.collapsed) return lastRange.cloneRange();
    return live ? live.cloneRange() : (lastRange ? lastRange.cloneRange() : null);
  };
  const applyFontSize = (value) => {
    const range = targetRange();          // 必须在 focus 之前取：focus 有时会把选区改成光标
    editor.focus();
    const sel = window.getSelection();
    if (range && sel) { try { sel.removeAllRanges(); sel.addRange(range); } catch { /* 忽略 */ } }
    if (!range) return;
    if (value === 'body') { clearFontSize(range); sync(); return; }
    clearFontSize(range);                      // 先清掉旧字号，避免一层层套 span
    // 选区涉及的「块」（p / h1-6 / li / blockquote / div）
    const blocks = [];
    const walker = document.createTreeWalker(editor, NodeFilter.SHOW_ELEMENT);
    while (walker.nextNode()) {
      const n = walker.currentNode;
      if (!n.matches(BLOCK_SEL)) continue;
      if (!range.collapsed ? range.intersectsNode(n) : n.contains(range.startContainer)) blocks.push(n);
    }
    if (!blocks.length) {
      // 光标停在行内元素里：往上找最近的块
      let node = range.startContainer;
      while (node && node !== editor && !(node.nodeType === 1 && node.matches(BLOCK_SEL))) node = node.parentNode;
      if (node && node !== editor) blocks.push(node);
    }
    // 只涉及一个块（或只是光标）：用 span 包起来 —— 行内结构（加粗 / 颜色）原地保留
    if (blocks.length <= 1) {
      const span = document.createElement('span');
      span.style.fontSize = value;
      try {
        range.surroundContents(span);
        sync();
        return;
      } catch { /* 选区跨块：往下走，按块处理 */ }
    }
    // 跨多个块（含「全选」）：逐块设字号。
    // 不能用 span 包住整块 —— 「span 里放 p」是非法嵌套，存下来再渲染时浏览器会把 span 拆开、字号就丢了
    if (!blocks.length) return;                      // 找不到就不动（绝不改编辑器本身）
    blocks.forEach((b) => { b.style.fontSize = value; });
    sync();
  };
  // 「正文（默认）」= 去掉字号样式，回到容器默认字号（14px）。
  // 光标折叠时 intersectsNode 可能命中不到，这里补一条「沿祖先链找到所在块」的分支。
  const clearFontSize = (range) => {
    const hit = (n) => {
      try { return range.intersectsNode(n); } catch { return false; }
    };
    const targets = new Set();
    const walker = document.createTreeWalker(editor, NodeFilter.SHOW_ELEMENT);
    while (walker.nextNode()) {
      const n = walker.currentNode;
      if (!n.style || !n.style.fontSize) continue;
      if (hit(n)) targets.add(n);
    }
    if (range.collapsed) {
      let node = range.startContainer;
      if (node && node.nodeType !== 1) node = node.parentNode;
      while (node && node !== editor) {
        if (node.style && node.style.fontSize) targets.add(node);
        node = node.parentNode;
      }
    }
    targets.forEach((n) => {
      n.style.fontSize = '';
      if (!n.getAttribute('style')) n.removeAttribute('style');
    });
  };

  // 字号：只给 Word 那套中文号数（正文那档标出来，并且是默认值）
  const sizeSel = el('select', 'rich-select');
  // 「多种字号」：选区里字号不统一时（如首字小四、其余五号）显示它 —— 这样再点某一档值一定变了、
  // 一定触发 change，字号才真正应用得上（以前显示小四时再点小四：原生 select 不触发 change → 一点反应都没有）
  const MIXED_SIZE = '__mixed__';
  sizeSel.title = '字号（「正文」= 默认字号，不写入任何字号样式）；光标移到文字上会显示它当前是哪一号';
  // 档位表来自 RichText（与「粘贴时识别字号」共用同一张表，避免两处漂移）
  // 「正文（默认 16px）」= 不写入字号（回落编辑器默认）；其余按 Word 号数换算（pt × 4/3）
  {
    const om = el('option', '', '多种字号');
    om.value = MIXED_SIZE;
    om.hidden = true;                      // 只是回显态，不出现在下拉列表里
    sizeSel.appendChild(om);
    const o = el('option', '', `正文（默认 ${RichText.BODY_FONT_PX}px）`);
    o.value = 'body';
    sizeSel.appendChild(o);
    for (const p of RichText.FONT_SIZE_PRESETS) {
      const op = el('option', '', p.label);
      op.value = `${p.px}px`;
      sizeSel.appendChild(op);
    }
  }
  sizeSel.value = 'body';
  sizeSel.addEventListener('mousedown', (e) => e.stopPropagation());
  sizeSel.addEventListener('change', () => {
    const v = sizeSel.value;
    if (v === MIXED_SIZE) return;          // 回显态，不是可选的档位
    applyFontSize(v);
    sizeSel.value = v;                     // 直接回显刚落定的档位（不按光标二次推导，免得又跳回「正文」）
  });
  // 取某个节点的「实际字号」：先沿祖先链找内联 font-size，没有就看容器算出来的
  const sizePxOf = (node) => {
    const el2 = node.nodeType === 1 ? node : node.parentElement;
    let hasInline = false;
    let px = 0;
    for (let n = el2; n && n !== editor; n = n.parentElement) {
      if (n.style && n.style.fontSize) { px = parseFloat(n.style.fontSize) || 0; hasInline = true; break; }
    }
    if (!px && el2) px = parseFloat(getComputedStyle(el2).fontSize) || 0;
    return { px: Math.round(px), hasInline };
  };
  // 光标 / 选区一动，就把「当前字号」回显到下拉里（这样粘贴进来的字号能看出是哪一号）
  // 回显按**整个选区**算：一致 → 该档位；不一致 → 「多种字号」；
  // 没有任何内联字号且就是编辑器默认字号 → 「正文（默认）」
  const syncSizeSelToCaret = () => {
    const range = targetRange();
    if (!range) { sizeSel.value = 'body'; return; }
    const pxList = [];
    let hasInline = false;
    const take = (node) => { const s = sizePxOf(node); if (s.px) pxList.push(s.px); if (s.hasInline) hasInline = true; };
    if (range.collapsed) {
      take(range.startContainer);
    } else {
      const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const n = walker.currentNode;
        if (!n.nodeValue || !n.nodeValue.trim()) continue;
        if (!range.intersectsNode(n)) continue;
        take(n);
      }
      if (!pxList.length) take(range.startContainer);
    }
    const uniq = [...new Set(pxList)];
    if (uniq.length > 1) { sizeSel.value = MIXED_SIZE; return; }
    const px = uniq[0] || 0;
    if (!px || (!hasInline && px === RichText.BODY_FONT_PX)) { sizeSel.value = 'body'; return; }
    const preset = RichText.fontPresetOf(px);
    sizeSel.value = preset && preset.exact ? `${preset.px}px` : 'body';
  };
  // 只在本编辑器里监听光标变化（其它字段不动这个下拉）；选区跑到编辑器外面时保留上一次的（点下拉就不会丢）
  document.addEventListener('selectionchange', () => {
    const live = liveRange();
    if (!live) return;
    lastRange = live.cloneRange();
    syncSizeSelToCaret();
  });
  editor.addEventListener('mouseup', rememberRange);
  editor.addEventListener('keyup', rememberRange);

  bar.append(blockSel, sizeSel);
  bar.append(
    mkBtn('B', '加粗（Ctrl+B）', () => exec('bold'), 'b'),
    mkBtn('I', '斜体（Ctrl+I）', () => exec('italic'), 'i'),
    mkBtn('U', '下划线（Ctrl+U）', () => exec('underline'), 'u'),
    mkBtn('S', '删除线', () => exec('strikeThrough'), 'strike')
  );

  const fg = el('input', 'rich-color');
  fg.type = 'color';
  fg.value = '#111213';
  fg.title = '字体颜色';
  fg.addEventListener('input', () => exec('foreColor', fg.value));
  const bg = el('input', 'rich-color');
  bg.type = 'color';
  bg.value = '#fff3bf';
  bg.title = '字体背景色';
  bg.addEventListener('input', () => {
    editor.focus();
    let ok = false;
    try { ok = document.execCommand('hiliteColor', false, bg.value); } catch { ok = false; }
    if (!ok) { try { document.execCommand('backColor', false, bg.value); } catch { /* 忽略 */ } }
    sync();
  });
  // 颜色按钮：点按钮任意位置 = 应用当前预选色；点内部的小色块 = 打开取色器调整预选色
  const colorBtn = (input, tag, title, apply) => {
    const wrap = el('button', 'rich-color-wrap');
    wrap.type = 'button';
    wrap.title = `${title}：点按钮直接应用当前颜色；点左侧色块可换颜色`;
    wrap.append(input, el('span', 'rich-color-tag', tag));
    wrap.addEventListener('mousedown', (e) => e.preventDefault());     // 别抢走选区
    wrap.addEventListener('click', (e) => {
      if (e.target === input) return;                                  // 点色块 → 只开取色器
      e.preventDefault();
      apply(input.value);
    });
    input.addEventListener('mousedown', (e) => e.stopPropagation());
    return wrap;
  };
  const fgWrap = colorBtn(fg, 'A', '字体颜色', (v) => exec('foreColor', v));
  const bgWrap = colorBtn(bg, '底色', '字体背景色', (v) => {
    editor.focus();
    let ok = false;
    try { ok = document.execCommand('hiliteColor', false, v); } catch { ok = false; }
    if (!ok) { try { document.execCommand('backColor', false, v); } catch { /* 忽略 */ } }
    sync();
  });
  bar.append(fgWrap, bgWrap);

  bar.append(
    mkBtn('左', '左对齐', () => exec('justifyLeft')),
    mkBtn('中', '居中', () => exec('justifyCenter')),
    mkBtn('清除格式', '清除选中文字的格式（回到正文默认）', () => exec('removeFormat'))
  );

  const onPaste = (e) => {
    const dt = e.clipboardData;
    if (!dt) return;
    const html = dt.getData('text/html');
    const text = dt.getData('text/plain');
    e.preventDefault();
    const clean = html ? RichText.cleanWordPaste(html) : RichText.plainPasteToHtml(text);
    if (!clean) return;
    editor.focus();
    try { document.execCommand('insertHTML', false, clean); } catch { /* 忽略 */ }
    sync();
  };
  editor.addEventListener('paste', onPaste);
  editor.addEventListener('input', sync);
  editor.addEventListener('blur', sync);
  editor.addEventListener('focus', () => {
    try {
      document.execCommand('styleWithCSS', false, true);
      document.execCommand('defaultParagraphSeparator', false, 'p');
    } catch { /* 忽略 */ }
  });

  box.append(bar, editor);
  if (opts.hint) box.appendChild(el('p', 'field-hint', opts.hint));
  wrap.appendChild(box);
  sync();
  return { wrap, editor, sync, setHtml: (html) => { editor.innerHTML = clean(html); lastHtml = null; sync(); } };
}


export { RichText, makeRichField };
