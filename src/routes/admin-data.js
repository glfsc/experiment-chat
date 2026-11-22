'use strict';

const store = require('../../db');
const { buildXlsx } = require('../../xlsx');
const { sendJson, readJsonBody } = require('../http');
const { requireUser, canAccess } = require('../auth');
const {
  answerAtoms,
  itemLabelMap,
  scaleColumns,
  textColumns,
  choiceColumns,
  unitQnosOf,
  answeredQuestionsOf
} = require('../report');
const { textOf, fmtLocal, STATUS_LABELS } = require('../util');

// GET /api/admin/questionnaire/sessions?id=
function handleAdminQuestionnaireSessions(req, res, url) {
  const user = requireUser(req, res);
  if (!user) return;
  const id = (url.searchParams.get('id') || '').trim();
  const questionnaire = store.getQuestionnaire(id);
  if (!questionnaire || !canAccess(user, questionnaire)) {
    return sendJson(res, 404, { error: 'questionnaire_not_found', message: '问卷不存在' });
  }
  const payload = store.getQuestionnairePayload(id);
  const unitQnos = unitQnosOf(payload.items);
  const totalQuestions = unitQnos.filter((q) => q > 0).length;

  // 会话进度按「题号」报（完成会话 = 24/24 题）；answerCount 保留为作答行数（旧口径，自检在用）
  const acc = new Map();      // session_id -> { rows, units: Set }
  for (const r of store.listResponseRows(id)) {
    let a = acc.get(r.session_id);
    if (!a) { a = { rows: 0, units: new Set() }; acc.set(r.session_id, a); }
    a.rows += 1;
    a.units.add(Number(r.unit_index) || 0);
  }

  const sessions = store.listSessionSummaries(id).map((s) => {
    const a = acc.get(s.id) || { rows: 0, units: new Set() };
    let answered = 0;
    for (const ui of a.units) if ((unitQnos[ui] || 0) > 0) answered += 1;
    return {
      id: s.id,
      seq: s.seq == null ? null : Number(s.seq),
      status: s.status,
      statusLabel: STATUS_LABELS[s.status] || s.status,
      startedAt: s.started_at,
      endedAt: s.ended_at,
      durationSec: s.duration_sec == null ? null : Number(s.duration_sec),
      answerCount: a.rows,          // 作答行数（题组按子题分行；旧口径，保持不变）
      answeredQuestions: answered   // 已答完的题数（题号口径，界面进度列用）
    };
  });

  sendJson(res, 200, {
    questionnaire: payload,
    sessions,
    sessionCount: sessions.length,
    totalQuestions
  });
}

// POST /api/admin/questionnaire/sessions/delete { id, ids }
async function handleAdminSessionsDelete(req, res, url) {
  const user = requireUser(req, res);
  if (!user) return;
  const body = await readJsonBody(req);
  const id = String(body.id || '').trim();
  const questionnaire = store.getQuestionnaire(id);
  if (!questionnaire || !canAccess(user, questionnaire)) {
    return sendJson(res, 404, { error: 'questionnaire_not_found', message: '问卷不存在' });
  }
  const result = store.deleteSessions(id, body.ids);
  sendJson(res, 200, { ok: true, deleted: result.deleted });
}

// GET /api/admin/questionnaire/session?id=&sid=
function handleAdminQuestionnaireSession(req, res, url) {
  const user = requireUser(req, res);
  if (!user) return;
  const id = (url.searchParams.get('id') || '').trim();
  const sid = (url.searchParams.get('sid') || '').trim();
  const questionnaire = store.getQuestionnaire(id);
  if (!questionnaire || !canAccess(user, questionnaire)) {
    return sendJson(res, 404, { error: 'questionnaire_not_found', message: '问卷不存在' });
  }
  const session = store.getSession(sid);
  if (!session || session.questionnaire_id !== id) return sendJson(res, 404, { error: 'session_not_found', message: '会话不存在' });

  const items = store.normalizeItems(JSON.parse(session.items_json || '[]'));
  const atoms = answerAtoms(items);
  const atomByKey = new Map(atoms.map((a) => [a.key, a]));
  const labels = itemLabelMap(items);
  const unitQnos = unitQnosOf(items);
  const responseRows = store.listResponses(session.id);

  sendJson(res, 200, {
    questionnaire: store.getQuestionnairePayload(id, { withItems: false }),
    session: {
      id: session.id,
      seq: session.seq == null ? null : Number(session.seq),
      status: session.status,
      statusLabel: STATUS_LABELS[session.status] || session.status,
      startedAt: session.started_at,
      endedAt: session.ended_at,
      durationSec: session.duration_sec == null ? null : Number(session.duration_sec),
      userAgent: session.user_agent,
      totalAnswers: items.filter((it) => it.type !== 'message').length,
      totalQuestions: unitQnos.filter((q) => q > 0).length,
      answeredQuestions: answeredQuestionsOf(responseRows, unitQnos)
    },
    messages: store.listMessages(session.id),
    responses: responseRows.map((r) => {
      const atom = atomByKey.get(`${r.item_id}#${r.sub_index || 0}`);
      const correct = atom && atom.type === 'single' ? Number(atom.sub ? atom.sub.correct : atom.item.correct) || 0 : 0;
      return {
        id: r.id,
        itemId: r.item_id,
        itemType: r.item_type,
        itemTypeLabel: store.ITEM_TYPE_LABELS[r.item_type] || r.item_type,
        itemLabel: labels.get(`${r.item_id}#${r.sub_index || 0}`) || r.item_id,
        value: r.value,
        text: r.item_type === 'text' ? textOf(r.value_text) : '',
        optionLabel: r.option_label,
        isCorrect: correct ? (Number(r.value) === correct ? '正确' : '错误') : '',
        presentedAt: r.presented_at,
        answeredAt: r.answered_at,
        elapsedMs: r.elapsed_ms,
        retryCount: Number(r.retry_count) || 0,     // 提交前的重试次数（超时后点「重试」+「需输入指定内容」的断言失败）
        timedOut: Boolean(r.timed_out)              // 是否曾到点未交
      };
    })
  });
}

// GET /api/admin/questionnaire/export.xlsx?id=
function handleAdminQuestionnaireExport(req, res, url) {
  const user = requireUser(req, res);
  if (!user) return;
  const id = (url.searchParams.get('id') || '').trim();
  const questionnaire = store.getQuestionnaire(id);
  if (!questionnaire || !canAccess(user, questionnaire)) {
    return sendJson(res, 404, { error: 'questionnaire_not_found', message: '问卷不存在' });
  }
  // 默认排除「已作废」的会话（重做 / 太久未提交被系统作废）；需要时带 includeAbandoned=1
  const includeAbandoned = url.searchParams.get('includeAbandoned') === '1';
  const payload = store.getQuestionnairePayload(id);

  const items = payload.items;
  const labels = itemLabelMap(items);

  const ratingGroups = scaleColumns(items);
  const textItems = textColumns(items);
  const choiceItems = choiceColumns(items);

  // ---- sheet 1：汇总（一被试一行）· 统计用精简表
  // 一个变量一列、列名取短名、一被试一行——打开就能直接看、直接进统计软件。
  //   · 量表：多题量表写成「量表名 1…5」（去掉「N · 」小节前缀与「第 N 题」）；
  //     单题量表（如两道「反馈准确性」）用题目自带的导出名 colLabel，没配就退回原标签
  //   · 作品：两次创作各一列；两道固定口令的阅读确认页不算作品，不进这张表
  //   · 选择题：答案一列 + 对错一列
  // 状态 / 开始结束时间 / 时长 / 各题作答时间与耗时 / 量表均分不进这张表，要看去「作答明细」。
  const summaries = store.listQuestionnaireSummaryRows(id, { includeAbandoned });
  const S_FONT = { font: 'Times New Roman', size: 11 };
  const S_CELL = { ...S_FONT, align: 'center', valign: 'center' };   // 分值 / 选项 / 编号：居中
  const S_WORK = { ...S_FONT, valign: 'center' };                     // 作品原文：左对齐
  // 汇总表的列名一律取短名：去掉「N · 」小节前缀（「6 · 注意力检测」→「注意力检测」），
  // 「第 N 题」收成序号。题号口径与「短量表名 + 序号」一致，列名不再随 id 前缀变样。
  const stripSection = (name) => String(name || '')
    .replace(/^\s*\d+\s*·\s*/, '')
    .replace(/\s*第\s*(\d+)\s*题\s*$/, ' $1')
    .trim();
  const workItems = textItems.filter((c) => (c.sub ? c.sub.variant : c.item.variant) !== 'match');
  // 列宽口径（与研究者确认过的统计表一致）：编号 10 / 14，量表列 20，作品列 30，选择题 26，对错列 16
  const W_SCALE = 20;
  const summaryColumns = [
    { title: '被试编号', width: 10, style: S_CELL },
    { title: '被试自填编号', width: 14, style: S_CELL },   // 知情同意页「含编号」形态里被试填的；普通形态为空
    ...ratingGroups.flatMap((g) => {
      if (g.atoms.length === 1) {
        return [{ title: g.atoms[0].colLabel || stripSection(g.atoms[0].label), width: W_SCALE, style: S_CELL }];
      }
      const base = stripSection(g.name) || g.name;
      return g.atoms.map((a, i) => ({ title: `${base} ${i + 1}`, width: W_SCALE, style: S_CELL }));
    }),
    ...workItems.map((c) => ({ title: c.colLabel || stripSection(c.label), width: 30, style: S_WORK })),
    ...choiceItems.flatMap((c) => {
      const label = c.colLabel || stripSection(c.label);
      const cols = [{ title: label, width: 26, style: S_CELL }];
      const correct = c.sub ? c.sub.correct : c.item.correct;
      if (c.type === 'single' && Number(correct)) {
        cols.push({ title: `${label}·是否正确`, width: 16, style: S_CELL });
      }
      return cols;
    })
  ];
  const sec = (ms) => (ms == null ? '' : Math.round(Number(ms) / 100) / 10);
  const summaryRows = summaries.map((s) => {
    const out = [s.seq == null ? '' : s.seq, s.enteredCode || ''];
    for (const g of ratingGroups) {
      for (const a of g.atoms) {
        const u = s.units.get(a.key);
        out.push(u && u.value != null ? Number(u.value) : '');
      }
    }
    for (const c of workItems) {
      const u = s.units.get(c.key);
      out.push(u ? u.text : '');
    }
    for (const col of choiceItems) {
      const u = s.units.get(col.key);
      const correct = col.sub ? col.sub.correct : col.item.correct;
      out.push(u ? u.label : '');
      if (col.type === 'single' && Number(correct)) {
        out.push(u ? (Number(u.value) === Number(correct) ? '正确' : '错误') : '');
      }
    }
    return out;
  });

  // ---- sheet 2：逐题作答（一被试一行，纯答案）
  // 每题一列，只写答案本身：不打对错、不带呈现/作答时间与耗时。
  // 只算「题目」（打分/单选/多选/文本/排序）；知情同意页、确认页、结束说明是页面，不占列。
  const answerItems = answerAtoms(items).filter((a) => store.QUESTION_TYPES.includes(a.type));
  const answerColumns = [
    { title: '被试编号', width: 10 },
    { title: '被试自填编号', width: 14 },
    { title: '完成状态', width: 10 },
    ...answerItems.map((a) => ({ title: a.label, width: a.type === 'text' ? 34 : 18 }))
  ];
  const answerRows = summaries.map((s) => {
    const out = [s.seq == null ? '' : s.seq, s.enteredCode || '', STATUS_LABELS[s.status] || s.status || ''];
    for (const a of answerItems) {
      const u = s.units.get(a.key);
      if (!u) { out.push(''); continue; }
      if (a.type === 'rating') out.push(u.value == null ? '' : Number(u.value));
      else if (a.type === 'text') out.push(u.text || '');
      else out.push(u.label || (u.value == null ? '' : Number(u.value)));
    }
    return out;
  });

  // ---- sheet 3：作答明细
  const detailRows = store.listResponseRows(id, { includeAbandoned }).map((r) => [
    r.seq == null ? '' : Number(r.seq),
    STATUS_LABELS[r.session_status] || r.session_status || '',
    labels.get(`${r.item_id}#${r.sub_index || 0}`) || r.item_id,
    store.ITEM_TYPE_LABELS[r.item_type] || r.item_type,
    r.value == null ? '' : Number(r.value),
    (r.item_type === 'text' ? textOf(r.value_text) : '') || r.option_label || '',
    fmtLocal(r.presented_at),
    fmtLocal(r.answered_at),
    sec(r.elapsed_ms),
    Number(r.retry_count) || 0,          // 提交前的重试次数（超时后点「重试」+「需输入指定内容」的断言失败）
    r.timed_out ? '是' : ''              // 是否曾到点未交（超时）
  ]);

  const sheets = [
    {
      // 统计用表：Times New Roman 11、表头加粗居中并自动换行（表头行加高，长列名才不会被截掉）
      name: '汇总（一被试一行）',
      header: { ...S_FONT, bold: true, align: 'center', valign: 'center', wrap: true },
      headerRowHeight: 28.8,
      columns: summaryColumns,
      rows: summaryRows
    },
    { name: '逐题作答（一被试一行）', columns: answerColumns, rows: answerRows },
    {
      name: '作答明细',
      columns: [
        { title: '被试编号', width: 10 },
        { title: '状态', width: 10 },
        { title: '题目', width: 34 },
        { title: '题型', width: 12 },
        { title: '作答值', width: 9 },
        { title: '作答文本 / 选项', width: 40 },
        { title: '呈现时间', width: 20 },
        { title: '作答时间', width: 20 },
        { title: '耗时（秒）', width: 11 },
        { title: '重试次数', width: 11 },
        { title: '曾超时未交', width: 12 }
      ],
      rows: detailRows
    }
  ];

  const fileName = `${payload.title}.xlsx`;
  const buf = buildXlsx(sheets);
  res.writeHead(200, {
    'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'Content-Disposition': `attachment; filename="questionnaire-${id}.xlsx"; filename*=UTF-8''${encodeURIComponent(fileName)}`
  });
  res.end(buf);
}

module.exports = {
  handleAdminQuestionnaireSessions,
  handleAdminSessionsDelete,
  handleAdminQuestionnaireSession,
  handleAdminQuestionnaireExport
};
