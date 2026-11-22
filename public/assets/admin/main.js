// 管理端入口：登录态切换、路由启动、跨页面回调装配。
// 页面模块只导出 render 函数，跳转统一改 location.hash，由 core/router.js 分发。
'use strict';

import { $, state } from './core/state.js';
import {
  api, loadMeta, reloadExperiments, reloadQuestionnaires, setUnauthorizedHandler
} from './core/api.js';
import { initLayout } from './core/layout.js';
import { renderSidebarAvatar, toast } from './core/ui.js';
import { handleRoute } from './core/router.js';
import { initNewItem, consumePendingImport } from './features/new-item.js';
import { KICKED_MSG, showLogin, backToLogin, bindLoginUI } from './pages/login.js';
import { renderExpList, createExperimentDirect } from './pages/exp.js';
import { renderQList, createQuestionnaireDirect } from './pages/q-list.js';

async function enterAdmin() {
  initLayout();
  const me = await api('/api/auth/me');
  state.user = me.user;
  renderSidebarAvatar();
  await Promise.all([loadMeta(), reloadExperiments(), reloadQuestionnaires()]);
  $('login-view').classList.add('hidden');
  $('admin-view').classList.remove('hidden');
  handleRoute();
  consumePendingImport();       // 分享链接（?import=CODE）进入时自动打开「新建」弹窗并预填编号
}

// 「新建 / 复制」弹窗的页面回调：由这里注入，避免 features 反向 import pages。
initNewItem({
  async onImported(kind, res) {
    if (kind === 'exp') {
      await reloadExperiments();
      renderExpList();
      toast(`已复制为「${res.experiment.name}」，点击「进入编辑」修改`);
    } else {
      await reloadQuestionnaires();
      renderQList();
      toast(`已复制为「${res.questionnaire.title}」，点击「编辑」修改`);
    }
  },
  async onCreate(kind, title) {
    if (kind === 'exp') await createExperimentDirect({ copyFrom: null, name: title });
    else await createQuestionnaireDirect({ copyFrom: null, title });
  }
});

setUnauthorizedHandler(backToLogin);
bindLoginUI(enterAdmin);

async function boot() {
  // 老链接 / 旧书签可能带 ?kicked=1（被顶下线的提示参数）：清掉参数，并在登录卡片上说明原因
  const kicked = new URLSearchParams(location.search).get('kicked') === '1';
  if (kicked) { try { history.replaceState(null, '', location.pathname + location.hash); } catch { /* 忽略 */ } }
  if (!state.token) { showLogin(kicked ? KICKED_MSG : ''); return; }
  try {
    await enterAdmin();
  } catch (err) {
    if (err.status === 401) backToLogin(err);
    else showLogin('无法加载管理端数据，请刷新页面重试。');
  }
}

boot();
