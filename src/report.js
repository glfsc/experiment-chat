'use strict';

const store = require('../db');

// 作答原子：把题目展开为「一个可作答项」（题组的子题逐个展开，键为 题目id#子题序号）
function answerAtoms(items) {
  const atoms = [];
  let lastMessageTitle = '';
  const textSeen = new Map();
  const ratingSeen = new Map();
  for (const it of items) {
    if (it.type === 'message') { lastMessageTitle = it.title || ''; continue; }
    const subs = it.type === 'group' ? (it.subs || []) : null;
    const list = subs || [it];
    list.forEach((sub, si) => {
      const key = `${it.id}#${si}`;
      const isScale = sub.type === 'rating';
      const seqNo = String(sub.id || '').match(/^.*_(\d+)$/);
      let label;
      if (isScale && seqNo) {
        label = `${lastMessageTitle || sub.title || it.title} 第 ${Number(seqNo[1])} 题`;
      } else if (isScale) {
        // 不带 _N 序号的打分题（如两道「反馈效价」题共用一句引导语）：用题目标题，
        // 否则两题会同名——导出的列名分不清是哪一题
        const base = sub.title || it.title || lastMessageTitle || sub.id || it.id;
        const n = (ratingSeen.get(base) || 0) + 1;
        ratingSeen.set(base, n);
        label = n > 1 ? `${base}（第 ${n} 题）` : base;
      } else if (sub.type === 'text') {
        const base = subs ? `${it.title} · ${sub.title}` : (sub.title || it.id);
        const n = (textSeen.get(base) || 0) + 1;
        textSeen.set(base, n);
        label = n > 1 ? `${base}（第 ${n} 次）` : base;
      } else {
        label = subs ? `${it.title} · ${sub.title}` : (sub.title || it.id);
      }
      atoms.push({
        item: it,
        sub: subs ? sub : null,
        subIndex: subs ? si : 0,
        key,
        type: sub.type,
        label,
        // 导出用的短列名（可选）：量表/作品/选择题都可以在题目上单独配一个更好认的名字
        colLabel: String(sub.colLabel || ''),
        scalePrefix: isScale ? String(sub.id || '').replace(/_\d+$/, '') : '',
        scaleName: isScale ? (lastMessageTitle || sub.title || it.title) : ''
      });
    });
  }
  return atoms;
}

function itemLabelMap(items) {
  const map = new Map();
  for (const a of answerAtoms(items)) map.set(a.key, a.label);
  for (const it of items) if (it.type === 'message') map.set(`${it.id}#0`, it.title || it.id);
  return map;
}

// 量表列：同一量表前缀 = 一组打分题。多题量表沿用指导语消息标题当列名，
// 单题量表直接用该题自己的标签——否则两道单题量表各占一列「（均分）」时列名一模一样。
function scaleColumns(items) {
  const groups = [];
  const byPrefix = new Map();
  for (const a of answerAtoms(items)) {
    if (a.type !== 'rating') continue;
    let g = byPrefix.get(a.scalePrefix);
    if (!g) {
      g = { prefix: a.scalePrefix, name: '', atoms: [] };
      byPrefix.set(a.scalePrefix, g);
      groups.push(g);
    }
    g.atoms.push(a);
  }
  for (const g of groups) {
    g.name = g.atoms.length === 1 ? g.atoms[0].label : (g.atoms[0].scaleName || g.atoms[0].scalePrefix);
  }
  return groups;
}

function textColumns(items) { return answerAtoms(items).filter((a) => a.type === 'text'); }
function choiceColumns(items) { return answerAtoms(items).filter((a) => a.type === 'single' || a.type === 'multi'); }

// 各作答单元的题号（与 parseSession 同一口径）：非 message 依次入列，需要作答的题型才编号
function unitQnosOf(items) {
  const qnos = [];
  let qno = 0;
  for (const it of items) {
    if (it.type === 'message') continue;
    const isQuestion = store.QUESTION_TYPES.includes(it.type);
    if (isQuestion) qno += 1;
    qnos.push(isQuestion ? qno : 0);
  }
  return qnos;
}

// 已完成作答单元里属于「题号」的个数（题号口径的进度；不数知情同意 / 确认页 / 结束说明）
function answeredQuestionsOf(rows, unitQnos) {
  const units = new Set();
  for (const r of rows) units.add(Number(r.unit_index) || 0);
  let n = 0;
  for (const ui of units) if ((unitQnos[ui] || 0) > 0) n += 1;
  return n;
}

module.exports = {
  answerAtoms,
  itemLabelMap,
  scaleColumns,
  textColumns,
  choiceColumns,
  unitQnosOf,
  answeredQuestionsOf
};
