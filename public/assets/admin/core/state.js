'use strict';

// 管理端共享状态与登录态。这里也集中放 DOM 常量（管理端只有一个固定外壳，
// 元素在模块 defer 执行时已经解析完成）。

/* ---------------------------------------------------------------- 元素与状态 */

const $ = (id) => document.getElementById(id);
const $main = $('admin-main');
const $toast = $('toast');
const $modal = $('modal');
const $modalTitle = $('modal-title');
const $modalBody = $('modal-body');
const $modalError = $('modal-error');
const $modalCancel = $('modal-cancel');
const $modalConfirm = $('modal-confirm');
const $sidebarMenu = $('sidebar-menu');
const $sidebarOutline = $('sidebar-outline');
const $segMenu = $('seg-menu');
const $segOutline = $('seg-outline');

const TOKEN_KEY = 'expchat_admin_token';
const TOKEN_REMEMBER_KEY = 'expchat_admin_token_remember';   // { token, username, expiresAt }：勾了「记住密码」才有
const LOGIN_REMEMBER_KEY = 'expchat_login_remember';         // { username, password, expiresAt }：登录卡片的「记住账号密码」

// 「记住密码」= 登录页勾选后签发的 30 天 token（存 localStorage，重开浏览器仍免登录）
function loadRememberedTokenRecord() {
  try {
    const rec = JSON.parse(localStorage.getItem(TOKEN_REMEMBER_KEY) || 'null');
    if (!rec || !rec.token) return null;
    if (Number(rec.expiresAt) && Number(rec.expiresAt) < Date.now()) { localStorage.removeItem(TOKEN_REMEMBER_KEY); return null; }
    return rec;
  } catch { return null; }
}
function loadRememberedToken() {
  const rec = loadRememberedTokenRecord();
  return rec ? rec.token : '';
}
function clearTokens() {
  sessionStorage.removeItem(TOKEN_KEY);
  try { localStorage.removeItem(TOKEN_REMEMBER_KEY); } catch { /* 忽略 */ }
}
// 记一次登录态（登录 / 改密换发新 token 时复用）：remember 为真则同步刷新 30 天记录
function storeToken(token, remember, ttlMs) {
  state.token = token;
  try { sessionStorage.setItem(TOKEN_KEY, token); } catch { /* 忽略 */ }
  if (!remember) return;
  try {
    localStorage.setItem(TOKEN_REMEMBER_KEY, JSON.stringify({
      token,
      username: state.user ? state.user.username : '',
      expiresAt: Date.now() + (Number(ttlMs) || 30 * 24 * 60 * 60 * 1000)
    }));
  } catch { /* 忽略 */ }
}

const initialToken = sessionStorage.getItem(TOKEN_KEY) || loadRememberedToken();
if (initialToken) { try { sessionStorage.setItem(TOKEN_KEY, initialToken); } catch { /* 忽略 */ } }

const state = {
  token: initialToken,
  user: null,             // 当前登录用户 { id, username, role, avatar }
  meta: null,             // { itemTypes, itemTypeLabels, itemVariants, itemLimits, limitMeta, limitDefaults, itemDefaults, ... }
  experiments: [],
  questionnaires: [],
  editingExp: null,       // 编辑中的实验模板（本地副本，保存时提交）
  editingQ: null,         // 编辑中的问卷
  selected: null,         // 当前选中的题目 id
  sidebarMode: 'menu',    // menu | outline
  previewSpeed: 1,        // 手机预览的演示倍速（1 = 与正式实验一致）
  dragId: null,
  view: 'exp-list'
};

const TYPE = () => state.meta.itemTypes;
const TYPE_LABEL = (t) => (state.meta.itemTypeLabels[t] || t);
const TYPE_LIMITS = (t) => (state.meta.itemLimits[t] || []);
// 题目条上的类型标签：文本题的二级形态「需输入指定内容」带一个后缀，列表 / 大纲上一眼能认出来
function itemTypeLabel(item) {
  return item && item.type === 'text' && item.variant === 'match'
    ? `${TYPE_LABEL('text')}·需输入指定内容`
    : TYPE_LABEL(item && item.type);
}
const LIMIT_META = () => state.meta.limitMeta;
const LIMIT_DEFAULTS = () => state.meta.limitDefaults;

function currentEditing() {
  return state.view === 'exp-editor' ? state.editingExp : state.view === 'q-editor' ? state.editingQ : null;
}

// 媒体查询只建一次：layout（抽屉/顶栏）与 outline（手机端默认折叠）共用。
const mqlMobile = window.matchMedia('(max-width: 720px)');
const isMobile = () => mqlMobile.matches;

export {
  $, $main, $toast, $modal, $modalTitle, $modalBody, $modalError, $modalCancel, $modalConfirm,
  $sidebarMenu, $sidebarOutline, $segMenu, $segOutline,
  TOKEN_KEY, TOKEN_REMEMBER_KEY, LOGIN_REMEMBER_KEY,
  loadRememberedTokenRecord, loadRememberedToken, clearTokens, storeToken,
  state, TYPE, TYPE_LABEL, TYPE_LIMITS, itemTypeLabel, LIMIT_META, LIMIT_DEFAULTS,
  currentEditing, mqlMobile, isMobile
};

// 本机走查脚本（scripts/capture-shots.js）通过 CDP 读内部状态用；业务代码不要依赖它。
globalThis.__adminState = state;
