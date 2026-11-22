'use strict';

import {
  $, state, clearTokens, storeToken, LOGIN_REMEMBER_KEY
} from '../core/state.js';
import { api } from '../core/api.js';

const KICKED_MSG = '该账号已在其他设备登录或已修改密码，本设备登录已失效，请重新登录。';
const LAST_USER_KEY = 'expchat_last_user';                   // 上次登录的账号：登录卡片用来预填

let onLoginSuccess = null;

function showLogin(message) {
  $('admin-view').classList.add('hidden');
  $('login-view').classList.remove('hidden');
  showBlock('login');
  hideLoginError();
  if (message) showLoginError(message);
  prefillLogin();
}

// 401：登录已失效（被其他设备顶下线 / 已改密 / 已过期）→ 清掉本机登录态，原地切回登录卡片
function backToLogin(err) {
  state.token = '';
  state.user = null;
  clearTokens();
  showLogin(err && err.code === 'kicked' ? KICKED_MSG : '登录已失效，请重新登录。');
}


/* ---- 登录卡片 -------------------------------------------------------- */

// 登录 / 注册 / 重置说明三块互斥显示
function showBlock(name) {
  ['login-block', 'register-block', 'reset-block'].forEach((id) => {
    $(id).classList.toggle('hidden', id !== name + '-block');
  });
}

function showLoginError(msg) { const p = $('login-error'); p.textContent = msg; p.classList.remove('hidden'); }
function hideLoginError() { $('login-error').classList.add('hidden'); }
function showRegError(msg) { const p = $('reg-error'); p.textContent = msg; p.classList.remove('hidden'); }
function hideRegError() { $('reg-error').classList.add('hidden'); }

// 「记住账号密码」：勾选后把账号密码与 30 天 token 存在本机（localStorage），重开浏览器免登录
function readRememberRecord() {
  try {
    const rec = JSON.parse(localStorage.getItem(LOGIN_REMEMBER_KEY) || 'null');
    if (!rec || !rec.username) return null;
    if (Number(rec.expiresAt) && Number(rec.expiresAt) < Date.now()) { localStorage.removeItem(LOGIN_REMEMBER_KEY); return null; }
    return rec;
  } catch { return null; }
}
function saveRememberRecord(username, password) {
  try {
    localStorage.setItem(LOGIN_REMEMBER_KEY, JSON.stringify({
      username, password, expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000
    }));
  } catch { /* 忽略 */ }
}
function clearRememberRecord() {
  try { localStorage.removeItem(LOGIN_REMEMBER_KEY); } catch { /* 忽略 */ }
}
// 预填：优先「记住的账号密码」→ 其次「上次登录的账号」；并清掉浏览器可能自动填进来的别的账号
function prefillLogin() {
  const rec = readRememberRecord();
  let last = '';
  try { last = localStorage.getItem(LAST_USER_KEY) || ''; } catch { /* 忽略 */ }
  const userEl = $('login-username');
  const pwdEl = $('login-password');
  const want = rec ? rec.username : last;
  if (want && userEl.value !== want) userEl.value = want;
  if (rec && rec.password && pwdEl.value !== rec.password) pwdEl.value = rec.password;
  $('login-remember').checked = !!rec;
}

async function submitLogin(e) {
  e.preventDefault();
  const username = $('login-username').value.trim();
  const password = $('login-password').value;
  const remember = $('login-remember').checked;
  if (!username || !password) { showLoginError('请输入账号和密码'); return; }
  hideLoginError();
  const btn = $('login-btn');
  btn.disabled = true;
  try {
    const res = await api('/api/auth/login', { body: { username, password, remember } });
    state.user = res.user || null;                 // storeToken 记 30 天记录时要写账号名
    storeToken(res.token, remember, res.ttlMs);
    try { localStorage.setItem(LAST_USER_KEY, username); } catch { /* 忽略 */ }
    if (remember) saveRememberRecord(username, password);
    else clearRememberRecord();
    await onLoginSuccess();
  } catch (err) {
    showLoginError(err.message || '登录失败，请重试');
  } finally {
    // 成功也要恢复：否则「登录 → 退出登录」后按钮还是禁用态，用户无法再登录
    btn.disabled = false;
  }
}

async function submitRegister(e) {
  e.preventDefault();
  const username = $('reg-username').value.trim();
  const password = $('reg-password').value;
  if (!username) { showRegError('请输入账号'); return; }
  if (password.length < 10) { showRegError('密码至少 10 位'); return; }
  if (password !== $('reg-password2').value) { showRegError('两次输入的密码不一致'); return; }
  hideRegError();
  const btn = $('reg-btn');
  btn.disabled = true;
  try {
    const res = await api('/api/auth/register', { body: { username, password } });
    state.user = res.user || null;
    storeToken(res.token, false);
    await onLoginSuccess();
  } catch (err) {
    showRegError(err.message || '注册失败，请重试');
  } finally {
    btn.disabled = false;                        // 同登录按钮：成功也要恢复，注册后再注册才点得动
  }
}

// 问卷入口：支持粘贴完整链接（提取 q= 参数）或直接输入短码
function submitSurveyEntry(e) {
  e.preventDefault();
  const raw = $('survey-code').value.trim();
  if (!raw) return;
  let code = raw;
  try {
    const url = new URL(raw);
    const q = url.searchParams.get('q') || url.searchParams.get('c');
    if (q) code = q.trim();
  } catch { /* 不是 URL：当作短码 */ }
  if (!code) return;
  location.href = '/chat?q=' + encodeURIComponent(code);
}

$('login-form').addEventListener('submit', submitLogin);
$('register-form').addEventListener('submit', submitRegister);
$('survey-form').addEventListener('submit', submitSurveyEntry);
// 这一行没有提交按钮，回车就是唯一的提交方式：显式绑一次，不依赖浏览器的隐式提交
$('survey-code').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  submitSurveyEntry(e);
});
$('show-register').addEventListener('click', () => showBlock('register'));
$('show-reset').addEventListener('click', () => showBlock('reset'));
$('back-login').addEventListener('click', () => showBlock('login'));
$('back-login2').addEventListener('click', () => showBlock('login'));

// 浏览器自带的账号填充可能晚一拍落地：登录卡片可见时再覆盖一次
window.addEventListener('load', () => {
  if (!$('login-view').classList.contains('hidden')) setTimeout(prefillLogin, 300);
});


export { KICKED_MSG, LAST_USER_KEY, showLogin, backToLogin };

export function bindLoginUI(onSuccess) {
  onLoginSuccess = onSuccess;
}
