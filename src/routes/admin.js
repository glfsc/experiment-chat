'use strict';

const store = require('../../db');
const { sendJson, readJsonBody } = require('../http');
const { requireUser, requireAdmin, canAccess } = require('../auth');
const { MAX_QUESTIONNAIRES_PER_USER, MAX_EXPERIMENTS_PER_USER } = require('../config');

// ---------------------------------------------------------------- 用户管理（管理员）
function handleUsersList(req, res) {
  const user = requireAdmin(req, res);
  if (!user) return;
  sendJson(res, 200, { users: store.listUsers() });
}

async function handleUserCreate(req, res) {
  const admin = requireAdmin(req, res);
  if (!admin) return;
  const body = await readJsonBody(req);
  try {
    sendJson(res, 200, { user: store.createUser(body) });
  } catch (err) {
    sendJson(res, 400, { error: 'user_create_failed', message: err.message || '创建失败' });
  }
}

async function handleUserUpdate(req, res) {
  const admin = requireAdmin(req, res);
  if (!admin) return;
  const body = await readJsonBody(req);
  const target = store.getUser(String(body.id || '').trim());
  if (!target) return sendJson(res, 404, { error: 'user_not_found', message: '用户不存在' });
  try {
    const updated = store.updateUser(target.id, body);
    // 管理员为他人重置密码：与本人改密同口径 —— 该账号所有旧登录立即失效
    if (body.password) store.bumpTokenEpoch(target.id);
    sendJson(res, 200, { user: updated });
  } catch (err) {
    sendJson(res, 400, { error: 'user_update_failed', message: err.message || '修改失败' });
  }
}

async function handleUserDelete(req, res) {
  const admin = requireAdmin(req, res);
  if (!admin) return;
  const body = await readJsonBody(req);
  const id = String(body.id || '').trim();
  if (id === admin.id) return sendJson(res, 400, { error: 'self_delete', message: '不能删除自己的账号' });
  const result = store.deleteUser(id);
  if (!result.ok) return sendJson(res, 404, { error: 'user_not_found', message: '用户不存在' });
  sendJson(res, 200, { ok: true });
}

// GET /api/admin/meta —— 编辑器元信息（题型 / 限制 / 默认题目 / 设置）
function handleAdminMeta(req, res) {
  if (!requireUser(req, res)) return;
  sendJson(res, 200, {
    itemTypes: store.ITEM_TYPES,
    questionTypes: store.QUESTION_TYPES,
    itemTypeLabels: store.ITEM_TYPE_LABELS,
    itemVariants: store.ITEM_VARIANTS,
    itemLimits: store.ITEM_LIMITS,
    limitMeta: store.LIMIT_META,
    limitSpec: store.LIMIT_SPEC,
    limitDefaults: store.DEFAULT_LIMITS,
    abandonAfterMinutes: store.getAbandonAfterMinutes(),
    itemDefaults: store.itemDefaults(),
    defaultQuestionnaireItems: store.defaultQuestionnaireItems(),
    resumeWindowHours: store.getResumeWindowHours()
  });
}

function adminSettingsPayload() {
  return {
    resumeWindowHours: store.getResumeWindowHours(),
    abandonAfterMinutes: store.getAbandonAfterMinutes(),
    maxQuestionnairesPerUser: store.getMaxQuestionnairesPerUser(MAX_QUESTIONNAIRES_PER_USER),
    maxExperimentsPerUser: store.getMaxExperimentsPerUser(MAX_EXPERIMENTS_PER_USER)
  };
}

function handleAdminGetSettings(req, res) {
  if (!requireAdmin(req, res)) return;
  sendJson(res, 200, { settings: adminSettingsPayload() });
}

async function handleAdminSaveSettings(req, res) {
  if (!requireAdmin(req, res)) return;
  const body = await readJsonBody(req);
  if (body.resumeWindowHours != null) store.setResumeWindowHours(body.resumeWindowHours);
  if (body.abandonAfterMinutes != null) store.setAbandonAfterMinutes(body.abandonAfterMinutes);
  if (body.maxQuestionnairesPerUser != null) store.setMaxQuestionnairesPerUser(body.maxQuestionnairesPerUser);
  if (body.maxExperimentsPerUser != null) store.setMaxExperimentsPerUser(body.maxExperimentsPerUser);
  sendJson(res, 200, { settings: adminSettingsPayload() });
}

// ---------------------------------------------------------------- 实验模板库（按创建者隔离）
function handleAdminExperiments(req, res) {
  const user = requireUser(req, res);
  if (!user) return;
  sendJson(res, 200, { experiments: store.listExperiments(user.id) });
}

function handleAdminExperiment(req, res, url) {
  const user = requireUser(req, res);
  if (!user) return;
  const experiment = store.getExperiment((url.searchParams.get('id') || '').trim());
  if (!experiment || !canAccess(user, experiment)) {
    return sendJson(res, 404, { error: 'experiment_not_found', message: '实验不存在' });
  }
  sendJson(res, 200, { experiment: store.getExperimentPayload(experiment.id) });
}

async function handleAdminExperimentCreate(req, res) {
  const user = requireUser(req, res);
  if (!user) return;
  const experimentLimit = store.getMaxExperimentsPerUser(MAX_EXPERIMENTS_PER_USER);
  if (user.role !== 'admin' && store.countExperimentsByOwner(user.id) >= experimentLimit) {
    return sendJson(res, 403, { error: 'quota_exceeded', message: `实验数量已达上限（${experimentLimit} 个），请先删除不用的实验` });
  }
  const body = await readJsonBody(req);
  const name = String(body.name || '').trim();
  if (!name) return sendJson(res, 400, { error: 'bad_name', message: '实验名称不能为空' });
  const copyFrom = String(body.copyFrom || '').trim();
  if (copyFrom) {
    const source = store.getExperiment(copyFrom);
    if (!source || !canAccess(user, source)) {
      return sendJson(res, 400, { error: 'copy_source_not_found', message: '复制来源实验不存在' });
    }
  }
  sendJson(res, 200, { experiment: store.createExperiment({ name, copyFrom: copyFrom || null, ownerId: user.id }) });
}

// 分享编号解析：接受纯编号（列表里显示的那串），也接受整条链接（被试链接 ?q= / 分享链接 ?import=）；
// 解析不出来返回空串，由调用方回错误
function normalizeShareCode(raw) {
  const text = String(raw || '').trim();
  if (!text) return '';
  const hit = text.match(/[?&](?:q|import)=([A-Za-z0-9_-]+)/);
  const candidate = hit ? hit[1] : text;
  return /^[A-Za-z0-9_-]{4,64}$/.test(candidate) ? candidate.toLowerCase() : '';
}

// POST /api/admin/experiment/import { code, name } —— 按分享编号把一份实验模板复制到当前账号
// 编号 = 实验自身 id（不校验归属）：只复制题目，新编号、新归属，互不影响
async function handleAdminExperimentImport(req, res) {
  const user = requireUser(req, res);
  if (!user) return;
  const experimentLimit = store.getMaxExperimentsPerUser(MAX_EXPERIMENTS_PER_USER);
  if (user.role !== 'admin' && store.countExperimentsByOwner(user.id) >= experimentLimit) {
    return sendJson(res, 403, { error: 'quota_exceeded', message: `实验数量已达上限（${experimentLimit} 个），请先删除不用的实验` });
  }
  const body = await readJsonBody(req);
  const code = normalizeShareCode(body.code);
  if (!code) return sendJson(res, 400, { error: 'bad_code', message: '请填写分享编号，或粘贴完整的分享链接' });
  const source = store.getExperiment(code);
  if (!source) return sendJson(res, 404, { error: 'import_source_not_found', message: '编号不存在或已删除，请核对后重试' });
  const name = String(body.name || '').trim() || `${source.name}（副本）`;
  sendJson(res, 200, { experiment: store.createExperiment({ name, copyFrom: code, ownerId: user.id }) });
}

async function handleAdminExperimentUpdate(req, res) {
  const user = requireUser(req, res);
  if (!user) return;
  const body = await readJsonBody(req);
  const experiment = store.getExperiment(String(body.id || '').trim());
  if (!experiment || !canAccess(user, experiment)) {
    return sendJson(res, 404, { error: 'experiment_not_found', message: '实验不存在' });
  }
  const name = String(body.name || '').trim();
  if (!name) return sendJson(res, 400, { error: 'bad_name', message: '实验名称不能为空' });
  sendJson(res, 200, { experiment: store.updateExperiment(experiment.id, { name, items: body.items }) });
}

async function handleAdminExperimentDelete(req, res) {
  const user = requireUser(req, res);
  if (!user) return;
  const body = await readJsonBody(req);
  const experiment = store.getExperiment(String(body.id || '').trim());
  if (!experiment || !canAccess(user, experiment)) {
    return sendJson(res, 404, { error: 'experiment_not_found', message: '实验不存在' });
  }
  store.deleteExperiment(experiment.id);
  sendJson(res, 200, { ok: true });
}

// ---------------------------------------------------------------- 问卷（按创建者隔离）
function handleAdminQuestionnaires(req, res) {
  const user = requireUser(req, res);
  if (!user) return;
  sendJson(res, 200, { questionnaires: store.listQuestionnaires(user.id) });
}

function handleAdminQuestionnaire(req, res, url) {
  const user = requireUser(req, res);
  if (!user) return;
  const questionnaire = store.getQuestionnaire((url.searchParams.get('id') || '').trim());
  if (!questionnaire || !canAccess(user, questionnaire)) {
    return sendJson(res, 404, { error: 'questionnaire_not_found', message: '问卷不存在' });
  }
  sendJson(res, 200, { questionnaire: store.getQuestionnairePayload(questionnaire.id) });
}

async function handleAdminQuestionnaireCreate(req, res) {
  const user = requireUser(req, res);
  if (!user) return;
  const questionnaireLimit = store.getMaxQuestionnairesPerUser(MAX_QUESTIONNAIRES_PER_USER);
  if (user.role !== 'admin' && store.countQuestionnairesByOwner(user.id) >= questionnaireLimit) {
    return sendJson(res, 403, { error: 'quota_exceeded', message: `问卷数量已达上限（${questionnaireLimit} 份），请先删除不用的问卷` });
  }
  const body = await readJsonBody(req);
  const title = String(body.title || '').trim();
  if (!title) return sendJson(res, 400, { error: 'bad_title', message: '问卷名称不能为空' });
  const copyFrom = String(body.copyFrom || '').trim();
  if (copyFrom) {
    const source = store.getQuestionnaire(copyFrom);
    if (!source || !canAccess(user, source)) {
      return sendJson(res, 400, { error: 'copy_source_not_found', message: '复制来源问卷不存在' });
    }
    const copied = store.copyQuestionnaire(copyFrom, title, user.id);
    if (!copied) return sendJson(res, 400, { error: 'copy_source_not_found', message: '复制来源问卷不存在' });
    return sendJson(res, 200, { questionnaire: copied });
  }
  sendJson(res, 200, { questionnaire: store.createQuestionnaire({ title, items: body.items, ownerId: user.id }) });
}

// POST /api/admin/questionnaire/import { code, title } —— 按分享编号把一份问卷复制到当前账号
// 编号 = 问卷自身 id（也是被试链接里的 q=，不校验归属）：题目照抄，新编号、新链接、新归属；
// 作答数据不随行（数据始终留在原问卷下）
async function handleAdminQuestionnaireImport(req, res) {
  const user = requireUser(req, res);
  if (!user) return;
  const questionnaireLimit = store.getMaxQuestionnairesPerUser(MAX_QUESTIONNAIRES_PER_USER);
  if (user.role !== 'admin' && store.countQuestionnairesByOwner(user.id) >= questionnaireLimit) {
    return sendJson(res, 403, { error: 'quota_exceeded', message: `问卷数量已达上限（${questionnaireLimit} 份），请先删除不用的问卷` });
  }
  const body = await readJsonBody(req);
  const code = normalizeShareCode(body.code);
  if (!code) return sendJson(res, 400, { error: 'bad_code', message: '请填写分享编号，或粘贴完整的分享链接' });
  const copied = store.copyQuestionnaire(code, String(body.title || '').trim(), user.id);
  if (!copied) return sendJson(res, 404, { error: 'import_source_not_found', message: '编号不存在或已删除，请核对后重试' });
  sendJson(res, 200, { questionnaire: copied });
}

async function handleAdminQuestionnaireUpdate(req, res) {
  const user = requireUser(req, res);
  if (!user) return;
  const body = await readJsonBody(req);
  const questionnaire = store.getQuestionnaire(String(body.id || '').trim());
  if (!questionnaire || !canAccess(user, questionnaire)) {
    return sendJson(res, 404, { error: 'questionnaire_not_found', message: '问卷不存在' });
  }
  const title = String(body.title || '').trim();
  if (!title) return sendJson(res, 400, { error: 'bad_title', message: '问卷名称不能为空' });
  sendJson(res, 200, { questionnaire: store.updateQuestionnaire(questionnaire.id, { title, items: body.items }) });
}

async function handleAdminQuestionnaireDelete(req, res) {
  const user = requireUser(req, res);
  if (!user) return;
  const body = await readJsonBody(req);
  const questionnaire = store.getQuestionnaire(String(body.id || '').trim());
  if (!questionnaire || !canAccess(user, questionnaire)) {
    if (questionnaire) return sendJson(res, 403, { error: 'forbidden', message: '无权删除该问卷' });
    return sendJson(res, 404, { error: 'questionnaire_not_found', message: '问卷不存在' });
  }
  const result = store.deleteQuestionnaire(questionnaire.id, { force: !!body.force });
  if (!result.ok) {
    if (result.reason === 'not_found') return sendJson(res, 404, { error: 'questionnaire_not_found', message: '问卷不存在' });
    return sendJson(res, 400, {
      error: 'has_sessions',
      message: `该问卷已有 ${result.sessionCount} 份被试数据，删除将一并清空，请确认`,
      sessionCount: result.sessionCount
    });
  }
  sendJson(res, 200, { ok: true });
}

module.exports = {
  handleUsersList,
  handleUserCreate,
  handleUserUpdate,
  handleUserDelete,
  handleAdminMeta,
  handleAdminGetSettings,
  handleAdminSaveSettings,
  handleAdminExperiments,
  handleAdminExperiment,
  handleAdminExperimentCreate,
  handleAdminExperimentImport,
  handleAdminExperimentUpdate,
  handleAdminExperimentDelete,
  handleAdminQuestionnaires,
  handleAdminQuestionnaire,
  handleAdminQuestionnaireCreate,
  handleAdminQuestionnaireImport,
  handleAdminQuestionnaireUpdate,
  handleAdminQuestionnaireDelete
};
