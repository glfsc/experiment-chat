'use strict';

const store = require('../../db');
const { optionLetter, effLimit } = require('../util');

// ---------------------------------------------------------------- 状态机
// 作答单元 = 除 message 外的所有题目；message 在推进时自动作为消息发出。
// 每个单元带 qno：只有「需要被试作答的题目」才编号（知情同意/确认页/结束说明不占题号）。
const planCache = new Map();
const PLAN_CACHE_MAX = 2000;

function parseSession(session, st = store) {
  const hit = planCache.get(session.id);
  if (hit && hit.pendingAt === session.pending_presented_at && hit.itemsJson === session.items_json) return hit;
  const items = st.normalizeItems(JSON.parse(session.items_json || '[]'));
  const units = [];
  let qno = 0;
  items.forEach((item, index) => {
    if (item.type === 'message') return;
    const isQuestion = store.QUESTION_TYPES.includes(item.type);
    if (isQuestion) qno += 1;
    units.push({ item, index, qno: isQuestion ? qno : 0 });
  });
  const plan = { items, units, pendingAt: session.pending_presented_at, itemsJson: session.items_json };
  if (planCache.size >= PLAN_CACHE_MAX) {
    const oldest = planCache.keys().next().value;
    if (oldest !== undefined) planCache.delete(oldest);
  }
  planCache.set(session.id, plan);
  return plan;
}

// 推进：发出 (afterAnswerIndex-1, afterAnswerIndex) 之间的消息题目。
// 消息上也能配「呈现前清空」：遇到清屏点就把清屏点记到该消息之前，本批只下发达清屏点之后的消息
//（清空之前的内容仍完整留在库里，只是不再下发——刷新页面也拿不到）。
// 返回 { messages, cleared }：cleared = 本批跨过了清屏点，客户端要先清屏再呈现。
function emitMessagesBetween(session, plan, afterAnswerIndex, nowMs, st = store) {
  const units = plan.units;
  const fromItem = afterAnswerIndex > 0 ? units[afterAnswerIndex - 1].index : -1;
  const toItem = afterAnswerIndex < units.length ? units[afterAnswerIndex].index : plan.items.length;
  const emitted = [];
  let cut = 0;                                              // 只下发 emitted.slice(cut)
  let cleared = false;
  for (let i = fromItem + 1; i < toItem; i += 1) {
    const item = plan.items[i];
    if (item.type !== 'message') continue;
    if (!String(item.text || '').trim()) continue;          // 留空的消息自动跳过（也不做清屏点）
    if (effLimit(item, 'refresh') === 1) {
      const mark = st.maxMessageSeq(session.id);
      const cur = Number((st.getSession(session.id) || {}).clear_seq) || 0;
      if (mark > cur) st.setClearSeq(session.id, mark);
      cut = emitted.length;
      cleared = true;
    }
    // 呈现节奏：题目配了就用，否则用内置默认；存到消息上，恢复会话时节奏不丢
    // thinking：思考过程一并落库，保证刷新恢复后回看的是同一段内容
    // 「思考中」提示也是一个参数：没写思考稿、也没显式配思考时长 → 不显示（不凭空冒提示）
    const thinking = item.thinking || null;
    const explicitThink = item.limits && item.limits.thinkMs != null;
    const rhythm = {
      thinkMs: (thinking || explicitThink) ? effLimit(item, 'thinkMs') : 0,
      typeMs: effLimit(item, 'typeMs'),
      thinking
    };
    emitted.push(st.addMessage(session.id, 'assistant', item.html || item.text, null, { ...rhythm, itemId: item.id }));
  }
  return { messages: emitted.slice(cut), cleared };
}

// 作答单元的呈现时刻 = max(上一条作答完成时间, 最近一条消息的可见时刻, 现在)
function presentedAtFor(session, plan, completedCount, nowMs, st = store) {
  const prev = completedCount > 0 ? st.unitFirstResponse(session.id, completedCount - 1) : null;
  const prevMs = prev && prev.answered_at ? Date.parse(prev.answered_at) : Date.parse(session.started_at);
  const msgAt = st.latestMessageAt(session.id);
  const msgMs = msgAt ? Date.parse(msgAt) : 0;
  let ms = Math.max(
    Number.isFinite(prevMs) ? prevMs : nowMs,
    Number.isFinite(msgMs) ? msgMs : 0,
    nowMs
  );
  if (!Number.isFinite(ms)) ms = nowMs;
  return new Date(ms).toISOString();
}

// 共用窗口：相邻且「最短提交 / 最长作答」设置相同的作答题目共用一个起点
function windowStartFor(session, plan, completedCount, presentedIso, st = store) {
  const units = plan.units;
  const sig = (item) => `${item.limits.minSubmit ?? ''}|${item.limits.maxAnswer ?? ''}`;
  const curSig = sig(units[completedCount].item);
  let runStart = completedCount;
  while (runStart > 0 && sig(units[runStart - 1].item) === curSig) runStart -= 1;
  if (runStart < completedCount) {
    const first = st.unitFirstResponse(session.id, runStart);
    if (first && first.presented_at) return { startMs: Date.parse(first.presented_at), shared: true };
  }
  return { startMs: Date.parse(presentedIso), shared: runStart < completedCount };
}

// 当前待作答单元 → 操作负载（不下发正确答案，避免泄露）
function computeAction(session, plan, completedCount, nowMs, st = store) {
  const units = plan.units;
  if (completedCount >= units.length) return null;
  const unit = units[completedCount];
  const item = unit.item;
  const presentedIso = session.pending_presented_at || presentedAtFor(session, plan, completedCount, nowMs, st);
  const presentedMs = Date.parse(presentedIso);

  // 预览倍速：只缩放「门控时长」（强制等待 / 最短提交 / 最长作答）；真实会话 timeScale = 1，不受影响
  const timeScale = (st && Number(st.timeScale) > 0) ? Number(st.timeScale) : 1;
  const waitSec = effLimit(item, 'wait');
  const minSubmitSec = effLimit(item, 'minSubmit');
  const maxAnswerSec = effLimit(item, 'maxAnswer');
  const wait = waitSec / timeScale;
  const minSubmit = minSubmitSec / timeScale;
  const maxAnswer = maxAnswerSec / timeScale;
  let minSubmitAtMs = 0;
  let deadlineMs = 0;
  let sharedWindow = false;
  if (minSubmit > 0 || maxAnswer > 0) {
    const win = windowStartFor(session, plan, completedCount, presentedIso, st);
    sharedWindow = win.shared;
    if (minSubmit > 0) minSubmitAtMs = win.startMs + minSubmit * 1000;
    if (maxAnswer > 0) deadlineMs = win.startMs + maxAnswer * 1000;
  }

  const base = {
    itemId: item.id,
    itemIndex: unit.index,
    qno: unit.qno || 0,                 // 题号：只数「需要被试作答的题目」（0 = 不显示题号）
    type: item.type,
    title: item.title,
    html: item.html || '',              // 被试可见正文（清洗后的富文本）
    availableAtMs: wait > 0 ? presentedMs + wait * 1000 : 0,
    minSubmitAtMs,
    deadlineMs,
    sharedWindow,
    nowMs,
    // 预览倍速相关：真实门控时间戳是缩放后的，客户端倒计时按「设定秒数 × 倍速」显示，
    // 这样作者看到的是「50 秒从 50 开始快速跳到 0」，而不是莫名其妙变成 5 秒。
    timeScale,
    waitSec,
    minSubmitSec,
    maxAnswerSec
  };

  return { ...base, ...itemDescriptor(item) };
}

// 题型描述（不含计时与状态）：呈现当前题与回放已答题共用，保证两边渲染一致
function itemDescriptor(item) {
  if (item.type === 'rating') {
    const min = Number(item.min) || 1;
    const max = Number(item.max) || 5;
    return {
      min,
      max,
      anchor: item.anchor || '',
      // 允许重做：被试端据此把已答卡片上的按钮渲染成「重做」（未配置时回落默认值 = 开）
      allowRedo: effLimit(item, 'redo') === 1 ? 1 : 0,
      options: Array.from({ length: max - min + 1 }, (_, i) => ({ value: min + i, label: String(min + i) }))
    };
  }
  if (item.type === 'single' || item.type === 'multi') {
    return { options: (item.options || []).map((t, i) => ({ value: i + 1, label: `${optionLetter(i)}．${t}` })) };
  }
  if (item.type === 'rank') {
    return { options: (item.options || []).map((t, i) => ({ value: i + 1, label: t })) };
  }
  if (item.type === 'text') {
    return {
      required: item.required !== false,
      rows: Number(item.rows) || 1,
      maxLen: Number(item.maxLen) || 0,
      placeholder: item.placeholder || '',
      // 形态：match = 需输入指定内容（被试发送前由服务端断言）。
      // 标准答案与提示文案都不下发给被试端——断言结果由 /api/step 的报错带回。
      variant: item.variant === 'match' ? 'match' : 'free'
    };
  }
  if (item.type === 'group') {
    // 题组：一次呈现多道子题、一次提交
    return {
      layout: item.layout === 'row' ? 'row' : 'column',
      subs: (item.subs || []).map((sub, i) => ({
        index: i,
        type: sub.type,
        title: sub.title,
        required: sub.required !== false,
        rows: Number(sub.rows) || 1,
        maxLen: Number(sub.maxLen) || 0,
        placeholder: sub.placeholder || '',
        min: Number(sub.min) || 1,
        max: Number(sub.max) || 5,
        anchor: sub.anchor || '',
        options: (sub.options || []).map((t, k) => ({ value: k + 1, label: `${optionLetter(k)}．${t}` }))
      }))
    };
  }
  if (item.type === 'gate') {
    return {
      check: item.check || '',
      button: item.button || '开始实验',
      // 含编号形态：页面上多一个编号输入框，填写后才能进入
      variant: item.variant === 'id' ? 'id' : 'plain',
      idLabel: item.idLabel || '被试编号',
      idPlaceholder: item.idPlaceholder || '请填写编号'
    };
  }
  if (item.type === 'confirm') {
    // 阅读确认页：先停留 N 秒（item.limits.wait）才能点继续
    return { button: item.button || '我已阅读完' };
  }
  if (item.type === 'debrief') return { button: '我已阅读' };
  return {};
}

// 消息式题面：文本题、以及「子题全是文本」的题组——像一条 AI 消息那样提问，被试在底部输入框作答。
// 其余题型仍是题卡（打分 / 选择 / 排序 / 混合题组）。
function isMessageStyle(item) {
  if (!item) return false;
  if (item.type === 'text') return true;
  if (item.type === 'group') {
    const subs = item.subs || [];
    return subs.length > 0 && subs.every((sub) => sub.type === 'text');
  }
  return false;
}

function sessionBrief(session) {
  return {
    id: session.id,
    uid: session.seq == null ? '' : String(session.seq),
    seq: session.seq == null ? null : Number(session.seq),
    status: session.status
  };
}

// 刷新点：呈现该题之前把聊天流整体清空。
// 清屏点记在会话上（而不是只清前端 DOM）——否则被试一刷新，服务端会把
// 清空之前的消息全部重新下发，防线等于没有。返回是否发生了清屏。
function applyRefreshPoint(session, plan, completedCount, st = store) {
  const unit = plan.units[completedCount];
  if (!unit || effLimit(unit.item, 'refresh') !== 1) return false;
  const mark = st.maxMessageSeq(session.id);
  if (mark <= (Number(session.clear_seq) || 0)) return false;   // 已经清过，不重复记
  st.setClearSeq(session.id, mark);
  return true;
}

// 回放时间线：把「已呈现过的内容」按顺序摊平，供被试刷新 / 退出重进时重建聊天流。
// 消息（含思考节奏）与被试回显都在 messages 表里按 seq 排序；卡片式题目的回显在这里
// 还原成一张「已作答卡片」——呈现与回放用同一份题型描述，两边渲染一致。
function buildReplay(session, plan, st = store) {
  const clearSeq = Number(session.clear_seq) || 0;
  const msgs = st.listVisibleMessages(session.id, new Date().toISOString(), clearSeq);
  const unitByItemId = new Map(plan.units.map((u) => [u.item.id, u]));
  const replay = [];
  for (const m of msgs) {
    const unit = m.item_id ? unitByItemId.get(m.item_id) : null;
    if (m.role === 'assistant') {
      replay.push({
        kind: 'message',
        content: m.content,
        thinking: m.thinking || '',
        thinkMs: m.think_ms,
        typeMs: m.type_ms
      });
      continue;
    }
    // 页面类题目（知情同意 / 确认页 / 结束说明）不占聊天流：它们的回显只留在数据里
    if (unit && ['gate', 'confirm', 'debrief'].includes(unit.item.type)) continue;
    if (unit && isMessageStyle(unit.item)) {
      replay.push({ kind: 'user', itemId: unit.item.id, qno: unit.qno || 0, content: m.content });
    } else if (unit) {
      replay.push({
        kind: 'card',
        itemId: unit.item.id,
        qno: unit.qno || 0,
        echo: m.content,
        item: {
          itemId: unit.item.id,
          qno: unit.qno || 0,
          type: unit.item.type,
          title: unit.item.title,
          html: unit.item.html || '',
          ...itemDescriptor(unit.item)
        }
      });
    } else {
      replay.push({ kind: 'user', content: m.content });   // 兜底：归属不明的回显
    }
  }
  return replay;
}

// 进度以「题号」报（卡面就是题号）：停在知情同意 / 确认页这类不占题号的单元时，报它之后的第一个题号。
// 提交（/api/step）与整包负载（sessionPayload）共用同一份口径——少了它，预览的进度条 / 题号框
// 每答完一题就慢一拍（屏幕已到下一题，进度还停在上一步的题号上）。
function currentQnoFor(plan, action) {
  const totalQuestions = plan.units.filter((u) => u.qno > 0).length;
  if (!action) return totalQuestions;
  const idx = plan.units.findIndex((u) => u.item.id === action.itemId);
  for (let i = Math.max(0, idx); i < plan.units.length; i += 1) {
    if (plan.units[i].qno > 0) return plan.units[i].qno;
  }
  return totalQuestions;
}

function sessionPayload(session, st = store) {
  const plan = parseSession(session, st);
  const completedCount = st.countAnswerUnits(session.id);
  const nowIsoStr = new Date().toISOString();
  const clearSeq = Number(session.clear_seq) || 0;
  const action = session.status === 'completed' ? null : computeAction(session, plan, completedCount, Date.now(), st);
  const totalQuestions = plan.units.filter((u) => u.qno > 0).length;
  return {
    session: sessionBrief(session),
    messages: st.listVisibleMessages(session.id, nowIsoStr, clearSeq),
    replay: buildReplay(session, plan, st),             // 重建聊天流（刷新 / 退出重进）
    action,
    nowMs: Date.now(),
    totalItems: plan.items.length,
    totalAnswers: plan.units.length,                    // 作答单元数（含知情同意 / 确认页 / 结束说明）
    totalQuestions,                                     // 真实题数（进度条分母按这个来）
    currentQno: currentQnoFor(plan, action),            // 当前「第几题」（progress 用）
    answeredCount: completedCount,
    timeScale: (st && Number(st.timeScale) > 0) ? Number(st.timeScale) : 1
  };
}

module.exports = {
  parseSession,
  emitMessagesBetween,
  presentedAtFor,
  windowStartFor,
  computeAction,
  itemDescriptor,
  isMessageStyle,
  sessionBrief,
  applyRefreshPoint,
  buildReplay,
  currentQnoFor,
  sessionPayload
};
