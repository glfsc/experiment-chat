'use strict';

const crypto = require('node:crypto');
const store = require('../db');
const { sendJson, readJsonBody } = require('./http');
const { requireUser } = require('./auth');
const {
  parseSession,
  emitMessagesBetween,
  presentedAtFor,
  applyRefreshPoint,
  sessionPayload
} = require('./session/plan');
const { applyStep } = require('./session/actions');
const { effLimit } = require('./util');

// ---------------------------------------------------------------- 手机预览（内存会话，不落库）
// 管理端「实时预览 / 从头试填」用真 iframe 加载 /chat?preview=<id>：
// 与真实被试端**同一份前端代码 + 同一套服务端状态机**，只是存储换成内存，所以天然一比一。
class MemoryStore {
  constructor() {
    this.sessions = new Map();
    this.messages = new Map();
    this.responses = new Map();
    this.timeScale = 1;          // 预览倍速：>1 表示门控计时按比例缩短
  }
  resetSession(id) {
    this.messages.set(id, []);
    this.responses.set(id, []);
    const row = this.getSession(id);
    if (row) { row.clear_seq = 0; row.retry_json = '{}'; row.status = 'in_progress'; row.pending_presented_at = null; }
  }
  normalizeItems(raw) { return store.normalizeItems(raw); }
  getSession(id) { return this.sessions.get(id) || null; }
  createSession({ questionnaireId, seq, items, userAgent }) {
    // previewId 是 iframe 的能力凭证：用 CSPRNG，不用 Math.random()
    const id = 'pv' + crypto.randomBytes(6).toString('base64url');
    const now = new Date().toISOString();
    const row = {
      id,
      questionnaire_id: questionnaireId,
      seq: Number(seq) || 1,
      status: 'in_progress',
      started_at: now,
      active_at: now,
      ended_at: null,
      duration_sec: null,
      user_agent: userAgent || 'preview',
      items_json: JSON.stringify(items),
      pending_presented_at: null,
      clear_seq: 0,
      retry_json: '{}'
    };
    this.sessions.set(id, row);
    this.messages.set(id, []);
    this.responses.set(id, []);
    return row;
  }
  touchSession(id) { const s = this.getSession(id); if (s) s.active_at = new Date().toISOString(); }
  setPendingPresentedAt(id, iso) { const s = this.getSession(id); if (s) s.pending_presented_at = iso; }
  finishSession(id) {
    const s = this.getSession(id);
    if (s && s.status === 'in_progress') { s.status = 'completed'; s.ended_at = new Date().toISOString(); s.pending_presented_at = null; }
    return s;
  }
  abandonSession(id) {
    const s = this.getSession(id);
    if (s && s.status === 'in_progress') { s.status = 'abandoned'; s.ended_at = new Date().toISOString(); s.pending_presented_at = null; }
    return s;
  }
  addMessage(sessionId, role, content, visibleAt = null, rhythm = null) {
    const rows = this.messages.get(sessionId) || [];
    const seq = rows.reduce((m, r) => Math.max(m, Number(r.seq) || 0), 0) + 1;
    const row = {
      id: seq,
      role,
      content,
      seq,
      created_at: new Date().toISOString(),
      visible_at: visibleAt,
      thinking: rhythm && rhythm.thinking ? String(rhythm.thinking) : null,
      think_ms: rhythm && rhythm.thinkMs != null ? Number(rhythm.thinkMs) : null,
      type_ms: rhythm && rhythm.typeMs != null ? Number(rhythm.typeMs) : null,
      item_id: rhythm && rhythm.itemId ? String(rhythm.itemId) : null
    };
    rows.push(row);
    this.messages.set(sessionId, rows);
    return row;
  }
  listVisibleMessages(sessionId, now, clearSeq = 0) {
    return (this.messages.get(sessionId) || []).filter(
      (m) => (!m.visible_at || m.visible_at <= now) && (Number(m.seq) || 0) > (Number(clearSeq) || 0)
    );
  }
  maxMessageSeq(sessionId) {
    return (this.messages.get(sessionId) || []).reduce((m, r) => Math.max(m, Number(r.seq) || 0), 0);
  }
  latestMessageAt(sessionId) {
    const rows = this.messages.get(sessionId) || [];
    return rows.length ? rows[rows.length - 1].created_at : null;
  }
  setClearSeq(sessionId, seq) { const s = this.getSession(sessionId); if (s) s.clear_seq = Number(seq) || 0; }
  addResponse(row) {
    const rows = this.responses.get(row.sessionId) || [];
    rows.push({
      ...row,
      presented_at: row.presentedAt || null,
      answered_at: row.answeredAt || null,
      elapsed_ms: row.elapsedMs == null ? null : Number(row.elapsedMs),
      retry_count: Number(row.retryCount) || 0,
      timed_out: row.timedOut ? 1 : 0
    });
    this.responses.set(row.sessionId, rows);
    return rows.length;
  }
  listResponses(sessionId) { return [...(this.responses.get(sessionId) || [])]; }
  countAnswerUnits(sessionId) {
    return new Set((this.responses.get(sessionId) || []).map((r) => Number(r.unitIndex) || 0)).size;
  }
  // 打分题「单独重做」：就地更新那一行的终值（与 db.js 同名方法同语义；内存行是驼峰键）
  redoResponse({ sessionId, itemId, unitIndex, value, valueText, optionLabel }) {
    const rows = this.responses.get(sessionId) || [];
    let changed = 0;
    for (const r of rows) {
      if (String(r.itemId) === String(itemId) && (Number(r.unitIndex) || 0) === (Number(unitIndex) || 0)) {
        r.value = value == null ? null : Number(value);
        r.valueText = String(valueText || '');
        r.optionLabel = String(optionLabel || '');
        changed += 1;
      }
    }
    return changed;
  }
  updateUserEcho(sessionId, itemId, content) {
    const rows = this.messages.get(sessionId) || [];
    let changed = 0;
    for (const m of rows) {
      if (m.role === 'user' && String(m.item_id || '') === String(itemId)) { m.content = String(content); changed += 1; }
    }
    return changed;
  }
  unitFirstResponse(sessionId, unitIndex) {
    return (this.responses.get(sessionId) || []).find((r) => Number(r.unitIndex) === Number(unitIndex)) || null;
  }
  bumpRetry(sessionId, unitIndex, timedOut) {
    const s = this.getSession(sessionId);
    if (!s) return null;
    const map = JSON.parse(s.retry_json || '{}');
    const cur = map[unitIndex] || { retries: 0, timedOut: 0 };
    cur.retries += 1;
    if (timedOut) cur.timedOut = 1;
    map[unitIndex] = cur;
    s.retry_json = JSON.stringify(map);
    s.active_at = new Date().toISOString();
    return cur;
  }
  markTimeout(sessionId, unitIndex) {
    const s = this.getSession(sessionId);
    if (!s) return null;
    const map = JSON.parse(s.retry_json || '{}');
    const cur = map[unitIndex] || { retries: 0, timedOut: 0 };
    cur.timedOut = 1;
    map[unitIndex] = cur;
    s.retry_json = JSON.stringify(map);
    return cur;
  }
  getRetryInfo(sessionId, unitIndex) {
    const s = this.getSession(sessionId);
    if (!s) return { retries: 0, timedOut: 0 };
    const map = JSON.parse(s.retry_json || '{}');
    const cur = map[unitIndex] || {};
    return { retries: Number(cur.retries) || 0, timedOut: Number(cur.timedOut) || 0 };
  }
  getAbandonAfterMinutes() { return 0; }        // 预览不自动作废
}

const PREVIEW_TTL_MS = 30 * 60 * 1000;          // 预览会话「静止 30 分钟」自动销毁（点刷新 / 重试会立即销毁）
const PREVIEW_MAX = 40;
const previewStores = new Map();                // previewId -> { st, at }；Map 顺序 = LRU（最近用过的排最后）
function prunePreview() {
  const now = Date.now();
  for (const [id, rec] of previewStores) {
    if (now - rec.at > PREVIEW_TTL_MS) previewStores.delete(id);
  }
  while (previewStores.size > PREVIEW_MAX) previewStores.delete(previewStores.keys().next().value);
}
// 定期清理：以前只在「新建预览」时顺带扫一遍，管理端一直开着不新建就永远不过期
const previewSweeper = setInterval(prunePreview, 60 * 1000);
if (previewSweeper && typeof previewSweeper.unref === 'function') previewSweeper.unref();
// 取预览记录（含创建时捕获的助手展示配置）；LRU：访问过就挪到末尾，淘汰时不会先淘汰「正在用」的那个
function previewRecord(id) {
  const key = String(id || '').trim();
  const rec = previewStores.get(key);
  if (!rec) return null;
  rec.at = Date.now();
  previewStores.delete(key);
  previewStores.set(key, rec);
  return rec;
}
function previewOf(id) {
  const rec = previewRecord(id);
  return rec ? rec.st : null;
}
function destroyPreview(id) {
  const key = String(id || '').trim();
  return key ? previewStores.delete(key) : false;
}

// 与真实 /api/session 完全同一条路径：发出首屏消息 → 呈现第一题
function seedPreviewSession(st, session) {
  const plan = parseSession(session, st);
  emitMessagesBetween(session, plan, 0, Date.now(), st);
  applyRefreshPoint(session, plan, 0, st);
  st.setPendingPresentedAt(session.id, presentedAtFor(session, plan, 0, Date.now(), st));
}

// POST /api/preview/create { items } —— 用编辑器里（可能还没保存）的题目建一个预览会话
// 兼容旧路径 /api/admin/preview：老版本前端缓存可能还会调用。
async function handleAdminPreviewCreate(req, res) {
  const user = requireUser(req, res);
  if (!user) return;
  const body = await readJsonBody(req);
  const items = store.normalizeItems(Array.isArray(body.items) ? body.items : []);
  if (!items.length) return sendJson(res, 400, { error: 'empty_items', message: '还没有题目，无法预览' });
  prunePreview();
  const st = new MemoryStore();
  const speed0 = Number(body.speed);
  if (Number.isFinite(speed0) && speed0 > 0) st.timeScale = Math.min(60, speed0);
  const session = st.createSession({ questionnaireId: 'preview', seq: 1, items, userAgent: 'preview' });
  seedPreviewSession(st, session);
  // 预览里的助手形象 = 当前登录账号的设置（预览会话本身不带登录态，这里捕获一份随记录下发）
  previewStores.set(session.id, { st, at: Date.now(), assistant: store.getAssistantConfig(user.id) });
  sendJson(res, 200, { previewId: session.id, url: `/chat?preview=${session.id}` });
}

// 预览端点不校验管理端登录：previewId 本身是不可猜的能力凭证（CSPRNG 生成、内存态、30 分钟过期），
// 与真实被试端的 session id 同构——iframe 里的被试端页面本来就没有管理端 token。
async function handlePreviewBootstrap(req, res, url) {
  const rec = previewRecord((url.searchParams.get('preview') || '').trim());
  if (!rec) return sendJson(res, 404, { error: 'preview_expired', message: '预览已过期，请刷新预览' });
  const st = rec.st;
  const assistant = rec.assistant || { avatar: '', name: '' };
  const sid = (url.searchParams.get('session') || '').trim();
  const session = sid ? st.getSession(sid) : null;
  if (!session) {
    return sendJson(res, 200, {
      questionnaireTitle: '预览',
      assistantAvatar: assistant.avatar,
      assistantName: assistant.name,
      session: null, messages: [], replay: [], action: null, nowMs: Date.now()
    });
  }
  sendJson(res, 200, {
    questionnaireTitle: '预览',
    assistantAvatar: assistant.avatar,
    assistantName: assistant.name,
    ...sessionPayload(session, st)
  });
}

async function handlePreviewStep(req, res) {
  const body = await readJsonBody(req);
  const st = previewOf(String(body.previewId || '').trim());
  if (!st) return sendJson(res, 404, { error: 'preview_expired', message: '预览已过期，请刷新预览' });
  const sid = String(body.sessionId || '').trim();
  if (!sid || !st.getSession(sid)) {
    return sendJson(res, 404, { error: 'session_not_found', message: '预览会话不存在，请刷新预览' });
  }
  const out = await applyStep(st, sid, body);
  if (out.error) return sendJson(res, out.status, out.error);
  sendJson(res, 200, out.payload);
}

async function handlePreviewSession(req, res) {
  const body = await readJsonBody(req);
  const rec = previewRecord(String(body.previewId || '').trim());
  if (!rec) return sendJson(res, 404, { error: 'preview_expired', message: '预览已过期，请刷新预览' });
  const st = rec.st;
  const assistant = rec.assistant || { avatar: '', name: '' };
  const created = st.createSession({ questionnaireId: 'preview', seq: 1, items: [], userAgent: 'preview' });
  // 题目来自预览会话创建时写入的 items（这里只重置进度：清空消息与作答）
  const source = [...st.sessions.values()][0];
  if (source && source.items_json && source.items_json !== '[]') {
    created.items_json = source.items_json;
  }
  // 换 id 前先把旧 key 删掉：createSession 已经用旧 id 存过一份，
  // 不删的话 Map 里会有两个键指向同一个会话对象 —— 遍历 sessions 时会被处理两次
  //（切倍速的折算就会折算两遍，倍速被平方）。
  st.sessions.delete(created.id);
  created.id = created.id + '_' + Date.now().toString(36);
  st.sessions.set(created.id, created);
  st.messages.set(created.id, []);
  st.responses.set(created.id, []);
  if (!created.items_json || created.items_json === '[]') {
    return sendJson(res, 400, { error: 'empty_items', message: '预览题目为空，请刷新预览' });
  }
  seedPreviewSession(st, created);
  sendJson(res, 200, {
    questionnaireTitle: '预览',
    assistantAvatar: assistant.avatar,
    assistantName: assistant.name,
    ...sessionPayload(created, st)
  });
}

// 预览进度跳转：把目标题之前的作答单元合成「预览已作答」，直接停在那一题。
// 口径 = **题号 qno**（与卡面「第 N 题」一致），不是作答单元序号——
// 知情同意 / 确认页 / 结束说明不占题号，用单元序号跳会整体偏一位（用户报的「跳第 5 题落到第 4 题」）。
// 合成顺序必须与真实推进一致：开场消息 →（每单元：清屏点 → 回显 → 作答行 → 该单元之后的消息）→ 目标单元的清屏点。
function seekPreview(st, sessionId, qno, fallbackIndex) {
  const session = st.getSession(sessionId);
  if (!session) return null;
  const plan = parseSession(session, st);
  if (!plan.units.length) return null;
  const want = Math.round(Number(qno) || 0);
  let target;
  if (want > 0) {
    target = plan.units.findIndex((u) => u.qno === want);
    if (target < 0) target = plan.units.findIndex((u) => u.qno > want);      // 超出题数 → 停在最后一题之后
    if (target < 0) target = plan.units.length - 1;
  } else {
    target = Math.max(0, Math.min(Math.round(Number(fallbackIndex) || 0), plan.units.length - 1));
  }
  st.resetSession(sessionId);
  const nowMs = Date.now();
  emitMessagesBetween(session, plan, 0, nowMs, st);                          // 开场消息（重置后必须补回来）
  for (let i = 0; i < target; i += 1) {
    const unit = plan.units[i];
    // 该单元是清屏点：先记清屏点，再写回显 —— 顺序反了会导致「清屏前的已答卡片」留在回放里
    applyRefreshPoint(session, plan, i, st);
    st.addMessage(sessionId, 'user', previewDummyEcho(unit.item), null, { itemId: unit.item.id });
    for (const row of previewDummyRows(unit.item)) {
      st.addResponse({
        sessionId,
        itemId: unit.item.id,
        itemIndex: unit.index,
        itemType: row.itemType,
        unitIndex: i,
        subIndex: row.subIndex,
        value: row.value,
        valueText: row.valueText,
        optionLabel: row.optionLabel,
        presentedAt: new Date(nowMs - 1000).toISOString(),
        answeredAt: new Date(nowMs).toISOString(),
        elapsedMs: 1000,
        retryCount: 0,
        timedOut: 0
      });
    }
    emitMessagesBetween(session, plan, i + 1, nowMs, st);                    // 该单元之后的、下一单元之前的消息
  }
  const cleared = applyRefreshPoint(session, plan, target, st);              // 目标题自身是清屏点：先清屏再呈现
  st.setPendingPresentedAt(sessionId, new Date(nowMs).toISOString());
  return { ...sessionPayload(st.getSession(sessionId), st), clearStream: cleared, seekedTo: qnoOf(plan, target) };
}

// 某个单元下标对应的题号（0 = 该单元不占题号）
function qnoOf(plan, index) {
  const unit = plan.units[index];
  return unit ? unit.qno || 0 : 0;
}

// 跳转用的合成作答：只为让「已答部分」在回放里显示得像真的，不参与任何分析
function previewDummyRows(item) {
  const one = (sub, i) => ({
    itemType: sub.type,
    subIndex: i,
    value: sub.type === 'rating' || sub.type === 'single' ? 3 : null,
    valueText: sub.type === 'text' ? JSON.stringify({ text: '（预览已作答）' }) : '',
    optionLabel: '（预览已作答）'
  });
  if (item.type === 'group') return (item.subs || []).map((sub, i) => one(sub, i));
  return [one(item, 0)];
}

function previewDummyEcho(item) {
  if (item.type === 'gate') return '已同意并开始（预览）';
  if (item.type === 'confirm') return '已阅读并继续（预览）';
  if (item.type === 'debrief') return '已阅读结束说明（预览）';
  return '（预览已作答）';
}

// POST /api/preview/seek { previewId, sessionId, qno }（qno = 题号，与卡面一致；兼容旧的 index 单元序号）
async function handlePreviewSeek(req, res) {
  const body = await readJsonBody(req);
  const st = previewOf(String(body.previewId || '').trim());
  if (!st) return sendJson(res, 404, { error: 'preview_expired', message: '预览已过期，请刷新预览' });
  const payload = seekPreview(st, String(body.sessionId || '').trim(), body.qno, body.index);
  if (!payload) return sendJson(res, 404, { error: 'session_not_found', message: '预览会话不存在，请刷新预览' });
  sendJson(res, 200, payload);
}

// POST /api/preview/seek-unit { previewId, sessionId, index } —— 按作答单元序号跳（自检用）
async function handlePreviewSeekUnit(req, res) {
  const body = await readJsonBody(req);
  const st = previewOf(String(body.previewId || '').trim());
  if (!st) return sendJson(res, 404, { error: 'preview_expired', message: '预览已过期，请刷新预览' });
  const payload = seekPreview(st, String(body.sessionId || '').trim(), 0, body.index);
  if (!payload) return sendJson(res, 404, { error: 'session_not_found', message: '预览会话不存在，请刷新预览' });
  sendJson(res, 200, payload);
}

// POST /api/preview/speed { previewId, speed } —— 改倍速不重建会话（已填的作答保留）
// 关键：把**所有已经写下的时间基准**按新旧倍速折算，这样在等待 / 作答过程中切速度都会立刻按新倍速走：
//   · pending_presented_at → 「作答前强制等待」的剩余时间
//   · responses.presented_at → 「最短提交 / 最长作答」的窗口起点（windowStartFor 读它）
// 不折算的话，最短提交/最长作答窗口不会跟着倍速变，而客户端倒计时会按新倍速显示，
// 就会出现「设了 50 秒、切到 10× 反而显示 500 秒」。（预览是内存会话，不写库，可以随便改时间戳。）
async function handlePreviewSpeed(req, res) {
  const body = await readJsonBody(req);
  const st = previewOf(String(body.previewId || '').trim());
  if (!st) return sendJson(res, 404, { error: 'preview_expired', message: '预览已过期，请刷新预览' });
  const speed = Number(body.speed);
  const next = Number.isFinite(speed) && speed > 0 ? Math.min(60, speed) : 1;
  const prev = Number(st.timeScale) > 0 ? Number(st.timeScale) : 1;
  const nowMs = Date.now();
  if (next !== prev) {
    // 折算规则：已过时间按 prev/next 比例缩放（保留「已过多少比例」），
    // 但**已经过点的窗口不许复活** —— 按旧倍速算已经走完的等待/作答窗口，
    // 折算后必须仍然算走完（否则切到更慢的倍速时，早就结束的强制等待又要求重新等一遍）。
    const scalePoint = (t, oldTotalMs, newTotalMs) => {
      const scaled = nowMs - (nowMs - t) * (prev / next);
      const passed = oldTotalMs > 0 && t + oldTotalMs <= nowMs;
      return passed ? Math.min(scaled, nowMs - newTotalMs - 1) : scaled;
    };
    const seenSessions = new Set();       // 去重：Map 里可能有多个键指向同一个会话对象（历史遗留），只折一次
    for (const session of st.sessions.values()) {
      if (seenSessions.has(session)) continue;
      seenSessions.add(session);
      if (!session.pending_presented_at) continue;
      const t = Date.parse(session.pending_presented_at);
      if (!Number.isFinite(t)) continue;
      const plan = parseSession(session, st);
      const unit = plan.units[st.countAnswerUnits(session.id)];
      const waitSec = unit ? effLimit(unit.item, 'wait') : 0;
      session.pending_presented_at = new Date(scalePoint(t, (waitSec / prev) * 1000, (waitSec / next) * 1000)).toISOString();
    }
    for (const [sid, rows] of st.responses) {
      const session = st.getSession(sid);
      if (!session) continue;
      const byItem = new Map(parseSession(session, st).units.map((u) => [u.item.id, u.item]));
      for (const row of rows) {
        const iso = row.presented_at || row.presentedAt;
        const t = Date.parse(iso);
        if (!Number.isFinite(t)) continue;
        const item = byItem.get(row.itemId || row.item_id);
        const winSec = item ? Math.max(effLimit(item, 'minSubmit'), effLimit(item, 'maxAnswer')) : 0;
        const fixed = new Date(scalePoint(t, (winSec / prev) * 1000, (winSec / next) * 1000)).toISOString();
        row.presented_at = fixed;
        if (row.presentedAt != null) row.presentedAt = fixed;
      }
    }
  }
  st.timeScale = next;
  sendJson(res, 200, { ok: true, speed: st.timeScale });
}

// POST /api/preview/destroy { previewId } —— 立即销毁预览会话（点「刷新预览」或离开编辑页时调用，不等 30 分钟 TTL）
async function handlePreviewDestroy(req, res) {
  const body = await readJsonBody(req);
  const destroyed = destroyPreview(body.previewId);
  sendJson(res, 200, { ok: true, destroyed });
}

async function handlePreviewFinish(req, res) {
  const body = await readJsonBody(req);
  const st = previewOf(String(body.previewId || '').trim());
  if (!st) return sendJson(res, 404, { error: 'preview_expired', message: '预览已过期，请刷新预览' });
  const session = body.abandon ? st.abandonSession(String(body.sessionId || '').trim()) : st.finishSession(String(body.sessionId || '').trim());
  if (!session) return sendJson(res, 404, { error: 'session_not_found', message: '会话不存在' });
  sendJson(res, 200, { session: { id: session.id, status: session.status, duration_sec: session.duration_sec } });
}

module.exports = {
  handleAdminPreviewCreate,
  handlePreviewBootstrap,
  handlePreviewStep,
  handlePreviewSession,
  handlePreviewSeek,
  handlePreviewSeekUnit,
  handlePreviewSpeed,
  handlePreviewDestroy,
  handlePreviewFinish
};
