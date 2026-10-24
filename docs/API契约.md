# API 契约（从代码反向整理）

> 本项目**没有** OpenAPI/Swagger 文档，也没有单独的 `api.md`。接口约定原本只存在于三处：
>
> 1. `server.js` 的路由表（约 2387–2448 行）；
> 2. 每个 `handleXxx` 函数里的请求字段、返回对象、错误分支；
> 3. `public/assets/chat.js` / `admin.js` 里的实际调用。
>
> 本文是按当前代码反向整理的一份“核心契约”。它回答“请求长什么样、返回长什么样、会报什么错”，并说明如何自己从代码里提取和更新。**改路由/字段时，请同步改这里。**

---

## 1. 通用约定

### 1.1 传输

- 同源 HTTP，默认端口 `3000`；
- 请求/响应体都是 JSON（导出接口返回 xlsx 二进制）；
- 请求头：`Content-Type: application/json`；
- 管理端请求头：`Authorization: Bearer <token>`；
- 被试端不登录，靠 `sessionId` 识别会话。

### 1.2 成功/失败的结构

成功：HTTP 2xx + 业务 JSON。

失败：HTTP 4xx/5xx + 统一错误体：

```json
{
  "error": "too_early",
  "message": "还未到可提交时间"
}
```

有些错误会带额外字段，例如：

```json
{
  "error": "too_early",
  "message": "还未到可提交时间",
  "availableAtMs": 1730000060000,
  "nowMs": 1730000000000
}
```

### 1.3 三个“编号”别混

| 名字 | 含义 | 生成 | 用在哪 |
|---|---|---|---|
| `sessionId` | 一次作答会话的主键 | 服务端 UUID | 被试端所有请求 |
| `seq` | 该问卷内第几位被试 | 服务端自增 | 数据页/导出「被试编号」 |
| `enteredCode` | 被试在知情同意页自填的编号 | 被试 | 导出「被试自填编号」 |

`sessionId` 不是登录凭证，也不是被试编号。拿到它的人可以继续这次会话，所以要当秘密对待。

### 1.4 状态码约定

| 码 | 含义 | 典型场景 |
|---|---|---|
| 200 | 成功 | 正常返回 |
| 400 | 请求内容不合法 | 打分为空、提前提交、缺少 sessionId |
| 401 | 未登录/登录失效 | 管理端 token 过期、被顶下线 |
| 403 | 无权限 | 普通用户访问管理员接口 |
| 404 | 资源不存在 | 会话/问卷/预览不存在 |
| 409 | 状态冲突 | 会话已结束 |
| 413 | 请求体过大 | 超过 4MB |
| 429 | 限流 | 登录/注册/建会话过于频繁 |
| 500 | 服务端异常 | 未捕获错误（不回显内部细节） |

---

## 2. 被试端 API

### 2.1 总表

| 方法 | 路径 | 鉴权 | 作用 |
|---|---|---|---|
| GET | `/api/health` | 无 | 健康检查 |
| GET | `/api/bootstrap?q=&session=` | 无 | 打开/恢复页面（只读） |
| POST | `/api/session` | 无 | 新建会话（写） |
| POST | `/api/step` | 无（带 sessionId） | 提交当前题并推进 |
| POST | `/api/step/retry` | 无（带 sessionId） | 超时后重开当前题窗口 |
| POST | `/api/finish` | 无（带 sessionId） | 结束/作废会话 |
| POST | `/api/heartbeat` | 无（带 sessionId） | 刷新最近活动时间 |
| GET | `/api/net-info` | 管理端登录 | 局域网地址（二维码用） |
| GET | `/qr.svg?u=` | 无 | 生成二维码 SVG |

### 2.2 `GET /api/bootstrap`

**用途**：打开链接时读取问卷信息；如果本地有会话，恢复消息、已答卡片和当前题。**只读，不建会话。**

请求：

```http
GET /api/bootstrap?q=uegnugph&session=s_123
```

| 参数 | 必填 | 说明 |
|---|---|---|
| `q` | 是 | 问卷 8 位短码 |
| `session` | 否 | 本地保存的会话 id；没有就传空 |

成功 200（无会话）：

```json
{
  "questionnaireTitle": "组别3",
  "assistantName": "小A",
  "assistantAvatar": "",
  "session": null,
  "messages": [],
  "action": null,
  "nowMs": 1730000000000
}
```

成功 200（有进行中的会话）：

```json
{
  "questionnaireTitle": "组别3",
  "assistantName": "小A",
  "assistantAvatar": "",
  "session": {
    "id": "s_123",
    "uid": "1",
    "seq": 1,
    "status": "in_progress"
  },
  "messages": [
    { "id": 1, "role": "assistant", "content": "欢迎参与本次实验……", "item_id": "welcome" }
  ],
  "replay": [],
  "action": {
    "itemId": "q1",
    "type": "rating",
    "title": "请评价……",
    "min": 1,
    "max": 5,
    "availableAtMs": 0,
    "minSubmitAtMs": 0,
    "deadlineMs": 0,
    "nowMs": 1730000000000
  },
  "nowMs": 1730000000000,
  "totalItems": 42,
  "totalAnswers": 28,
  "totalQuestions": 28,
  "currentQno": 1,
  "answeredCount": 0,
  "timeScale": 1
}
```

字段说明：

| 字段 | 含义 |
|---|---|
| `session.id` | 会话主键 |
| `session.uid` / `seq` | 该问卷内第几位被试 |
| `messages` | 当前可见消息（按清屏点过滤） |
| `replay` | 已呈现内容的回放时间线（消息/用户回显/已答卡片） |
| `action` | 当前待作答单元；`null` = 已完成 |
| `totalAnswers` | 作答单元数（含知情同意/确认页/结束页） |
| `totalQuestions` | 真实题数（进度条分母） |
| `currentQno` | 当前第几题（不占题号的页面会跳到下一个题号） |
| `nowMs` | 服务端时间，前端用来校准倒计时 |

错误：

| 码 | error | 说明 |
|---|---|---|
| 404 | `questionnaire_not_found` | 短码不存在或链接失效 |

行为细节：

- 会话跨问卷、超恢复窗口、已作废 → 当作无会话返回 `session: null`；
- 有会话 → 更新 `sessions.active_at`（算一次活动）；
- **不会**创建会话；创建是 `POST /api/session`。

### 2.3 `POST /api/session`

**用途**：新被试开始；复制题目快照、分配 `seq`、发出第一题之前的消息。

请求：

```json
{ "q": "uegnugph" }
```

成功 200：`questionnaireTitle` + 与 `sessionPayload` 相同的字段（见 2.2 的“有会话”响应）。

错误：

| 码 | error | 说明 |
|---|---|---|
| 404 | `questionnaire_not_found` | 短码不存在 |
| 400 | `empty_items` | 问卷没有题目 |
| 429 | `rate_limited` | 建会话过于频繁 |

行为细节：

- 把问卷的 `items` 复制进 `sessions.items_json`（快照）；
- 之后改问卷不影响这个会话；
- **不是幂等的**：前端要加 `busy` 锁，避免双击建两个会话。

### 2.4 `POST /api/step`

**用途**：提交当前作答单元、写入作答、发出后续消息、推进到下一题。

请求：

```json
{
  "sessionId": "s_123",
  "itemId": "q1",
  "value": 4,
  "elapsedMs": 3200
}
```

通用字段：

| 字段 | 必填 | 说明 |
|---|---|---|
| `sessionId` | 是 | 会话 id |
| `itemId` | 强烈建议 | 当前题 id；用于幂等，防串题 |
| `elapsedMs` | 否 | 前端上报的作答耗时（分析用，不作为门控权威） |

不同题型的作答字段：

| 题型 | 字段 | 例子 |
|---|---|---|
| `rating` | `value` | `4` |
| `single` | `value` | `2` |
| `multi` | `values` | `[1,3]` |
| `text` | `text` | `"轻野一下"` |
| `rank` | `order` | `[2,1,3]` |
| `group` | `answers` | `[{ "text": "..." }, { "value": 3 }]` |
| `gate` | `consent` + 可选 `text` | `{ "consent": true, "text": "A001" }` |
| `confirm` / `debrief` | `ack` | `true` |
| 打分重做 | `redo: true` + `itemId` + `value` | 只允许已提交的 `rating` |

**重做分支**：`redo: true` 时不推进会话，只就地更新已提交的打分题，返回：

```json
{
  "redone": { "itemId": "q1", "value": 5, "optionLabel": "5 分" },
  "nowMs": 1730000000000,
  "session": { "id": "s_123", "uid": "1", "seq": 1, "status": "in_progress" }
}
```

成功 200：

```json
{
  "userMessage": { "id": 10, "role": "user", "content": "我的选择：4 分" },
  "messages": [],
  "clearStream": false,
  "action": {
    "itemId": "q2",
    "type": "rating",
    "title": "请评价……",
    "min": 1,
    "max": 5,
    "availableAtMs": 0,
    "minSubmitAtMs": 0,
    "deadlineMs": 0,
    "nowMs": 1730000000000
  },
  "nowMs": 1730000000000,
  "session": { "id": "s_123", "uid": "1", "seq": 1, "status": "in_progress" },
  "answeredCount": 1,
  "totalAnswers": 28,
  "totalQuestions": 28,
  "currentQno": 2,
  "timeScale": 1
}
```

字段说明：

| 字段 | 含义 |
|---|---|
| `userMessage` | 本次提交的用户回显消息 |
| `messages` | 当前题与下一题之间要发出的 AI 消息 |
| `clearStream` | 是否先清空聊天流（清屏点） |
| `action` | 下一题；`null` = 已完成 |
| `answeredCount` / `totalAnswers` | 已答单元数 / 总单元数 |
| `currentQno` | 当前题号 |

错误：

| 码 | error | 说明 |
|---|---|---|
| 400 | `bad_request` | 缺少 sessionId |
| 400 | `too_early` | 未到 `availableAt` 或 `minSubmitAt`；带 `availableAtMs/nowMs` |
| 400 | `invalid_answer` | 答案不合法（空/越界/格式错） |
| 400 | `redo_not_allowed` | 重做目标不是已提交的打分题，或未开启重做 |
| 404 | `session_not_found` | 会话不存在 |
| 409 | `session_closed` | 会话已结束 |
| 200 | `ignored: true` | `itemId` 不是当前题（重复/迟到提交），不写库、不推进 |

行为细节：

- **先校验、后写库**；
- 一次提交可能写 `responses`、`messages`、`sessions` 三处；
- 幂等：`itemId` 必须等于当前题，否则返回当前状态并 `ignored: true`；
- 最后一题提交后 `session.status = completed`，`action = null`。

### 2.5 `POST /api/step/retry`

**用途**：作答窗口已过、被试点“重试”时，开一个新的窗口（重置本题计时基准），并记录一次重试。

请求：

```json
{ "sessionId": "s_123" }
```

成功 200：`sessionPayload` + `retried: true` + `nowMs`。

错误：

| 码 | error | 说明 |
|---|---|---|
| 400 | `not_expired` | 本题作答时间还没到，无需重试 |
| 404 | `session_not_found` | 会话不存在 |
| 409 | `session_closed` | 会话已结束 |

### 2.6 `POST /api/finish`

**用途**：提前结束或作废会话。

请求：

```json
{ "sessionId": "s_123", "abandon": false }
```

`abandon: true` = 作废（数据留档，默认不进导出）。

成功 200：

```json
{
  "session": { "id": "s_123", "status": "completed", "duration_sec": 1234 }
}
```

错误：`404 session_not_found`。

### 2.7 `POST /api/heartbeat`

**用途**：页面打开期间定时心跳，刷新 `sessions.active_at`，避免被试慢慢读题被误判为“太久没提交”。

请求：

```json
{ "sessionId": "s_123" }
```

成功 200：

```json
{ "ok": true, "status": "in_progress", "nowMs": 1730000000000 }
```

错误：`404 session_not_found`。

### 2.8 其他

- `GET /api/health` → `{ "ok": true }`；
- `GET /api/net-info`（需登录）→ `{ port, local, urls: [...] }`；
- `GET /qr.svg?u=<url>` → SVG；`u` 必须 `http(s)://` 开头，长度 ≤ 512。

---

## 3. 管理端 API

### 3.1 登录与账号

| 方法 | 路径 | 鉴权 | 请求 | 成功返回 |
|---|---|---|---|---|
| POST | `/api/auth/register` | 无 | `{ username, password }` | `{ token, user }` |
| POST | `/api/auth/login` | 无 | `{ username, password, remember? }` | `{ token, ttlMs, user }` |
| POST | `/api/auth/logout` | Bearer | — | `{ ok: true }` |
| GET | `/api/auth/me` | Bearer | — | `{ user }` |
| POST | `/api/auth/password` | Bearer | `{ oldPassword, newPassword, remember? }` | `{ ok: true, token, ttlMs }` |
| POST | `/api/auth/avatar` | Bearer | `{ avatar: dataURL }` | `{ avatar }` |
| POST | `/api/auth/assistant` | Bearer | `{ avatar?, name? }` | `{ assistant }` |

`user` 结构：

```json
{
  "id": "u_1",
  "username": "admin",
  "role": "admin",
  "avatar": "",
  "assistantAvatar": "",
  "assistantName": "小A"
}
```

错误：

- 登录失败 `401 bad_credentials`；
- 被顶下线 `401 kicked`；
- 未登录 `401 unauthorized`；
- 限流 `429 rate_limited`；
- 头像不是图片/过大 `400 bad_avatar` / `400 avatar_too_large`。

### 3.2 元信息与设置

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| GET | `/api/admin/meta` | 任意登录用户 | 题型、参数、默认题目、恢复窗口 |
| GET | `/api/admin/settings` | 管理员 | `{ settings: { resumeWindowHours, abandonAfterMinutes } }` |
| POST | `/api/admin/settings` | 管理员 | 同上，保存 |

`/api/admin/meta` 返回的字段：

```json
{
  "itemTypes": [...],
  "questionTypes": [...],
  "itemTypeLabels": {...},
  "itemVariants": {...},
  "itemLimits": {...},
  "limitMeta": {...},
  "limitSpec": {...},
  "limitDefaults": {...},
  "itemDefaults": {...},
  "defaultQuestionnaireItems": [...],
  "resumeWindowHours": 24,
  "abandonAfterMinutes": 0
}
```

### 3.3 用户管理（仅管理员）

| 方法 | 路径 | 请求 | 成功 |
|---|---|---|---|
| GET | `/api/admin/users` | — | `{ users }` |
| POST | `/api/admin/users/create` | `{ username, password, role?, avatar? }` | `{ user }` |
| POST | `/api/admin/users/update` | `{ id, username?, role?, password?, avatar?, assistantAvatar?, assistantName? }` | `{ user }` |
| POST | `/api/admin/users/delete` | `{ id }` | `{ ok: true }` |

注意：不能删除自己（`400 self_delete`）；管理员重置他人密码会踢掉该账号所有旧登录。

### 3.4 实验模板（按创建者隔离）

| 方法 | 路径 | 请求/查询 | 成功 |
|---|---|---|---|
| GET | `/api/admin/experiments` | — | `{ experiments }` |
| GET | `/api/admin/experiment?id=` | `id` | `{ experiment }` |
| POST | `/api/admin/experiment/create` | `{ name, copyFrom? }` | `{ experiment }` |
| POST | `/api/admin/experiment/import` | `{ code, name? }` | `{ experiment }` |
| POST | `/api/admin/experiment/update` | `{ id, name, items }` | `{ experiment }` |
| POST | `/api/admin/experiment/delete` | `{ id }` | `{ ok: true }` |

### 3.5 问卷

| 方法 | 路径 | 请求/查询 | 成功 |
|---|---|---|---|
| GET | `/api/admin/questionnaires` | — | `{ questionnaires }` |
| GET | `/api/admin/questionnaire?id=` | `id` | `{ questionnaire }` |
| POST | `/api/admin/questionnaire/create` | `{ title, copyFrom? \| items? }` | `{ questionnaire }` |
| POST | `/api/admin/questionnaire/import` | `{ code, title? }` | `{ questionnaire }` |
| POST | `/api/admin/questionnaire/update` | `{ id, title, items }` | `{ questionnaire }` |
| POST | `/api/admin/questionnaire/delete` | `{ id, force? }` | `{ ok: true }` / `400 has_sessions` |
| GET | `/api/admin/questionnaire/sessions?id=` | `id` | `{ questionnaire, sessions, sessionCount, totalQuestions }` |
| POST | `/api/admin/questionnaire/sessions/delete` | `{ id, ids }` | `{ ok: true, deleted }` |
| GET | `/api/admin/questionnaire/session?id=&sid=` | `id`, `sid` | `{ questionnaire, session, messages, responses }` |
| GET | `/api/admin/questionnaire/export.xlsx?id=&includeAbandoned=` | `id` | xlsx 二进制 |

导出：三个 sheet——「汇总（一被试一行）」「逐题作答（一被试一行）」「作答明细」。

### 3.6 手机预览（内存会话，不落库）

| 方法 | 路径 | 请求 | 成功 |
|---|---|---|---|
| POST | `/api/admin/preview` | `{ items, speed? }` | `{ previewId, url }` |
| GET | `/api/preview/bootstrap?preview=&session=` | query | 同 `/api/bootstrap` |
| POST | `/api/preview/session` | `{ previewId }` | 预览会话 + 首题 |
| POST | `/api/preview/step` | `{ previewId, sessionId, ...step }` | 同 `/api/step` |
| POST | `/api/preview/seek` | `{ previewId, sessionId, qno }` | 跳到指定题号 |
| POST | `/api/preview/seek-unit` | `{ previewId, sessionId, index }` | 跳到指定作答单元（自检用） |
| POST | `/api/preview/speed` | `{ previewId, speed }` | `{ ok: true, speed }` |
| POST | `/api/preview/destroy` | `{ previewId }` | `{ ok: true, destroyed }` |
| POST | `/api/preview/finish` | `{ previewId, sessionId, abandon? }` | `{ session }` |

注意：预览端点**不校验管理端登录**；`previewId` 本身是能力凭证（10 位随机、内存态、约 1 小时过期）。

---

## 4. 错误码速查

| error | 码 | 含义 |
|---|---|---|
| `bad_request` | 400 | 缺少必要字段 |
| `invalid_answer` | 400 | 答案不合法 |
| `too_early` | 400 | 未到可提交时间 |
| `bad_credentials` | 401 | 账号或密码错误 |
| `unauthorized` | 401 | 未登录/过期 |
| `kicked` | 401 | 别处登录/改密，本设备失效 |
| `forbidden` | 403 | 无权限 |
| `session_not_found` | 404 | 会话不存在 |
| `questionnaire_not_found` | 404 | 问卷不存在 |
| `experiment_not_found` | 404 | 实验模板不存在 |
| `user_not_found` | 404 | 用户不存在 |
| `preview_expired` | 404 | 预览过期 |
| `session_closed` | 409 | 会话已结束 |
| `body_too_large` | 413 | 请求体超过 4MB |
| `rate_limited` | 429 | 限流 |
| `has_sessions` | 400 | 问卷已有数据，删除需确认 |
| `not_expired` | 400 | 作答窗口未结束，无需重试 |
| `redo_not_allowed` | 400 | 不允许重做 |
| `empty_items` | 400 | 问卷没有题目 |

---

## 5. 这份契约是怎么构建的（你也可以照做）

### 5.1 先承认：本项目是“代码优先”

没有先写 OpenAPI 再写代码，所以契约是**反向整理**出来的。好处是快；坏处是容易漂移——改了一个字段忘了改文档。

### 5.2 提取步骤

1. **列路由**：打开 `server.js` 约 2387 行，把所有 `if (pathname === ...)` 抄成清单；
2. **找 handler**：每个路由对应一个 `handleXxx`，读它的：
   - 鉴权（`requireUser` / `requireAdmin` / 无）；
   - 请求字段（`body.xxx`、`url.searchParams.get`）；
   - 返回对象（`sendJson(res, 200, {...})`）；
   - 错误分支（`sendJson(res, 4xx, { error: ... })`）；
   - 副作用（写哪张表、发什么消息）；
3. **对前端**：在 `chat.js` / `admin.js` 里搜路径，确认实际传的字段和读取的字段；
4. **用 curl 验证**：至少跑一次成功 + 一次失败，把真实 JSON 贴回文档；
5. **写表/写 OpenAPI**：核心接口详细写，CRUD 接口一行带过。

### 5.3 示例：怎么从代码读出 `/api/step`

```js
// 路由
if (pathname === '/api/step' && req.method === 'POST') return await handleStep(req, res);

// handler
async function handleStep(req, res) {
  const body = await readJsonBody(req);
  const sessionId = String(body.sessionId || '').trim();
  if (!sessionId) return sendJson(res, 400, { error: 'bad_request', message: '缺少 sessionId' });
  const out = await applyStep(store, sessionId, body);
  if (out.error) return sendJson(res, out.status, out.error);
  sendJson(res, 200, out.payload);
}
```

从这几行就能读出：

- method/path；
- 必填 `sessionId`；
- 400 `bad_request`；
- 其他字段在 `applyStep` 里（`itemId`、`value`、`text`、`values`、`order`、`answers`、`consent`、`ack`、`redo`、`elapsedMs`）；
- 成功返回 `out.payload`（见 2.4）。

### 5.4 维护规则

- **新增/修改路由**：同一次提交里更新这份文档；
- **字段改名**：grep 前端与自检，别只改后端；
- **错误码**：新增 error 时加进第 4 节；
- **契约测试**：至少保证 `npm run check` 覆盖核心成功/失败路径；
- **对外/多人**：再考虑生成 OpenAPI + Swagger UI。

### 5.5 想生成“网页版 API 文档”怎么办

那个网页是 Swagger UI，需要一个 `openapi.yaml`。最小示例：

```yaml
openapi: 3.0.0
info:
  title: 实验对话系统 API
  version: 1.0.0
paths:
  /api/step:
    post:
      summary: 提交当前作答单元
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [sessionId, itemId]
              properties:
                sessionId: { type: string }
                itemId: { type: string }
                value: { type: integer }
                elapsedMs: { type: integer }
      responses:
        '200':
          description: 成功，返回下一题
        '400':
          description: 参数/时间/答案不合法
        '409':
          description: 会话已结束
```

然后用 Swagger UI 或 Redoc 渲染。小项目用 Markdown 表就够；只有多人协作/对外提供 API 时才值得上 OpenAPI。

---

## 6. 一句话总结

> 这个项目的契约原本“藏在代码里”：路由表 + handler + 前端调用。本文把它反向整理成“方法/路径/鉴权/请求/返回/错误”的表。你以后写新接口，最好反过来——**先写这张表，再写 handler 和前端**，这样契约不会漂移。
