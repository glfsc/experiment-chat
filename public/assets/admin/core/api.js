'use strict';

import { state, clearTokens } from './state.js';

async function api(path, options = {}) {
  const headers = {};
  if (options.body) headers['Content-Type'] = 'application/json';
  if (state.token) headers.Authorization = `Bearer ${state.token}`;
  const res = await fetch(path, {
    method: options.method || (options.body ? 'POST' : 'GET'),
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.message || data.error || `请求失败（${res.status}）`);
    err.status = res.status;
    err.code = data.error;
    throw err;
  }
  return data;
}

async function loadMeta() {
  state.meta = await api('/api/admin/meta');
}

async function reloadExperiments() {
  state.experiments = (await api('/api/admin/experiments')).experiments;
}
async function reloadQuestionnaires() {
  state.questionnaires = (await api('/api/admin/questionnaires')).questionnaires;
}

function maybeSessionExpired(err) {
  if (err.status !== 401) return false;
  if (onUnauthorized) onUnauthorized(err);
  return true;
}

let onUnauthorized = null;
export function setUnauthorizedHandler(fn) { onUnauthorized = fn; }

export {
  api,
  loadMeta,
  reloadExperiments,
  reloadQuestionnaires,
  maybeSessionExpired
};
