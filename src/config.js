'use strict';

const path = require('node:path');

// 项目根：src/ 的上一级。运行期路径（public/）都从根解析，
// 避免模块搬家后 __dirname 变成 src/ 导致静态资源找不到。
const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(ROOT, 'public');

// 注册与资源配额：公开注册是产品默认行为，但允许用环境变量关闭 / 收紧，
// 避免被脚本批量灌账号、无限建问卷把库撑大。管理员不受配额限制。
const ALLOW_REGISTRATION = !['0', 'false', 'off', 'no'].includes(String(process.env.ALLOW_REGISTRATION ?? '1').toLowerCase());
function envNonNegativeInt(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}
// 环境变量只作为“数据库里还没有管理员设置时”的默认值；管理员在全局设置里保存后以数据库为准。
const MAX_QUESTIONNAIRES_PER_USER = envNonNegativeInt('MAX_QUESTIONNAIRES_PER_USER', 10);
const MAX_EXPERIMENTS_PER_USER = envNonNegativeInt('MAX_EXPERIMENTS_PER_USER', 10);

module.exports = {
  ROOT,
  PORT,
  PUBLIC_DIR,
  ALLOW_REGISTRATION,
  envNonNegativeInt,
  MAX_QUESTIONNAIRES_PER_USER,
  MAX_EXPERIMENTS_PER_USER
};


