'use strict';

const store = require('../../db');
const { optionLabelOf } = require('../util');

// 校验并归一化作答值
function validateAnswer(item, body, deadlinePassed = false) {
  switch (item.type) {
    case 'gate': {
      if (body.consent !== true) return { error: '请先勾选同意后再开始' };
      if (item.variant === 'id') {
        const code = String(body.text ?? '').trim();
        if (!code) return { error: '请先填写编号' };
        return { value: null, valueText: code, optionLabel: `已同意并开始 · 编号 ${code}` };
      }
      return { value: null, valueText: '', optionLabel: '已同意并开始' };
    }
    case 'confirm':
      if (body.ack !== true) return { error: '请确认已阅读后再继续' };
      return { value: null, valueText: '', optionLabel: '已确认阅读' };
    case 'debrief':
      if (body.ack !== true) return { error: '请阅读后继续' };
      return { value: null, valueText: '', optionLabel: '已阅读结束说明' };
    case 'rating': {
      const min = Number(item.min) || 1;
      const max = Number(item.max) || 5;
      const v = Number(body.value);
      if (!Number.isInteger(v) || v < min || v > max) return { error: '作答值不合法' };
      return { value: v, valueText: '', optionLabel: `${v} 分` };
    }
    case 'single': {
      const v = Number(body.value);
      const n = (item.options || []).length;
      if (!Number.isInteger(v) || v < 1 || v > n) return { error: '作答值不合法' };
      return { value: v, valueText: '', optionLabel: optionLabelOf(item, v) };
    }
    case 'multi': {
      const raw = Array.isArray(body.values) ? body.values.map(Number) : [];
      const n = (item.options || []).length;
      if (!raw.length) return { error: '请至少选择一项' };
      if (raw.some((v) => !Number.isInteger(v) || v < 1 || v > n)) return { error: '作答值不合法' };
      const uniq = [...new Set(raw)].sort((a, b) => a - b);
      return {
        value: uniq[0],
        valueText: JSON.stringify(uniq),
        optionLabel: uniq.map((v) => optionLabelOf(item, v)).join('、')
      };
    }
    case 'rank': {
      const order = Array.isArray(body.order) ? body.order.map(Number) : [];
      const n = (item.options || []).length;
      if (order.length !== n || new Set(order).size !== n || order.some((v) => !Number.isInteger(v) || v < 1 || v > n)) {
        return { error: '请完成完整排序' };
      }
      return {
        value: order[0],
        valueText: JSON.stringify(order),
        optionLabel: order.map((v, i) => `${i + 1}. ${(item.options || [])[v - 1]}`).join('  ')
      };
    }
    case 'text': {
      const text = String(body.text ?? '').trim();
      const maxLen = Number(item.maxLen) || 0;
      // 二级形态「需输入指定内容」：先在服务端断言，通过了才当普通文本题落库。
      // 断言失败（含内容为空）返回研究者自定义的提示文案（默认「答案错误」），
      // 这一笔不写库、也不进聊天流——被试端只在输入框旁提示，输入内容原样保留。
      // 题目没配标准答案时退化为自由作答（管理端会在题目摘要里提醒「尚未设置答案」）。
      if (item.variant === 'match' && store.matchAnswerLines(item).length && !store.matchesAnswer(item, text)) {
        return { error: store.matchErrorText(item), assertionFailed: true };
      }
      if (item.required !== false && !text && !deadlinePassed) return { error: '请填写内容后再提交' };
      if (maxLen > 0 && text.length > maxLen) return { error: `字数不能超过 ${maxLen} 字` };
      return { value: null, valueText: JSON.stringify({ text }), optionLabel: text };
    }
    case 'group': {
      const subs = item.subs || [];
      if (!subs.length) return { error: '题组未配置子题' };
      const raw2 = Array.isArray(body.answers) ? body.answers : [];
      const rows = [];
      for (let i = 0; i < subs.length; i += 1) {
        const sub = subs[i];
        // 子题按各自题型校验（复用同一套规则）
        const one = validateAnswer(sub, raw2[i] && typeof raw2[i] === 'object' ? raw2[i] : {}, deadlinePassed);
        if (one.error) {
          if (!deadlinePassed) {
            return { error: `${sub.title || `子题 ${i + 1}`}：${one.error}` };
          }
          rows.push({ value: null, valueText: JSON.stringify({ text: '' }), optionLabel: '（时间已到，未填写内容）' });
          continue;
        }
        rows.push({ value: one.value, valueText: one.valueText, optionLabel: one.optionLabel });
      }
      return { group: rows };
    }
    default:
      return { error: '不支持的题型' };
  }
}

module.exports = { validateAnswer };
