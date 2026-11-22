// 路由注册表：路径 / 方法 / 处理函数的唯一清单。
// server.js 只负责把这张表变成 Map 并分发；新增接口先在这里登记。
'use strict';

const { sendJson } = require('../http');
const participant = require('./participant');
const auth = require('./auth');
const admin = require('./admin');
const adminData = require('./admin-data');
const preview = require('../preview');
const net = require('./net');

module.exports = [
  // 运维 / 健康检查
  ['GET', '/api/health', (req, res) => sendJson(res, 200, { ok: true })],
  ['GET', '/api/net-info', net.handleNetInfo],
  ['GET', '/qr.svg', net.handleQrSvg],

  // 被试端
  ['GET', '/api/bootstrap', participant.handleBootstrap],
  ['POST', '/api/session', participant.handleCreateSession],
  ['POST', '/api/step', participant.handleStep],
  ['POST', '/api/finish', participant.handleFinish],
  ['POST', '/api/heartbeat', participant.handleHeartbeat],
  ['POST', '/api/preview/create', preview.handleAdminPreviewCreate],
  ['POST', '/api/admin/preview', preview.handleAdminPreviewCreate],
  ['GET', '/api/preview/bootstrap', preview.handlePreviewBootstrap],
  ['POST', '/api/preview/session', preview.handlePreviewSession],
  ['POST', '/api/preview/step', preview.handlePreviewStep],
  ['POST', '/api/preview/seek', preview.handlePreviewSeek],
  ['POST', '/api/preview/seek-unit', preview.handlePreviewSeekUnit],
  ['POST', '/api/preview/speed', preview.handlePreviewSpeed],
  ['POST', '/api/preview/destroy', preview.handlePreviewDestroy],
  ['POST', '/api/preview/finish', preview.handlePreviewFinish],
  ['POST', '/api/step/retry', participant.handleStepRetry],

  // 管理端 · 登录与元信息
  ['POST', '/api/auth/register', auth.handleRegister],
  ['POST', '/api/auth/login', auth.handleLogin],
  ['POST', '/api/auth/logout', auth.handleLogout],
  ['GET', '/api/auth/me', auth.handleMe],
  ['POST', '/api/auth/password', auth.handleChangePassword],
  ['POST', '/api/auth/avatar', auth.handleAvatar],
  ['POST', '/api/auth/assistant', auth.handleAssistantConfig],
  ['GET', '/api/admin/meta', admin.handleAdminMeta],
  ['GET', '/api/admin/settings', admin.handleAdminGetSettings],
  ['POST', '/api/admin/settings', admin.handleAdminSaveSettings],

  // 用户管理（管理员）
  ['GET', '/api/admin/users', admin.handleUsersList],
  ['POST', '/api/admin/users/create', admin.handleUserCreate],
  ['POST', '/api/admin/users/update', admin.handleUserUpdate],
  ['POST', '/api/admin/users/delete', admin.handleUserDelete],

  // 管理端 · 实验模板库
  ['GET', '/api/admin/experiments', admin.handleAdminExperiments],
  ['GET', '/api/admin/experiment', admin.handleAdminExperiment],
  ['POST', '/api/admin/experiment/create', admin.handleAdminExperimentCreate],
  ['POST', '/api/admin/experiment/import', admin.handleAdminExperimentImport],
  ['POST', '/api/admin/experiment/update', admin.handleAdminExperimentUpdate],
  ['POST', '/api/admin/experiment/delete', admin.handleAdminExperimentDelete],

  // 管理端 · 问卷
  ['GET', '/api/admin/questionnaires', admin.handleAdminQuestionnaires],
  ['GET', '/api/admin/questionnaire', admin.handleAdminQuestionnaire],
  ['POST', '/api/admin/questionnaire/create', admin.handleAdminQuestionnaireCreate],
  ['POST', '/api/admin/questionnaire/import', admin.handleAdminQuestionnaireImport],
  ['POST', '/api/admin/questionnaire/update', admin.handleAdminQuestionnaireUpdate],
  ['POST', '/api/admin/questionnaire/delete', admin.handleAdminQuestionnaireDelete],
  ['GET', '/api/admin/questionnaire/sessions', adminData.handleAdminQuestionnaireSessions],
  ['POST', '/api/admin/questionnaire/sessions/delete', adminData.handleAdminSessionsDelete],
  ['GET', '/api/admin/questionnaire/session', adminData.handleAdminQuestionnaireSession],
  ['GET', '/api/admin/questionnaire/export.xlsx', adminData.handleAdminQuestionnaireExport]
];
