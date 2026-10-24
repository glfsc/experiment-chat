# 05 · Git 与交付流程

> 目标：学会用 Git 管理"一个人 + AI"的项目：小步提交、可回滚、可追溯、可发布；并把这个仓库整理成能放进作品集、不泄露被试数据的状态。

---

## 1. 为什么单人项目更需要 Git

Vibe coding 的特点是：改动快、范围大、有时一次生成几百行。没有 Git，你会遇到：

- 改坏了，不知道回哪一版；
- AI 把某个功能"顺手重构"了，你想只保留其中一部分；
- 预实验前想稳定在一个版本，但又想继续开发；
- 想把项目给别人看，却分不清哪些是实验数据、哪些是代码。

Git 在这里不是"团队协作工具"，而是**你的存档点、实验记录和保险绳**。

一个实用习惯：

```text
让 AI 做大改动之前 → 先 commit 当前可用版本
AI 改完 → 先 git diff 看它动了什么 → 跑 npm run check → 再 commit
```

---

## 2. 初始化仓库

```bash
cd experiment-chat
git init -b main
git add .
git commit -m "chore: 初始化项目骨架"
git remote add origin git@github.com:<you>/<repo>.git
git push -u origin main
```

> 本仓库的远程是 `git@github.com:glfsc/LLM.git`，主分支 `main`，另有长期分支 `pilot/lan-qrcode`。

### 2.1 第一次提交前检查

```bash
git status
git diff --stat
```

确认没有：

- `data.db` / `data.db-wal` / `data.db-shm`
- `node_modules/`
- `dist/`
- `.env` / 密钥 / token
- 真实被试数据、截图里的个人信息

---

## 3. `.gitignore` 策略（逐条解释）

本项目的 `.gitignore`：

```gitignore
# 运行时数据（可通过 npm run reset-db 重建，不入库）
data.db
data.db-wal
data.db-shm

# 依赖目录（本项目零第三方依赖，仍防误提交）
node_modules/

# 日志
*.log
npm-debug.log*

# 编辑器 / 系统文件
.aicoding-chat-workspace
.DS_Store
Thumbs.db

# 开发/自检过程截图不入库（仅保留 v3-* 文档定稿截图）
screenshots/*
!screenshots/v5-*
!screenshots/sv-*

# 设计预览走查截图
design/shots/

# 内部文档（需求、方案、实施报告等，不入库）
documents/

# 工具/临时目录
.tmp/
.zcode/

# Office 临时锁文件
~$*

# 预实验便携包产物
dist/
```

逐条理由：

| 规则 | 理由 | 例外/注意 |
|---|---|---|
| `data.db*` | 含真实被试数据；可由种子重建 | 备份靠停机拷贝或 SQLite `.backup`，不靠 Git |
| `node_modules/` | 本项目零依赖；将来有依赖也不入库 | 用 lockfile 锁定版本 |
| `*.log` | 运行产物，体积大且可能含隐私 | 需要排障时单独发 |
| `documents/` | 内部需求/复盘/交付报告，含过程信息 | 作品集要展示时，先脱敏再移出 |
| `.tmp/` / `.zcode/` | 工具缓存、会话状态 | 不要提交 |
| `dist/` | 打包产物，可重建 | 发布时上传到 Release，不进源码历史 |
| `screenshots/*` + 例外 | 过程截图太多；只留定稿 | 截图可能含真实数据，发布前检查 |
| `design/shots/` | 走查临时截图 | 设计稿本身保留 |
| `~$*` | Office 锁文件 | Windows 常见 |

> 【方法】`.gitignore` 的原则不是"少提交文件"，而是"**不提交可重建/含隐私/体积大**的东西"。代码、种子、文档、测试应该提交；数据、依赖、产物、缓存不提交。

### 3.1 已经误提交了怎么办

如果只是本地未推送：

```bash
git rm --cached data.db
git rm --cached data.db-wal data.db-shm
# 确认 .gitignore 已包含
git commit -m "chore: 停止跟踪运行时数据库"
```

如果已经推到远程：

1. 立刻把仓库设为私有/删除远程副本；
2. 用 `git filter-repo` 从历史中移除（比 `filter-branch` 更安全）：

```bash
git filter-repo --path data.db --path data.db-wal --path data.db-shm --invert-paths
git push --force --all
```

3. **假设数据已经泄露**：如果库里有被试编号/作品，按研究伦理流程处理，不要只删 commit 就当没发生；
4. 轮换相关密钥（如果有）。

> 【方法】Git 历史是分布式的。删掉最新 commit 不等于删除历史；force push 也不等于所有人都忘了。**敏感数据的最佳策略是从来不要提交。**

---

## 4. 提交粒度：一个 commit 一件事

### 4.1 好的 commit

- 只做一件事：一个需求、一个 bug、一次重构；
- 能独立运行、能通过自检；
- message 说清"做了什么 + 为什么"；
- 不混入格式化/重命名/无关改动。

### 4.2 不好的 commit

```text
update
fix bug
改了很多东西
```

或者：

```text
feat: 加登录 + 改导出 + 修 UI + 升级依赖
```

后者出问题时，你无法只回滚其中一部分。

### 4.3 本项目的历史（真实复盘）

```text
75aacb0 2026-09-26 初始提交：实验对话系统（研究2+研究3 固定流程，服务端状态机驱动）
ab8b4cd 2026-09-26 收尾优化：结束流终态化、数据页实验/问题筛选、被试端手机适配
a8ccbf8 2026-10-06 专门适配前终稿：V4 通用问卷模块（六题型+实验题，自检 ALL PASS）
d3b5325 2026-10-07 实验适配改造1.0
af98000 2026-10-07 新增用户管理系统
5ef731b 2026-10-07 预实验便携包：手机扫码连接页 + 局域网二维码 + 双击启动 + 一键打包
53a5ad6 2026-10-07 修复双击启动乱码：bat 改纯 ASCII + 中文提示移至 pilot-start.js
4b38175 2026-10-07 修复预设问卷对所有账号不可见：补归属修复
8fde642 2026-10-07 新增本地模拟被试工具 scripts/simulate-subjects.js
c442c8c 2026-10-07 补充手机开热点方向与防火墙要点
fda2af5 2026-10-08 第二版：更新了ai思考
aef9842 2026-10-08 同步组别3和组别4差异
86bb435 2026-10-09 统一题目模型：问卷=链接+题目列，删除旧问卷页；启动器端口冲突自愈
07f621f 2026-10-09 修复预览跳题串屏与问卷间串页；加两处「重做」；便携包内置 node 单成品
9dbd03e 2026-10-09 保存问卷/实验后留在编辑页；补 README
aeaec8d 2026-10-10 试题内容修改，修复文本发送延迟bug
118f157 2026-10-10 增加手机入口二维码和问卷二维码
1d45e50 2026-10-10 新增登录管理，禁止多端登录
681ae78 2026-10-11 feat(rating): 打分题支持单独重做，便携包改用数据库快照打包
0170d8d 2026-10-15 新增：ai思考过程的内容禁止重复查看
236c94f 2026-10-15 上线版 V1.0：删除内网链接的内容，转为公网访问
5555ed8 2026-10-16 上线版V1.1：反馈正文修改
ccf27ec 2026-10-17 上线版V1.2：新增实验助手头像和名称更改
```

可以看出的阶段：

| 阶段 | 时间 | 主题 |
|---|---|---|
| 原型 | 9/26 | 固定流程（研究2+研究3）、服务端状态机 |
| 通用化 | 10/6–10/7 | V4 通用问卷、实验适配、用户系统 |
| 预实验 | 10/7 | 局域网二维码、便携包、模拟被试、排障 |
| 统一模型 | 10/9 | "一切皆题目"、删除旧问卷页 |
| 上线准备 | 10/10–10/11 | 登录/单设备、二维码、重做、快照打包 |
| 公网上线 | 10/15–10/17 | 去掉内网链接、反馈正文、助手头像/名称 |

**好的地方**：

- 每次预实验前都有明确的"能跑"节点；
- 修复类 commit 能单独回滚；
- 后期开始用 `feat(scope):` 前缀。

**可以改进的地方**：

- 有些 commit 混了多个改动（如"修复 + 加功能 + 打包"），回滚粒度不够；
- 没有 tag，无法一眼定位"预实验用的到底是哪版"；
- 长期分支 `pilot/lan-qrcode` 与 `main` 分叉，最后要手工剔除局域网部分（见第 5 节）。

> 【方法】历史不完美没关系，关键是**从现在开始**每个 commit 只做一件事，并给发布打 tag。

---

## 5. 分支策略

### 5.1 本项目的实际分支

```text
main
  └─ 公网正式版（7c312e5 剔除非局域网必需的部分）
pilot/lan-qrcode
  └─ 局域网预实验版（二维码、便携包、启动器）
```

两条分支共享大部分历史，但后期分叉：`pilot` 加了局域网能力，`main` 又把它剔掉。结果是：

- 同一个 bug 要在两边各修一次；
- 合并时冲突多；
- "到底哪条是正式版"要靠人记。

### 5.2 更推荐的方式

| 场景 | 做法 |
|---|---|
| 单人、短周期 | `main` 保持可运行；每个需求开 `feat/xxx`，完成后合并回 `main` |
| 长期变体（局域网版/公网版） | 用**配置开关**或**构建变体**，不要长期分叉 |
| 必须长期分叉 | 定期把 `main` 合回变体分支；在 README 写清合并策略与发布节奏 |
| 紧急修复 | `fix/xxx` 从 `main` 拉出，修完合并，再 cherry-pick 到变体 |

**分支命名**：

```text
feat/item-params
fix/too-early-retry
refactor/state-machine
test/export-columns
docs/deploy
```

### 5.3 一次完整工作流

```bash
# 1. 从最新 main 开分支
git switch main
git pull
git switch -c feat/item-params

# 2. 开发 + 自检
npm run check

# 3. 看改动
git status
git diff --stat
git diff

# 4. 分块暂存（可选）
git add -p

# 5. 提交
git commit -m "feat(params): 题目参数支持增删改与预设"

# 6. 合并回 main（保留分支痕迹）
git switch main
git merge --no-ff feat/item-params

# 7. 发布
git tag -a v0.2.0 -m "预实验版：题目参数 + 清屏点"
git push origin main --tags

# 8. 删除已合并分支
git branch -d feat/item-params
```

> 【方法】`--no-ff` 会保留"这是一次功能合并"的历史，方便以后回滚整个功能；快进合并会让历史变成一条直线，看不出边界。

---

## 6. 提交信息规范

### 6.1 推荐格式

```text
<type>(<scope>): <summary>

<body：为什么改、影响什么>

<footer：BREAKING CHANGE / refs>
```

`type`：

| type | 用途 |
|---|---|
| `feat` | 新功能 |
| `fix` | 修复 bug |
| `refactor` | 重构（行为不变） |
| `test` | 测试 |
| `docs` | 文档 |
| `chore` | 构建/工具/依赖 |
| `perf` | 性能 |
| `style` | 格式（不影响逻辑） |

示例：

```text
feat(rating): 打分题支持单独重做

已提交的打分题卡片增加「重做」按钮，只就地更新原作答行，
不推进进度、不产生重复行；刷新后不再提供重做。
关闭题目参数 redo 即可禁用。

Refs: #12
```

```text
fix(step): 迟到的自动提交被记到下一题

提交时校验 itemId 是否等于当前作答单元；不匹配则幂等忽略，
返回当前状态，避免「答完一题跳过两题」。

Refs: #18
```

### 6.2 中文还是英文

本仓库混用中文与 `feat(scope):`。建议：

- **type/scope 用英文**（工具友好）；
- **summary 用中文**（团队/自己读得懂）；
- **body 写"为什么"**，不要重复 diff 里的"做了什么"。

### 6.3 不要写的 message

- `update`
- `fix`
- `改好了`
- `提交`
- `一大堆改动`

这些在 `git log` 里等于没有信息。

---

## 7. Tag 与发布

### 7.1 给发布打 tag

当前仓库没有 tag。建议补：

```bash
git tag -a v1.0 -m "公网正式版 V1.0：去除内网链接" 236c94f
git tag -a v1.1 -m "反馈正文修改" 5555ed8
git tag -a v1.2 -m "实验助手头像与名称" ccf27ec
git push origin --tags
```

以后每次预实验/正式上线都打 tag，并在 Release 里写：

```markdown
## v1.2
### 新增
- 实验助手头像与名称可配置
### 修复
- ……
### 数据/配置变更
- 需要运行 `node scripts/sync-group-content.js --apply`
### 升级步骤
1. 备份 data.db 三件套
2. 上传上线包
3. 执行 update.cmd
4. 健康检查
```

### 7.2 语义化版本（可选）

- `v0.x`：预实验/内部；
- `v1.x`：正式收数据；
- `v1.x.y`：修复。

研究项目不一定要严格 semver，但"每次发布有 tag + 说明"很重要。

---

## 8. 建议的重建提交序列

如果你要从零重做一遍，按这个顺序提交（每个都能跑）：

```text
1  chore: 初始化仓库与项目骨架
2  feat: 静态服务器与健康检查
3  feat: SQLite 建表与幂等种子
4  feat: 统一题目模型与题目归一化
5  feat: 会话状态机与三个被试 API
6  feat: 被试端消息流与题卡
7  feat: 刷新恢复与已答回放
8  feat: 管理端登录与账号隔离
9  feat: 模板/问卷 CRUD 与可视化编辑
10 feat: 手机预览与从头试填
11 feat: 数据页与 Excel 导出
12 test: 平台行为自检（含时间旅行）
13 test: 内容一致性自检（两组差异）
14 feat: 局域网二维码与便携包
15 docs: 部署文档与现场须知
16 chore: 发布 v1.0.0
```

对应到本项目的真实历史，阶段 1–7 大约对应 9/26–10/6，阶段 8–11 对应 10/7–10/10，阶段 12–14 对应 10/9–10/15，阶段 15–16 对应 10/15–10/17。

> 【方法】重建历史时，不要为了"好看"伪造时间线；重点是**每个 commit 有清晰的意图和可运行的边界**。

---

## 9. 常见事故与恢复

### 9.1 改坏了，想回到上一个 commit

```bash
# 只看，不改变工作区
git log --oneline
git show <hash>

# 丢弃工作区改动（危险：未提交的改动会没）
git restore .

# 回到某个 commit（保留改动为未暂存）
git reset --soft <hash>

# 彻底回到某个 commit（危险）
git reset --hard <hash>
```

> `--hard` 前先 `git stash` 或复制目录。不要在生产目录里随手 `--hard`。

### 9.2 误删了 commit

```bash
git reflog
# 找到丢失的 commit
git switch -c rescue <hash>
```

`reflog` 是本地"操作日志"，通常能找回最近 90 天的 HEAD 移动。

### 9.3 提交到错误分支

```bash
git log --oneline -3
# 假设 feat 分支的 commit 提到了 main
git switch feat
git cherry-pick <hash>
git switch main
git reset --hard HEAD~1   # 仅当还没推送
```

### 9.4 已推送的提交要撤销

```bash
# 安全：生成一个反向 commit
git revert <hash>

# 危险：改写历史（仅个人分支/确认无人基于它开发）
git reset --hard <hash>
git push --force-with-lease
```

> 团队/公开仓库优先 `revert`，不要 force push。

### 9.5 stash

```bash
git stash push -m "wip: 参数区"
git stash list
git stash pop
```

适合"改到一半要切分支修 bug"。

---

## 10. 敏感信息与作品集脱敏

### 10.1 这个仓库里哪些东西敏感

| 内容 | 风险 | 处理 |
|---|---|---|
| `data.db*` | 被试编号、作品、作答时间 | 永不提交；备份加密；发布前确认 |
| `documents/` | 内部需求、排期、问题报告 | 默认 ignore；展示前脱敏 |
| `demand/` | 实验材料、联系人邮箱 | 默认不提交；如需展示，去掉邮箱/姓名 |
| `DEPLOY.md` | 服务器路径、域名、计划任务名 | 作品集可保留架构，敏感路径/IP 打码 |
| 截图 | 可能含真实被试数据/账号 | 用测试数据重截；打码 |
| token/密钥 | `settings.auth_secret` 在库里 | 不导出、不截图 |

### 10.2 作品集版 README 应该包含

```markdown
# 项目名
一句话：为 XX 研究做的对话式实验平台

## 问题
- 原流程：QQ 群人工发材料/计时/记录
- 痛点：时间不一致、数据错漏、无法离线

## 方案
- 统一题目模型（10 种题型）
- 服务端权威门控
- 会话快照
- 零依赖单进程 + 便携包

## 架构
（一张图 + 三行说明）

## 技术选择
- Node 22 + node:sqlite + 原生前端
- 为什么：离线/零安装/单文件数据

## 结果
- 支撑 2 组 × N 人预实验（填真实数字）
- 一位被试约 27–31 次请求；300 并发提交本机实测 …
- 自检 70+ 断言；自检耗时从 6m47s 降到 0.7s

## 我负责的部分
- 需求分析、领域建模、全部实现、测试、部署

## 演示
- 截图/GIF（脱敏）
- 如何本地运行

## 文档
- 需求/架构/部署/复盘链接
```

### 10.3 不要夸大的地方

- "300 并发"是本机探针数据，不是生产压测；写清楚测试条件；
- "零依赖"是事实，但代价是自写 xlsx/测试/清洗，别把它说成纯粹优点；
- "AI 反馈"是预设文案，不是真 LLM；说清楚这是实验操纵；
- 被试数量、实验结论要等真实数据；不要把预实验当正式结果。

> 【方法】作品集的可信度来自"边界清楚"：你做了什么、没做什么、数据在什么条件下测得。夸大一次，面试追问就露馅。

---

## 11. 如果以后多人协作

最小配置：

1. **分支保护**：`main` 不允许直接 push；
2. **PR 模板**：改了什么、为什么、怎么验证、影响哪些数据/配置；
3. **CI**：GitHub Actions 跑 `npm run check`（Node 22）；
4. **Code Review 清单**：
   - 是否改了数据口径/导出列？
   - 是否影响进行中会话（快照/迁移）？
   - 是否需要同步线上问卷（`sync-group-content`）？
   - 是否提交了 `data.db`/`dist`/`documents`？
5. **发布流程**：tag + Release notes + 备份 + 回滚方案。

GitHub Actions 示例：

```yaml
name: check
on: [push, pull_request]
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '22.13'
      - run: npm run check
```

> 注意：`check` 会起服务、写临时库；CI 里用独立端口/临时目录，避免污染。

---

## 12. 命令速查

```bash
# 状态与历史
git status
git log --oneline --graph --all
git show <hash>
git diff
git diff --stat
git blame <file>

# 暂存与提交
git add <file>
git add -p
git commit -m "feat(scope): ..."
git commit --amend          # 仅未推送

# 分支
git switch -c feat/xxx
git switch main
git branch -d feat/xxx
git merge --no-ff feat/xxx
git rebase main             # 个人分支整理；冲突时谨慎

# 远程
git remote -v
git fetch --all
git pull --ff-only
git push -u origin main
git push origin --tags

# 撤销
git restore <file>
git restore --staged <file>
git reset --soft <hash>
git reset --hard <hash>     # 危险
git revert <hash>
git reflog

# 标签
git tag
git tag -a v1.0 -m "..."
git push origin v1.0

# 清理
git clean -nd               # 先看会删什么
git clean -fd               # 删除未跟踪文件（危险）
```

---

## 13. 练习

1. 给你现在的仓库补三个 tag（对应三个可运行版本），写 Release notes。
2. 找一条"混了多个改动"的历史 commit，说明如果当时拆成 3 个 commit，回滚会容易在哪。
3. 模拟误提交 `data.db`：在测试仓库里提交、推送、再用 `filter-repo` 移除，记录步骤。
4. 写一个 PR 模板（改了什么/为什么/怎么验证/数据影响）。
5. 把 README 改成"作品集版"：问题、方案、架构、结果、我负责的部分、演示。检查是否有敏感信息。

---

## 14. 本阶段交付物清单

- [ ] `.gitignore` 覆盖数据/依赖/产物/内部文档
- [ ] `main` 始终可运行
- [ ] 每个 commit 只做一件事，message 说清为什么
- [ ] 至少三个发布 tag + Release notes
- [ ] 一份作品集版 README（脱敏）
- [ ] 一份回滚/恢复步骤
- [ ] 敏感信息检查清单

---

上一篇：[04 · 从零搭建骨架](04-从零搭建骨架.md) ｜ 返回：[总索引](00-总索引与学习路线.md)
