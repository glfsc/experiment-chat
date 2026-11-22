'use strict';

const store = require('../../db');
const { sendJson, readJsonBody } = require('../http');
const {
  parseSession,
  emitMessagesBetween,
  applyRefreshPoint,
  presentedAtFor,
  sessionPayload
} = require('../session/plan');
const { applyStep, retryCore } = require('../session/actions');

const ABANDONED = 'abandoned';

// ---------------------------------------------------------------- 被试端 API

// GET /api/bootstrap?q=<短码>&session=<会话id>
function handleBootstrap(req, res, url) {
  const code = (url.searchParams.get('q') || '').trim();
  const sid = (url.searchParams.get('session') || '').trim();
  const questionnaire = store.getQuestionnairePayload(code, { withItems: false });
  if (!questionnaire) {
    return sendJson(res, 404, { error: 'questionnaire_not_found', message: '问卷不存在或链接已失效' });
  }
  // 助手展示配置跟随问卷归属账号：每个管理者各有一套，未设置时前端回落内置默认圆形与名称
  const ownerRow = store.getQuestionnaire(code);
  const assistant = store.getAssistantConfig(ownerRow ? ownerRow.owner_id : '');
  let session = sid ? store.getSession(sid) : null;
  if (session && session.questionnaire_id !== code) session = null;                 // 防止跨问卷串数据
  if (session && session.status === 'in_progress') {
    // 「太久没提交」：超过自动作废时限 → 置为作废（数据留档），设备直接释放给下一位被试
    const abandonMin = store.getAbandonAfterMinutes();
    const lastMs = store.sessionLastActiveMs(session);
    const idleMs = lastMs ? Date.now() - lastMs : 0;
    if (abandonMin > 0 && idleMs > abandonMin * 60 * 1000) {
      store.abandonSession(session.id);
      session = null;
    }
  }
  if (session && session.status === 'in_progress') {
    const hours = store.getResumeWindowHours();                                     // 中途退出保留：超出恢复窗口则重新开始
    const startedMs = Date.parse(session.started_at);
    if (hours && Number.isFinite(startedMs) && Date.now() - startedMs > hours * 3600 * 1000) session = null;
    if (session) store.touchSession(session.id);                                    // 进入即算一次活动（心跳之外的兜底）
  }
  if (session && session.status === ABANDONED) session = null;                      // 已作废的会话不再续做
  if (!session) {
    return sendJson(res, 200, {
      questionnaireTitle: questionnaire.title,
      assistantAvatar: assistant.avatar,
      assistantName: assistant.name,
      session: null, messages: [], action: null, nowMs: Date.now()
    });
  }
  sendJson(res, 200, {
    questionnaireTitle: questionnaire.title,
    assistantAvatar: assistant.avatar,
    assistantName: assistant.name,
    ...sessionPayload(session)
  });
}

// POST /api/session { q }
async function handleCreateSession(req, res) {
  const body = await readJsonBody(req);
  const code = String(body.q || '').trim();
  const questionnaire = store.getQuestionnairePayload(code);
  if (!questionnaire) return sendJson(res, 404, { error: 'questionnaire_not_found', message: '问卷不存在或链接已失效' });
  if (!questionnaire.items.length) return sendJson(res, 400, { error: 'empty_items', message: '该问卷尚未配置题目，请联系研究人员' });

  const seq = store.nextSessionSeq(code);
  const session = store.createSession({
    questionnaireId: code,
    seq,
    items: questionnaire.items,
    userAgent: req.headers['user-agent'] || ''
  });

  const plan = parseSession(session);
  const nowMs = Date.now();
  emitMessagesBetween(session, plan, 0, nowMs);
  applyRefreshPoint(session, plan, 0);
  store.setPendingPresentedAt(session.id, presentedAtFor(session, plan, 0, nowMs));

  sendJson(res, 200, { questionnaireTitle: questionnaire.title, ...sessionPayload(store.getSession(session.id)) });
}

// POST /api/step { sessionId, ...作答 }
async function handleStep(req, res) {
  const body = await readJsonBody(req);
  const sessionId = String(body.sessionId || '').trim();
  if (!sessionId) return sendJson(res, 400, { error: 'bad_request', message: '缺少 sessionId' });
  const out = await applyStep(store, sessionId, body);
  if (out.error) return sendJson(res, out.status, out.error);
  sendJson(res, 200, out.payload);
}

// POST /api/finish { sessionId, abandon? } —— 提前结束；abandon = 作废这次作答（重做 / 重新开始用）
async function handleFinish(req, res) {
  const body = await readJsonBody(req);
  const id = String(body.sessionId || '').trim();
  const session = body.abandon ? store.abandonSession(id) : store.finishSession(id);
  if (!session) return sendJson(res, 404, { error: 'session_not_found', message: '会话不存在' });
  sendJson(res, 200, { session: { id: session.id, status: session.status, duration_sec: session.duration_sec } });
}

// POST /api/heartbeat { sessionId } —— 页面打开期间每分钟一次：只刷新「最近活动时间」，
// 免得被试慢慢读题时被误判成「太久没提交」而自动作废。
async function handleHeartbeat(req, res) {
  const body = await readJsonBody(req);
  const id = String(body.sessionId || '').trim();
  const session = id ? store.getSession(id) : null;
  if (!session) return sendJson(res, 404, { error: 'session_not_found', message: '会话不存在' });
  if (session.status === 'in_progress') store.touchSession(id);
  sendJson(res, 200, { ok: true, status: session.status, nowMs: Date.now() });
}


async function handleStepRetry(req, res) {
  const body = await readJsonBody(req);
  const sessionId = String(body.sessionId || '').trim();
  const out = await retryCore(store, sessionId);
  if (out.error) return sendJson(res, out.status, out.error);
  sendJson(res, 200, out.payload);
}

module.exports = {
  handleBootstrap,
  handleCreateSession,
  handleStep,
  handleFinish,
  handleHeartbeat,
  handleStepRetry
};
