// 中性示例种子（公开版）：一套与具体研究无关的产品体验调查，方便首次启动后直接试用。
// 公开仓库只包含本文件，不包含任何真实研究材料。
'use strict';

const defaults = {
  gateTitle: '知情同意说明',
  gateText:
    '欢迎参加本次产品体验调查。\n' +
    '\n' +
    '本调查用于了解用户对产品的真实感受，答案没有对错，请按实际情况填写。\n' +
    '\n' +
    '您的回答将被匿名保存，仅用于统计分析，不会泄露您的个人信息。',
  gateCheck: '我已阅读上述说明，自愿参加本次调查',
  gateButton: '开始作答',
  gateVariant: 'plain',
  gateIdLabel: '编号',
  gateIdPlaceholder: '请填写编号（可选）',
  debriefTitle: '致谢与说明',
  debriefText: '感谢您的参与。本次调查数据仅用于匿名统计分析，不会泄露您的个人信息。',
  debriefClosing: '感谢您的参与。',
  defaultDebriefTitle: '致谢与说明'
};

function build(ctx) {
  const expId = 'demo-product-experience';
  const expName = '示例模板 · 产品体验调查';
  const items = [
    {
      id: 'demo_intro',
      type: 'message',
      level: 4,
      title: '欢迎',
      text: '欢迎参加本次产品体验调查。接下来大约需要 1 分钟。',
      html: ctx.body16('欢迎参加本次产品体验调查。接下来大约需要 1 分钟。')
    },
    {
      id: 'demo_rating',
      type: 'rating',
      title: '整体满意度',
      html: ctx.body16('请评价您对这款产品的整体满意度。'),
      min: 1,
      max: 5,
      anchor: '1 = 非常不满意　·　5 = 非常满意',
      limits: { redo: 1 }
    },
    {
      id: 'demo_single',
      type: 'single',
      title: '使用频率',
      html: ctx.body16('您使用这款产品的频率是？'),
      options: ['每天', '每周几次', '每月几次', '很少使用'],
      correct: 1
    },
    {
      id: 'demo_multi',
      type: 'multi',
      title: '喜欢的特点',
      html: ctx.body16('您最喜欢这款产品的哪些方面？（可多选）'),
      options: ['口感 / 效果', '包装设计', '价格', '品牌理念']
    },
    {
      id: 'demo_text',
      type: 'text',
      title: '使用感受',
      html: ctx.body16('请用一句话描述您的使用感受。'),
      required: true,
      rows: 2,
      maxLen: 200,
      placeholder: '请输入…'
    }
  ];

  const consent = {
    ...ctx.defaultQuestionnaireItems().find((it) => it.type === 'gate'),
    id: 'consent'
  };
  const debrief = {
    ...ctx.DEFAULT_DEBRIEF,
    id: 'debrief',
    title: '致谢与说明',
    level: 4
  };
  const questionnaireItems = [
    consent,
    ...items.map((it) => ({ ...it, fromTemplateId: expId, fromTemplateName: expName })),
    debrief
  ];

  return {
    experiments: [{ id: expId, name: expName, items }],
    questionnaires: [{ title: '示例问卷 · 产品体验调查', items: questionnaireItems }]
  };
}

module.exports = { defaults, build };
