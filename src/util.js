'use strict';

const store = require('../db');

const STATUS_LABELS = { in_progress: '进行中', completed: '已完成', abandoned: '已作废' };
// 选项字母：A–Z；理论上限 26 个选项，超出回落为数字（编辑器选项上限 50，不再出现 undefined）
const OPTION_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
function optionLetter(index) {
  return OPTION_LETTERS[index] || String(index + 1);
}

function fmtLocal(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function effLimit(item, key) {
  const v = item.limits ? item.limits[key] : undefined;
  if (v !== undefined && v !== null) return Number(v) || 0;
  return Number(store.DEFAULT_LIMITS[key]) || 0;
}

function optionLabelOf(item, value) {
  const idx = Number(value) - 1;
  if (idx < 0 || idx >= (item.options || []).length) return '';
  return `${optionLetter(idx)}．${item.options[idx]}`;
}

function textOf(valueText) {
  try {
    const obj = JSON.parse(valueText || 'null');
    return obj && typeof obj === 'object' ? String(obj.text ?? '') : String(valueText || '');
  } catch {
    return String(valueText || '');
  }
}

module.exports = {
  STATUS_LABELS,
  optionLetter,
  fmtLocal,
  effLimit,
  optionLabelOf,
  textOf
};
