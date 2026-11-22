'use strict';

import {
  $, $main, $sidebarMenu, $sidebarOutline, $segMenu, $segOutline,
  state, currentEditing, mqlMobile, isMobile
} from './state.js';
import { toast } from './ui.js';
import { renderOutline } from '../features/outline.js';

function setSidebarMode(mode) {
  const editing = !!currentEditing();
  if (mode === 'outline' && !editing) mode = 'menu';
  state.sidebarMode = mode;
  const isOutline = mode === 'outline';
  $sidebarMenu.classList.toggle('hidden', isOutline);
  $sidebarOutline.classList.toggle('hidden', !isOutline);
  $segMenu.classList.toggle('on', !isOutline);
  $segOutline.classList.toggle('on', isOutline);
  $segOutline.disabled = !editing;
  if (isOutline) renderOutline();
}

$segMenu.addEventListener('click', () => setSidebarMode('menu'));
$segOutline.addEventListener('click', () => setSidebarMode('outline'));

/* ---------------------------------------------------------------- 手机端：顶栏 + 抽屉（≤720px） */

function setTopbar(title) { $('tb-title').textContent = title; }
function setTopbarBack(show) { $('tb-back').classList.toggle('hidden', !show); }
function closeDrawer() { document.body.classList.remove('drawer-open'); }
$('tb-menu').addEventListener('click', () => document.body.classList.toggle('drawer-open'));
$('tb-back').addEventListener('click', () => {
  // 顶栏 ← 等价于页面里那个返回按钮（编辑页「← 返回列表」/ 数据页「← 返回…」/ 设置页「← 返回」）：
  // 直接点它，未保存确认弹窗等原有逻辑全部保留（手机端那个按钮被 CSS 隐藏，但仍在 DOM 里可点）
  const back = $main.querySelector('.editor-head button, .settings-back');
  if (back) back.click();
});
$('drawer-mask').addEventListener('click', closeDrawer);
// 抽屉里点了菜单项 / 设置 / 大纲行：跳转的同时自动收起（「菜单 / 大纲」分段切换不收，方便接着点）
document.querySelector('.sidebar').addEventListener('click', (e) => {
  if (!isMobile()) return;
  if (e.target.closest('.sidebar-item, #btn-settings, .ol-item')) closeDrawer();
});
// 跨过 720px 断点：收起抽屉；非编辑页直接重渲染换布局（编辑页不动，避免丢未保存内容）
mqlMobile.addEventListener('change', () => {
  closeDrawer();
  if (!$('admin-view').classList.contains('hidden') && !currentEditing()) window.dispatchEvent(new Event('hashchange'));
});

/* ---------------------------------------------------------------- 三栏布局：拖动分隔线 / 菜单栏折叠与缩放 */

const LAYOUT_KEY = 'expchat_layout';
const LAYOUT_DEF = { sidebar: 246, phone: 348, collapsed: false };

function loadLayout() {
  try { return { ...LAYOUT_DEF, ...JSON.parse(localStorage.getItem(LAYOUT_KEY) || '{}') }; } catch { return { ...LAYOUT_DEF }; }
}
function saveLayout(patch) {
  const next = { ...loadLayout(), ...patch };
  localStorage.setItem(LAYOUT_KEY, JSON.stringify(next));
  applyLayout(next);
}
function applyLayout(l) {
  const root = document.documentElement.style;
  root.setProperty('--sidebar-w', `${l.sidebar}px`);
  root.setProperty('--phone-w', `${l.phone}px`);
  document.body.classList.toggle('side-collapsed', !!l.collapsed);
  const btn = $('btn-side-collapse');
  if (btn) btn.textContent = l.collapsed ? '»' : '«';
  if (typeof fitPhoneScale === 'function') fitPhoneScale();   // 拖动改动手机栏宽度时同步缩放
}
function startDrag(ev, which) {
  ev.preventDefault();
  const startX = ev.clientX;
  const start = loadLayout();
  const move = (e) => {
    const dx = e.clientX - startX;
    if (which === 'sidebar') saveLayout({ sidebar: Math.min(460, Math.max(180, start.sidebar + dx)) });
    else saveLayout({ phone: Math.min(680, Math.max(280, start.phone - dx)) });
  };
  const up = () => {
    window.removeEventListener('mousemove', move);
    window.removeEventListener('mouseup', up);
    document.body.classList.remove('col-dragging');
  };
  window.addEventListener('mousemove', move);
  window.addEventListener('mouseup', up);
  document.body.classList.add('col-dragging');
}
let layoutInited = false;
function initLayout() {
  // 退出登录后再登录会二次进入管理端：这些监听只能绑一次，否则会出现双份提示
  if (layoutInited) return;
  layoutInited = true;
  applyLayout(loadLayout());
  const side = $('split-sidebar');
  if (side) {
    side.addEventListener('mousedown', (e) => startDrag(e, 'sidebar'));
    side.addEventListener('dblclick', () => { saveLayout({ sidebar: LAYOUT_DEF.sidebar }); toast('菜单栏宽度已复位'); });
  }
  $('btn-side-collapse').addEventListener('click', () => {
    const next = !loadLayout().collapsed;
    saveLayout({ collapsed: next });
    toast(next ? '菜单栏已折叠' : '菜单栏已展开');
  });
}

const PHONE_W = 393;
const PHONE_H = 852;
function fitPhoneScale() {
  const col = document.querySelector('.phone-col');
  const holder = col && col.querySelector('.phone-holder');
  const phone = holder && holder.querySelector('.phone');
  if (!col || !holder || !phone) return;
  const cols = document.querySelector('.editor-cols');
  const stacked = !!(cols && getComputedStyle(cols).flexDirection === 'column');   // 窄屏：上下堆叠，整页滚动
  const availW = Math.max(240, col.clientWidth);
  let availH;
  if (stacked) {
    availH = Math.max(320, window.innerHeight - 90);
  } else {
    const main = document.querySelector('.admin-main');
    const mainRect = (main || document.documentElement).getBoundingClientRect();
    const bottom = Math.min(window.innerHeight, mainRect.bottom);
    availH = Math.max(300, bottom - holder.getBoundingClientRect().top - 14);
  }
  const scale = Math.min(1, availW / PHONE_W, availH / PHONE_H);
  phone.style.setProperty('--phone-scale', String(scale));
  holder.style.width = `${Math.round(PHONE_W * scale)}px`;
  holder.style.height = `${Math.round(PHONE_H * scale)}px`;
  // 兜底：万一还有别的原因把主区域顶出滚动，把它归零（否则右侧手机栏会整体上移）
  const main = document.querySelector('.admin-main');
  if (main && main.scrollTop) main.scrollTop = 0;
}
window.addEventListener('resize', () => fitPhoneScale());

export {
  setSidebarMode,
  isMobile,
  setTopbar,
  setTopbarBack,
  closeDrawer,
  loadLayout,
  saveLayout,
  applyLayout,
  startDrag,
  initLayout,
  PHONE_W,
  PHONE_H,
  fitPhoneScale
};
