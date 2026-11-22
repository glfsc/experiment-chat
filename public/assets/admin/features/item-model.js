'use strict';

import { state, TYPE_LABEL, TYPE_LIMITS, itemTypeLabel, LIMIT_META, LIMIT_DEFAULTS } from '../core/state.js';
import { el } from '../core/ui.js';

/* ---------------------------------------------------------------- 题目参数 */

// 生效的参数值：题目配了就用题目的，没配回落到内置默认值（与服务端 effLimit 同逻辑）
function effLimit(item, key) {
  const v = item.limits ? item.limits[key] : undefined;
  if (v !== undefined && v !== null) return Number(v) || 0;
  return Number(LIMIT_DEFAULTS()[key]) || 0;
}

/* ---------------------------------------------------------------- 「题目」口径（与服务端 units.qno 一致）
   只有需要被试作答的题型才计入题号：消息 / 知情同意页 / 确认页 / 结束说明都只是页面，不占题号。 */

function questionTypes() {
  const fromMeta = state.meta && state.meta.questionTypes;
  return Array.isArray(fromMeta) && fromMeta.length
    ? fromMeta
    : ['group', 'rating', 'single', 'multi', 'text', 'rank'];
}
function isQuestionType(type) { return questionTypes().includes(type); }
function questionNos(list) {
  const map = new Map();
  let n = 0;
  for (const it of list) {
    if (!isQuestionType(it.type)) continue;
    n += 1;
    map.set(it.id, n);
  }
  return map;
}
function questionCount(list) {
  return list.reduce((n, it) => n + (isQuestionType(it.type) ? 1 : 0), 0);
}
// 层级（只影响管理端大纲，被试端无感知）：
//   1 = 最高级（不缩进，适合当"消息反馈公平性"这类小标题）、2/3/4 依次降低、0 = 最低级（默认，缩进最深）。
//   排序（从大到小）：1 → 2 → 3 → 4 → 0。
function itemLevel(item) {
  return Math.min(4, Math.max(0, Math.round(Number(item && item.level) || 0)));
}
// 「大小」序：1 最大（4）、0 最小（0）—— 用于判断从属关系（紧跟其后、更小的算下属）
function levelRank(level) {
  const lv = Math.min(4, Math.max(0, Math.round(Number(level) || 0)));
  return lv === 0 ? 0 : 5 - lv;
}
// 缩进档位：1 级 0 档（最靠左）… 4 级 3 档、0 级 4 档（最深）
function levelDepth(level) {
  const lv = Math.min(4, Math.max(0, Math.round(Number(level) || 0)));
  return lv === 0 ? 4 : lv - 1;
}

function limitBadges(item) {
  const out = [];
  for (const k of TYPE_LIMITS(item.type)) {
    if (item.limits[k] == null) continue;                 // 未添加的参数不显示徽标
    const meta = LIMIT_META()[k];
    if (k === 'refresh') { out.push(meta.label); continue; }
    const v = effLimit(item, k);
    if (v > 0) out.push(`${meta.label} ${v}${meta.unit === '秒' ? 's' : ''}`);
  }
  return out;
}

function itemSummary(item) {
  switch (item.type) {
    case 'message': return (item.text || '').split('\n')[0].slice(0, 64) || '（空 · 被试端跳过）';
    case 'gate': return '进入实验前的伦理门槛，勾选后开始';
    case 'confirm': return (item.text || '').split('\n')[0].slice(0, 64) || '读完点确认继续';
    case 'debrief': return (item.text || '').split('\n')[0].slice(0, 64);
    case 'rating': return `${item.min}–${item.max} 分 · ${item.anchor || '无锚点'}${effLimit(item, 'redo') === 1 ? ' · 可重做' : ''}`;
    case 'single': case 'multi': return `${(item.options || []).length} 个选项${item.correct ? ' · 正确答案 ' + 'ABCDEFGH'[item.correct - 1] : ''}`;
    case 'rank': return `${(item.options || []).length} 项排序`;
    case 'text': {
      if (item.variant === 'match') {
        const lines = String(item.answer || '').split('\n').map((x) => x.trim()).filter(Boolean);
        const shown = lines.length ? lines.map((x) => `「${x}」`).join(' / ') : '';
        return shown
          ? `需输入指定内容 · 答案 ${shown}`
          : '⚠ 尚未设置标准答案 · 当前等同自由作答（被试输入任何内容都能发送）';
      }
      return `${item.required === false ? '选答' : '必答'} · ${item.rows || 1} 行${item.maxLen ? ' · 上限 ' + item.maxLen + ' 字' : ''}`;
    }
    case 'group': return (item.subs || []).length
      ? `${item.subs.length} 道子题：${item.subs.map((x) => x.title || TYPE_LABEL(x.type)).join(' + ')}（同屏呈现、一次提交）`
      : '空题组 · 请展开后添加子题';
    default: return item.title || '';
  }
}


function stripLocal(item) {
  const out = JSON.parse(JSON.stringify(item));
  delete out.collapsed;
  delete out.__thinkingOn;      // 「刚添加、还没写内容」的本地标记，不落库
  return out;
}

// 复制命名：在原名末尾加编号（1）（2）…，取第一个未占用的

const UNNAMED_EXP = '未命名实验';
const UNNAMED_Q = '未命名问卷';

export {
  effLimit,
  questionTypes,
  isQuestionType,
  questionNos,
  questionCount,
  itemLevel,
  levelRank,
  levelDepth,
  limitBadges,
  itemSummary,
  stripLocal,
  UNNAMED_EXP,
  UNNAMED_Q
};
