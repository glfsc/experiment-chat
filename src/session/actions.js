'use strict';

const { validateAnswer } = require('./validate');
const {
  parseSession,
  computeAction,
  emitMessagesBetween,
  presentedAtFor,
  applyRefreshPoint,
  sessionPayload,
  sessionBrief,
  currentQnoFor,
  isMessageStyle
} = require('./plan');
const { effLimit } = require('../util');

// 到点之后的宽限：被试端在到点瞬间自动提交的请求要放行；再晚就只能「重试」开新窗口
const WINDOW_GRACE_MS = 30 * 1000;

// 打分题「单独重做」：把某道**已提交**的打分题的分数改掉——只就地更新那一行与它的回显消息，
// 不写新行、不推进进度、不下发下一题/消息/清屏：当前作答完全不受影响（真实会话与预览会话共用）。
// body: { sessionId, itemId, value, redo: true }
function applyRedoStep(st, session, body) {
  if (session.status !== 'in_progress') {
    return { status: 409, error: { error: 'session_closed', message: '会话已结束，不能再修改' } };
  }
  const itemId = String(body.itemId || '').trim();
  if (!itemId) return { status: 400, error: { error: 'bad_request', message: '缺少 itemId' } };
  const plan = parseSession(session, st);
  const completedCount = st.countAnswerUnits(session.id);
  const pos = plan.units.findIndex((u) => u.item.id === itemId);
  // 只能改「已经交上去」的题：未作答的当前题走正常作答，不该用重做通道
  if (pos < 0 || pos >= completedCount) {
    return { status: 400, error: { error: 'redo_not_allowed', message: '只能修改已提交的题目' } };
  }
  const item = plan.units[pos].item;
  if (item.type !== 'rating') {
    return { status: 400, error: { error: 'redo_not_allowed', message: '该题型不支持重做' } };
  }
  if (effLimit(item, 'redo') !== 1) {
    return { status: 400, error: { error: 'redo_not_allowed', message: '本题未开启重做' } };
  }
  const check = validateAnswer(item, body, false);
  if (check.error || check.value == null) {
    return { status: 400, error: { error: 'invalid_answer', message: check.error || '作答值不合法' } };
  }
  const changed = st.redoResponse({
    sessionId: session.id,
    itemId,
    unitIndex: pos,
    value: check.value,
    valueText: check.valueText,
    optionLabel: check.optionLabel
  });
  if (!changed) {
    return { status: 409, error: { error: 'redo_not_allowed', message: '找不到原作答记录' } };
  }
  // 回显消息同步成新值（旧会话的消息可能没有 item_id 标记，更新不到就随它去——数据行已是新值）
  st.updateUserEcho(session.id, itemId, `我的选择：${check.optionLabel}`);
  st.touchSession(session.id);                        // 重做也算一次活动
  return {
    status: 200,
    payload: {
      redone: { itemId, value: check.value, optionLabel: check.optionLabel },
      nowMs: Date.now(),
      session: sessionBrief(session)
    }
  };
}

// 提交一步的核心：真实会话与「手机预览」会话共用同一套状态机（只是存储不同）。
// 返回 { status, error } 或 { status: 200, payload }。
async function applyStep(st, sessionId, body) {
  const session = st.getSession(sessionId);
  if (!session) return { status: 404, error: { error: 'session_not_found', message: '会话不存在' } };
  if (session.status !== 'in_progress') return { status: 409, error: { error: 'session_closed', message: '会话已结束' } };

  // 打分题「单独重做」通道：redo: true 时 body.itemId 指向要改的那道**已答**题目（不是当前题），
  // 走独立分支——不能落进下面的幂等忽略（itemId 必然对不上当前题）与当前题的作答门控
  if (body.redo === true) return applyRedoStep(st, session, body);

  const plan = parseSession(session, st);
  const completedCount = st.countAnswerUnits(session.id);
  const unit = plan.units[completedCount];
  if (!unit) return { status: 409, error: { error: 'session_closed', message: '会话已结束' } };
  const item = unit.item;
  const now = new Date();
  const nowMs = now.getTime();

  // 幂等：客户端报的 itemId 必须就是「当前该答的这一题」。
  // 重复提交 / 迟到的自动提交 / 旧页面缓存如果被静默记到下一题上，表现就是「答完一题跳过了两题」。
  const bodyItemId = String(body.itemId || '').trim();
  if (bodyItemId && bodyItemId !== item.id) {
    return { status: 200, payload: { ...sessionPayload(session, st), ignored: true } };
  }

  const action = computeAction(session, plan, completedCount, nowMs, st);
  if (action.availableAtMs && nowMs < action.availableAtMs) {
    return { status: 400, error: { error: 'too_early', message: '请先完整阅读内容', availableAtMs: action.availableAtMs, nowMs } };
  }
  if (action.minSubmitAtMs && nowMs < action.minSubmitAtMs) {
    return { status: 400, error: { error: 'too_early', message: '还未到可提交时间', availableAtMs: action.minSubmitAtMs, nowMs } };
  }

  // 作答窗口已过（超出宽限）：本题锁死，被试端只能点「重试」开一个新的作答窗口
  if (action.deadlineMs && nowMs > action.deadlineMs + WINDOW_GRACE_MS) {
    st.markTimeout(sessionId, completedCount);             // 记一笔「超时未交」（重试次数另记）
    return {
      status: 409,
      error: { error: 'window_closed', message: '本题作答时间已到，请点击「重试」重新开始本题', retryable: true, nowMs }
    };
  }

  // 到点自动提交：超过最长作答时间后允许文本题为空
  const deadlinePassed = !!(action.deadlineMs && nowMs >= action.deadlineMs);
  const check = validateAnswer(item, body, deadlinePassed);
  if (check.error) {
    // 「需输入指定内容」的断言失败：也记一次「提交前的重试」——数据里能看出被试试了几次才对
    if (check.assertionFailed) st.bumpRetry(sessionId, completedCount, false);
    return {
      status: 400,
      error: { error: 'invalid_answer', message: check.error, assertionFailed: !!check.assertionFailed }
    };
  }

  const elapsedMs = Number.isFinite(Number(body.elapsedMs))
    ? Math.min(Math.max(Math.round(Number(body.elapsedMs)), 0), 24 * 3600 * 1000)
    : null;
  const presentedAt = session.pending_presented_at || new Date(nowMs).toISOString();

  // 回显：消息式题面（文本题 / 全文本题组）原样保留被试输入——他怎么写就怎么记；
  // 其余题型给出「我的选择：…」，卡片式题目的回显会就地留在卡片里。
  let echo;
  if (isMessageStyle(item)) {
    echo = item.type === 'group'
      ? check.group.map((row) => String(row.optionLabel || '').trim()).filter((x) => x).join('\n')
      : String(check.optionLabel || '');
    if (!echo) echo = '（未填写内容）';
  } else if (item.type === 'group') {
    echo = check.group
      .map((row, i) => `${(item.subs[i] || {}).title || `子题 ${i + 1}`}：${row.optionLabel || '（未填写）'}`)
      .join('\n');
  } else if (item.type === 'gate' || item.type === 'debrief') {
    echo = check.optionLabel;
  } else {
    echo = `我的选择：${check.optionLabel}`;
  }
  const userMessage = st.addMessage(sessionId, 'user', echo, null, { itemId: item.id });

  // 落库：题组一次提交写入多行（同一 unit_index，sub_index 区分）
  const rows = item.type === 'group'
    ? check.group.map((row, i) => ({ itemType: (item.subs[i] || {}).type || 'text', subIndex: i, ...row }))
    : [{ itemType: item.type, subIndex: 0, value: check.value, valueText: check.valueText, optionLabel: check.optionLabel }];
  const answeredAt = now.toISOString();
  const retryInfo = st.getRetryInfo(sessionId, completedCount);
  for (const row of rows) {
    st.addResponse({
      retryCount: retryInfo.retries,
      timedOut: retryInfo.timedOut,
      sessionId,
      itemId: item.id,
      itemIndex: unit.index,
      itemType: row.itemType,
      unitIndex: completedCount,
      subIndex: row.subIndex,
      value: row.value,
      valueText: row.valueText,
      optionLabel: row.optionLabel,
      presentedAt,
      answeredAt,
      elapsedMs
    });
  }

  st.touchSession(sessionId);                           // 提交也是一次活动
  const nextCount = completedCount + 1;
  const flush = emitMessagesBetween(session, plan, nextCount, nowMs, st);
  const messages = flush.messages;                      // 消息即时可见（「延迟发出」已移除，visible_at 恒为 null）

  let completed = false;
  if (nextCount >= plan.units.length) {
    st.setPendingPresentedAt(sessionId, null);
    st.finishSession(sessionId);
    completed = true;
  } else {
    st.setPendingPresentedAt(sessionId, presentedAtFor(st.getSession(sessionId), plan, nextCount, nowMs, st));
  }

  const updated = st.getSession(sessionId);
  const nextPlan = parseSession(updated, st);
  // 下一题是刷新点：清空聊天流。本步刚发出的消息也属于「清空之前」，所以不下发。
  const unitCleared = !completed && applyRefreshPoint(updated, nextPlan, nextCount, st);
  const cleared = flush.cleared || unitCleared;
  const nextAction = completed ? null : computeAction(updated, nextPlan, nextCount, Date.now(), st);
  return {
    status: 200,
    payload: {
      userMessage,
      messages: unitCleared ? [] : messages,
      clearStream: cleared,             // 客户端先清屏，再按顺序呈现 messages（消息上的清屏点）
      action: nextAction,
      nowMs: Date.now(),
      session: sessionBrief(updated),
      answeredCount: nextCount,
      totalAnswers: plan.units.length,
      totalQuestions: nextPlan.units.filter((u) => u.qno > 0).length,   // 真实题数（进度条分母）
      currentQno: currentQnoFor(nextPlan, nextAction),                  // 当前「第几题」（进度条 / 题号框）
      timeScale: (st && Number(st.timeScale) > 0) ? Number(st.timeScale) : 1
    }
  };
}

// POST /api/step/retry { sessionId } —— 超时锁死后开一个新的作答窗口：
// 把本题的计时基准重置到现在（强制等待 / 最短提交 / 最长作答都重新开始），并记一次重试。
async function retryCore(st, sessionId) {
  const session = sessionId ? st.getSession(sessionId) : null;
  if (!session) return { status: 404, error: { error: 'session_not_found', message: '会话不存在' } };
  if (session.status !== 'in_progress') return { status: 409, error: { error: 'session_closed', message: '会话已结束' } };
  const plan = parseSession(session, st);
  const completedCount = st.countAnswerUnits(session.id);
  const unit = plan.units[completedCount];
  if (!unit) return { status: 409, error: { error: 'session_closed', message: '会话已结束' } };
  const action = computeAction(session, plan, completedCount, Date.now(), st);
  if (action.deadlineMs && Date.now() <= action.deadlineMs) {
    return { status: 400, error: { error: 'not_expired', message: '本题作答时间还没到，无需重试' } };
  }
  st.bumpRetry(sessionId, completedCount, true);
  st.setPendingPresentedAt(sessionId, new Date().toISOString());   // 新窗口：从现在重新计时
  const updated = st.getSession(sessionId);
  return { status: 200, payload: { ...sessionPayload(updated, st), retried: true, nowMs: Date.now() } };
}

module.exports = {
  WINDOW_GRACE_MS,
  applyRedoStep,
  applyStep,
  retryCore
};
