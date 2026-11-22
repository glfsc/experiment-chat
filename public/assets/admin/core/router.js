'use strict';

import { $, state } from './state.js';
import { setSidebarMode, setTopbar, setTopbarBack } from './layout.js';
import { disposeEditor } from '../features/editor-context.js';
import { renderExpList, renderExpEditor } from '../pages/exp.js';
import { renderQList } from '../pages/q-list.js';
import { renderQEditor } from '../pages/q-editor.js';
import { renderQData, renderQSession } from '../pages/q-data.js';
import { renderSettings } from '../pages/settings.js';
import { renderUsers } from '../pages/users.js';

/* ---------------------------------------------------------------- 路由 */
// #/exp、#/exp/:id
// #/q、#/q/:id、#/q/:id/data、#/q/:id/s/:sid
// #/settings（个人设置）、#/users（用户管理，仅管理员）

function parseHash() {
  const raw = location.hash.replace(/^#\/?/, '');
  const [section, a, b, c] = raw.split('/');
  if (section === 'settings') return { section, view: 'settings' };
  if (section === 'users') return { section, view: 'users' };
  if (section === 'exp') return a ? { section, view: 'editor', id: a } : { section, view: 'list' };
  if (section === 'q') {
    if (!a) return { section, view: 'list' };
    if (b === 'data') return { section, view: 'data', id: a };
    if (b === 's' && c) return { section, view: 'session', id: a, sid: c };
    return { section, view: 'editor', id: a };
  }
  return null;
}

function handleRoute() {
  if ($('admin-view').classList.contains('hidden')) return;
  // 切页：先释放上一个编辑页的资源（进度轮询 / 预览会话）
  disposeEditor();
  if (!location.hash) { location.replace('#/q'); return; }
  const route = parseHash();
  if (!route) { location.replace('#/q'); return; }

  document.querySelectorAll('.sidebar-item').forEach((item) => {
    item.classList.toggle('active', item.dataset.nav === route.section);
  });

  const editing = route.view === 'editor';
  if (route.view === 'settings' || route.view === 'users') {
    state.view = route.view;
    setSidebarMode('menu');
    setTopbar(route.view === 'settings' ? '个人设置' : '用户管理');
    setTopbarBack(route.view === 'settings');       // 设置页有「← 返回」；用户管理没有
    if (route.view === 'settings') renderSettings();
    else renderUsers();
    window.scrollTo(0, 0);
    return;
  }
  state.view = route.section === 'exp' ? (editing ? 'exp-editor' : 'exp-list') : route.view === 'list' ? 'q-list' : route.view === 'editor' ? 'q-editor' : route.view === 'data' ? 'q-data' : 'q-session';

  // 手机端顶栏：列表页在这里给标题；编辑 / 数据 / 会话页等数据加载完由各渲染器（或 editorShell）设置
  if (route.view === 'list') {
    setTopbar(route.section === 'exp' ? '实验管理' : '问卷管理');
    setTopbarBack(false);
  } else {
    setTopbar('加载中…');
    setTopbarBack(true);
  }

  // 进入编辑页默认切到大纲；回到列表 / 数据页切回菜单
  // 列表 / 数据页切回菜单；编辑页在题目加载完成后再切到大纲（见 renderExpEditor / renderQEditor）
  if (!editing) setSidebarMode('menu');

  if (state.view === 'exp-list') renderExpList();
  else if (state.view === 'exp-editor') renderExpEditor(route.id);
  else if (state.view === 'q-list') renderQList();
  else if (state.view === 'q-editor') renderQEditor(route.id);
  else if (state.view === 'q-data') renderQData(route.id);
  else if (state.view === 'q-session') renderQSession(route.id, route.sid);
  window.scrollTo(0, 0);
}

window.addEventListener('hashchange', handleRoute);

document.querySelectorAll('.sidebar-item').forEach((a) => {
  a.addEventListener('click', (e) => {
    e.preventDefault();
    location.hash = a.dataset.nav === 'exp' ? '#/exp' : '#/q';
  });
});

$('btn-settings').addEventListener('click', () => {
  location.hash = '#/settings';
});

export { parseHash, handleRoute };
