# 校对台 · 内容审核平台开放接口文档

版本：v1.3（2026-10-28）
适用对象：内容生成平台 / 外部系统的后端开发者
Base URL：`https://b6adf368-758c-42a4-a8e1-9b7fe8f85d92.dev.coze.site`

> 本文档面向**第三方内容生成平台**接入审核流程的全部接口（文本送审 + Word 文件送审 + 进度查询 + 改稿重审）。
> WorkBuddy 侧 skill 开发者请使用《workbuddy-api.md》（含意图触发话术等 skill 专用约定）。
>
> 我方对接口径（2026-10-28 决策）：**平台仅输出审核意见，不改稿**——机审 `findings` 与人工驳回意见透传给改稿人，由我方改稿后 `resubmit` 重审直至通过；通过即锁定我方送审版本（实测 `approved` 返回体无审定文案）。

---

## 1. 平台能力与接入闭环

本平台提供「AI 机审 + 人工初审 + 终审」的三级内容审核服务。接入方将内容送入后，平台完成：

```
机审（规则要点库 + LLM 语义审查，数十秒）
  ├─ 高危风险 ≥1 → 拦截待修改（pending_revise），等接入方决策
  └─ 无高危     → 直接进入人工审核
人工审核（初审 → 视风险等级进入终审）
  → 通过锁定（approved，终态）/ 驳回（rejected，终态，可改稿重审）
```

标准接入闭环：

```
① POST /api/reviews/submit            文本送审（或 POST /api/reviews/upload 传 .docx）
        ↓ 拿到审核单号 review_no
② GET  /api/reviews/by-no/{reviewNo}  轮询进度，直到终态或待修改
        ↓
③ 分支处理：
   ├─ pending_revise（机审高危拦截）
   │    ├─ 改稿 → POST .../resubmit（版本+1，重走机审）
   │    └─ 接受风险 → POST .../proceed（进入人工审核）
   ├─ rejected（人工驳回）→ 改稿 → POST .../resubmit
   └─ approved（通过）→ 流程结束
```

---

## 2. 核心概念

| 概念 | 说明 |
|---|---|
| 审核单号 `review_no` | **对外唯一任务标识**，格式 `R+日期-时分秒`（如 `R20261023-165802`）。同一篇稿件无论重审多少次，单号不变；后续一切查询/操作以它为准 |
| 版本 `version` | 每次重审 +1（v1、v2……）。查询类接口永远只返回**最新版本** |
| 任务号 `task_no` | 业务标题。文本通道 = 正文提取标题（首行 ≤30 字取首行，否则取前 20 字）；Word 通道 = 文件名解析或显式传入。**同一任务号同一时刻只允许一单在途**（approved/rejected/superseded 之外的状态都算在途），重复送审返回 409 |
| 机审结果 `machine_result` | `pending` 待机审 / `all_clear` 全绿（零风险项）/ `has_risk` 有风险项 / `failed` 机审失败（自动降级按高风险走人工，不阻断单据） |
| 审核路径 `review_path` | 机审定线：`full` = 三级审核（初审+终审）、`simple` = 一级通过（初审通过即定稿）。**高危风险 ≥1 走 full 且先拦截待修改；中/低风险不拦截、走 simple 路径** |
| 状态 `status` | 状态机见下表，终态为 `approved` / `rejected` / `superseded` |

### 状态机

| status | status_label | 含义 | 接入方动作 |
|---|---|---|---|
| `pending_machine` | 待机审 | 已受理，排队机审 | 轮询 |
| `machine_reviewing` | 机审中 | 机审执行中（实测 11~25 秒） | 轮询 |
| `pending_revise` | 待修改 | **机审高危拦截**，等提交人决策 | 引导改稿重送（resubmit）或确认继续（proceed） |
| `pending_first` | 待初审 | 等待初审人认领 | 低频轮询或等通知 |
| `first_reviewing` | 初审中 | 初审人已认领 | 低频轮询或等通知 |
| `pending_final` | 待终审 | 初审通过，等待终审（仅 full 路径） | 低频轮询或等通知 |
| `final_reviewing` | 终审中 | 终审人已认领 | 低频轮询或等通知 |
| `approved` | 通过 | **终态**，内容锁定 | 流程结束 |
| `rejected` | 驳回 | **终态**，附结构化驳回意见 | 可改稿后 resubmit |
| `superseded` | 已被新版替代 | **终态**，待修改单重送后旧版本的状态（仅历史版本可见，正常不会遇到） | — |

### 通用约定

- 请求与响应均为 JSON（`Content-Type: application/json`；文件上传为 `multipart/form-data`），UTF-8
- 错误统一格式：`{"error": "中文错误描述"}`；HTTP 状态码：`400` 参数错误 / `404` 不存在 / `409` 业务冲突 / `500` 服务端错误
- **本期无鉴权**：提交人身份凭 `submitter` 字符串自证。请为每个真实用户传**稳定一致**的姓名/标识——它是"我的任务"查询与企微通知路由的依据
- 响应中的 `*_label` 字段为平台标准文案，建议直接向终端用户展示，不要自行另造
- 机审为**异步执行**：送审/重审响应拿到 `review_no` 即受理成功，不要在送审请求里同步等机审结果

---

## 3. 文本送审

`POST /api/reviews/submit`

将生成内容以纯文本送审。平台自动：提取标题作为任务号 → 转成 Word 文档归档 → 触发机审。

### 请求体

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `submitter` | string | 是 | 提交人姓名/标识（如 `张晓`） |
| `content_text` | string | 是 | 文章正文纯文本，**首行作为标题**参与提取。上限 100,000 字符 |
| `source` | string | 否 | 送审来源标识（如 `HiAi`），用于平台侧区分渠道、台账展示与对账；缺省记为 `WorkBuddy`。≤64 字符，仅取单行文本 |

### 请求示例

```bash
curl -X POST "$BASE/api/reviews/submit" \
  -H "Content-Type: application/json" \
  -d '{
    "submitter": "张晓",
    "content_text": "四季度债市展望\n债市进入震荡期，本产品力争稳健增值，历史业绩不代表未来……",
    "source": "HiAi"
  }'
```

### 成功响应 `200`

```json
{
  "review_no": "R20261023-165802",
  "version": 1,
  "status": "machine_reviewing",
  "status_label": "机审中"
}
```

### 错误

| 状态码 | 场景 | 响应示例 |
|---|---|---|
| 400 | 缺 submitter | `{"error": "submitter 必填"}` |
| 400 | 正文为空 | `{"error": "content_text 必填且不能为空"}` |
| 400 | 正文超长 | `{"error": "正文超长，上限 100000 字符"}` |
| 400 | 拆分超上限 | `{"error": "单次最多拆分 20 篇，当前识别出 21 篇"}` |
| 409 | 同标题稿件有在审单 | `{"error": "稿件「四季度债市展望」存在在审单据，如需修改请对该单重新送审", "existing_review_no": "R20261023-165802"}` |

> 409 冲突时请改用 `existing_review_no` 走「重新送审」，不要换标题绕开。

### 多文章拆分提审

当 `content_text` 含 **≥2 行连续空行**时，平台自动拆成多篇，**逐篇独立发号、独立机审**，每篇任务号 = 该篇标题。单次最多 20 篇。**整行仅含 ≥3 个重复分隔符**（如 `===`、`---`）的分隔符行按空行参与判定。

篇界规则：**只有 ≥2 行连续空行才是篇界；单个空行视为篇内段落间隔，不会拆**。无 ≥2 连续空行时维持单篇行为（响应为扁平结构，无 `multiple` 字段）。

**多篇成功响应 `200`**（部分篇失败时一并返回 `failures`）：

```json
{
  "multiple": true,
  "count": 2,
  "reviews": [
    {"review_no": "R20261023-100531", "version": 1, "task_no": "红利低波ETF投资指引", "status": "machine_reviewing", "status_label": "机审中"},
    {"review_no": "R20261023-100533", "version": 1, "task_no": "行业轮动量化月报", "status": "machine_reviewing", "status_label": "机审中"}
  ],
  "failures": [
    {"title": "重名文章", "error": "稿件「重名文章」存在在审单据，如需修改请对该单重新送审", "existing_review_no": "R20261023-100042"}
  ]
}
```

- 全部失败时返回 `409 {"error": "全部文章提审失败", "failures": [...]}`
- 每篇的后续查询/改稿与单篇完全一致（按各自 `review_no` 操作）

---

## 4. Word 文件送审

`POST /api/reviews/upload`

直接上传 `.docx` 文件送审。适合内容以 Word 形态产出、需要保留格式归档的场景。

### 请求（`multipart/form-data`）

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `file` | File | 是 | `.docx` 文件，≤ 20MB |
| `submitter` | string | 是 | 提交人姓名/标识 |
| `task_no` | string | 否 | 业务任务号；缺省时从文件名自动解析，解析失败返回 400 |
| `doc_version` | int | 否 | 文档版本号（1~99），用于文件名规范化 |
| `content_type` | string | 否 | 历史兼容字段；内容类型当前固定按「文案」入库 |

### 请求示例

```bash
curl -X POST "$BASE/api/reviews/upload" \
  -F "file=@四季度债市展望.docx" \
  -F "submitter=张晓" \
  -F "task_no=四季度债市展望"
```

### 成功响应 `200`（单篇）

```json
{
  "id": "8f170b20-4b7b-4ea3-87b7-58599939c67e",
  "review_no": "R20261023-165802",
  "parse_status": "ok",
  "task_no": "四季度债市展望",
  "file_name": "四季度债市展望-文案-20261023-v1.docx",
  "original_file_name": "四季度债市展望.docx"
}
```

| 字段 | 说明 |
|---|---|
| `parse_status` | `ok` 解析成功 / `failed` 解析失败（单据已受理，人工可见原文件；解析失败不阻断流程） |
| `file_name` | 平台规范化后的归档文件名 |

### 多文章拆分

Word 文档内 **≥2 个连续空段落**（按两次回车产生的空段落）会被拆成多篇，逐篇独立发号、独立机审，响应结构与文本通道多篇模式一致（`multiple: true` / `count` / `reviews[]` / `failures?[]`），差异点：

- 顶层额外返回 `original_file_name`（上传的原始文件名）
- `reviews[]` 每项额外返回 `id`（单据内部 ID）与 `file_name`（该篇规范化归档文件名）

### 错误

| 状态码 | 场景 | 响应示例 |
|---|---|---|
| 400 | 未选文件 | `{"error": "请选择要上传的文件"}` |
| 400 | 缺 submitter | `{"error": "请填写提交人"}` |
| 400 | 格式错误 | `{"error": "仅接受 .docx 格式的 Word 文件"}` |
| 400 | 文件超限 | `{"error": "文件大小不能超过 20MB"}` |
| 400 | 任务号识别失败 | `{"error": "未能从文件名识别任务号，请手动填写任务号"}` |
| 409 | 同任务号有在审单 | `{"error": "稿件「xxx」存在在审单据……", "existing_review_no": "...", "existing_id": "..."}` |

---

## 5. 进度查询（按单号）

`GET /api/reviews/by-no/{reviewNo}`

返回该单**最新版本**的完整进度。**建议轮询策略**：机审阶段每 10~15 秒一次；进入人工审核（`pending_first` 及以后）后停止高频轮询，改为按需查询或等企微通知。

### 成功响应 `200`

```json
{
  "review_no": "R20261023-165802",
  "version": 2,
  "status": "pending_revise",
  "status_label": "待修改",
  "review_path": "full",
  "review_path_label": "三级审核",
  "machine_result": "has_risk",
  "machine_risk_count": 6,
  "machine_high_count": 4,
  "findings": [
    {
      "severity": "high",
      "severity_label": "高风险",
      "category": "具体宣传用语",
      "rule_name": "[RULE-16] 不得使用承诺收益、保本类表述",
      "excerpt": "年化收益保底 8%，稳赚不赔",
      "description": "使用收益承诺与保本类表述，违反宣传用语禁令",
      "suggestion": "删除保底收益与稳赚表述，改为客观描述并补充风险提示"
    }
  ],
  "reject_level": null,
  "reject_level_label": null,
  "reject_type": null,
  "reject_detail": null,
  "first_opinion": null,
  "final_opinion": null,
  "exported": false,
  "updated_at": "2026-10-23T16:58:12.00+08:00"
}
```

### 字段说明

| 字段 | 说明 |
|---|---|
| `machine_risk_count` / `machine_high_count` | 机审风险点总数 / 其中高风险数。**high ≥1 → 拦截待修改 + 三级审核；high = 0 → 直接进人工（simple 路径一级通过）** |
| `findings` | 机审风险项明细数组（全绿时为空）。**待修改状态下必须向终端用户展示这些明细**，用户据此改稿或决策继续送审 |
| `findings[].severity` / `severity_label` | 风险等级：`high` 高风险 / `medium` 中风险 / `low` 低风险（中文标签可直接展示） |
| `findings[].category` | 风险分类（业绩登载 / 风险提示 / 具体宣传用语 / 事实信息核查 / 评价结果引用 / 基金经理宣传 / 其他） |
| `findings[].rule_name` | 命中的审核要点，形如 `[RULE-16] 不得使用承诺收益、保本类表述` |
| `findings[].excerpt` | 违规原文片段（逐字摘录，可用于在稿件中定位高亮） |
| `findings[].description` / `suggestion` | 违规原因说明 / 修改建议（直接透传给用户） |
| `review_path` | `full` 三级审核 / `simple` 一级通过；机审完成前为 `null` |
| `reject_level` | 驳回发生层级：`first` 初审 / `final` 终审；未驳回为 `null` |
| `reject_type` | 驳回类型：`违规表述` / `事实错误` / `文案质量` / `其他` |
| `reject_detail` | 驳回详情（人工填写的结构化意见原文，直接透传给用户） |
| `first_opinion` / `final_opinion` | 初审 / 终审意见原文 |
| `exported` | 是否已在平台导出过审版 |

### 错误

| 状态码 | 场景 | 响应示例 |
|---|---|---|
| 404 | 单号不存在 | `{"error": "审核单不存在"}` |

---

## 6. 我的任务（提交人维度列表）

`GET /api/reviews/mine?submitter={姓名}`

返回该提交人的全部审核单（**每单仅最新版本**），按提交时间倒序。

### 成功响应 `200`

```json
{
  "tasks": [
    {
      "id": "8f170b20-4b7b-4ea3-87b7-58599939c67e",
      "review_no": "R20261023-165802",
      "task_no": "四季度债市展望",
      "version": 2,
      "status": "approved",
      "status_label": "通过",
      "machine_result": "has_risk",
      "machine_risk_count": 3,
      "machine_high_count": 0,
      "excerpt": "四季度债市展望 债市进入震荡期，本产品力争稳健增值，历史业绩不……",
      "reject_type": null,
      "reject_detail": null,
      "updated_at": "2026-10-23T17:31:02.00+08:00"
    }
  ]
}
```

| 字段 | 说明 |
|---|---|
| `id` | 单据内部 ID（当前版本） |
| `task_no` | 任务号（业务标题） |
| `machine_result` | 最新版机审结果：`pending` / `all_clear` / `has_risk` / `failed` |
| `machine_risk_count` / `machine_high_count` | 最新版机审风险点总数 / 其中高风险数（列表页可直接展示，无需逐单调进度查询） |
| `excerpt` | 正文前 50 字摘要（空白归一化），超长以 `……` 结尾 |

### 错误

| 状态码 | 场景 | 响应示例 |
|---|---|---|
| 400 | 缺 submitter | `{"error": "submitter 必填"}` |

---

## 7. 确认继续送审（机审高危拦截后）

`POST /api/reviews/by-no/{reviewNo}/proceed`

机审发现高危风险（`machine_high_count ≥ 1`）时，单据停在 `pending_revise` 等提交人决策：

- **改稿重送（推荐）**：按风险项与修改建议改稿后走第 8 节 resubmit，版本 +1 重走机审
- **确认继续送审**：确认内容无误、接受风险，调用本接口，单据立即进入 `pending_first`（待初审），版本不变

无请求体。

### 成功响应 `200`

```json
{
  "review_no": "R20261023-165802",
  "status": "pending_first",
  "status_label": "待初审"
}
```

### 错误

| 状态码 | 场景 | 响应示例 |
|---|---|---|
| 404 | 单号不存在 | `{"error": "审核单不存在"}` |
| 409 | 当前非待修改状态 | `{"error": "仅待修改状态的单据可确认继续送审"}` |

> 无高危（全绿或仅中/低危）的单据定线后直接进入待初审，不存在待修改状态，无需也无法调用本接口。

---

## 8. 重新送审（驳回/待修改后改稿）

`POST /api/reviews/by-no/{reviewNo}/resubmit`

仅当最新版本为 `rejected`（人工驳回）或 `pending_revise`（机审高危拦截）时可调用。版本 +1，任务号锚定原单不变，历史版本与全部审核记录保留，新版本重走机审与人工审核。待修改单重送后，旧版本状态变为 `superseded`，原稿与机审报告完整留痕。

### 请求体

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `submitter` | string | 是 | 提交人姓名/标识 |
| `content_text` | string | 是 | 修改后的**完整正文**（整体替换，非增量、非 diff）。**重审不做多文章拆分**——即使原单来自拆分，重审正文也应只是该篇自身内容 |

### 成功响应 `200`

```json
{
  "review_no": "R20261023-165802",
  "version": 2,
  "status": "machine_reviewing",
  "status_label": "机审中"
}
```

### 错误

| 状态码 | 场景 | 响应示例 |
|---|---|---|
| 400 | 参数缺失/为空/超长 | 同送审接口 |
| 404 | 单号不存在 | `{"error": "审核单不存在"}` |
| 409 | 最新版非驳回/待修改 | `{"error": "仅驳回或待修改状态的单据可重新送审"}` |
| 409 | 重复提交（并发） | `{"error": "该单据已有进行中的重送版本，请勿重复提交"}` |

---

## 9. 结果通知（企微主动推送，可选）

平台已接入企业微信主动通知。接入方用户满足以下**两个前提**即可收到推送：

1. 提交人署名（`submitter`）已在平台「通知设置」中绑定企微 userid（由平台管理员维护）
2. 该用户与平台的企微机器人有过会话（在企微里给机器人发过至少一条消息）——企微限制机器人只能主动推给聊过天的用户

| 事件 | 推送给 | 内容 |
|---|---|---|
| 机审高危拦截（待修改） | 提交人 | 单号 + 任务号 + 高危风险摘要与修改建议（前 3 条）+ 详情链接 |
| 机审定线完成（待初审） | 全体初审人 | 单号 + 任务号 + 机审风险摘要 + 工作台链接 |
| 初审通过（待终审） | 全体终审人 | 单号 + 任务号 + 工作台链接 |
| 通过锁定 | 提交人 | 单号 + 任务号 + 详情链接 |
| 驳回 | 提交人 | 单号 + 驳回级别/类型/详情 + 详情链接 |

未绑定的提交人不会收到推送（平台留痕 skipped），接入方仍应以进度查询接口为准。**建议**：通知是增强体验，不要把通知作为唯一结果通道。

---

## 10. 接入最佳实践

1. **幂等与 409 处理**：同任务号在途查重是强约束。收到 409 时读取 `existing_review_no` 改走 resubmit 链路，切勿改标题重发
2. **轮询节奏**：机审 10~15s/次，进入人工后停止高频轮询；人工审核时长不可预估（分钟~小时级）
3. **状态驱动 UI**：以 `status` + `status_label` 为准做状态展示；`pending_revise` 是本平台特有的交互态，务必实现"改稿重送 / 确认继续"两个分支
4. **多文章响应**：以 `reviews` 数组逐篇跟踪；`failures` 中的篇目未受理，需处理后重送
5. **submitter 稳定性**：同一用户前后传值必须一致（影响"我的任务"与通知路由）；建议接入方用自己系统的用户标识映射后传入
6. **机审故障容错**：`machine_result = failed` 时机审自动降级为"按高风险走人工"，单据不阻断，接入方无需特殊处理
7. **风险项明细**：进度查询接口的 `findings` 返回完整机审风险项（等级/分类/命中要点/原文摘录/违规原因/修改建议）——待修改与驳回场景请完整透传给终端用户，这是改稿的依据

---

## 11. 联调 Checklist

- [ ] 单篇文本送审 → 拿到 `review_no` → 轮询至终态/待修改
- [ ] 含高危违规的稿件 → 确认停在 `pending_revise`，proceed 后进入 `pending_first`
- [ ] `pending_revise` 单 resubmit → 版本 +1，旧版查询不可见（只返回最新版）
- [ ] 同标题重复送审 → 收到 409 且能读出 `existing_review_no`
- [ ] 多文章（≥2 空行分隔）→ `multiple: true` 逐篇发号
- [ ] 异常路径：空正文 / 超长正文 / 错误单号 / 非待修改单调 proceed → 错误文案符合本文档

---

## 变更记录

| 版本 | 日期 | 说明 |
|---|---|---|
| v1.0 | 2026-10-23 | 首版：面向通用内容生成平台的接入文档（文本/Word 双通道送审、进度查询、待修改双分支、改稿重审、企微通知、最佳实践） |
| v1.1 | 2026-10-23 | 进度查询（第 5 节）新增 `findings` 机审风险项明细数组（等级/分类/命中要点/原文摘录/违规原因/修改建议），待修改与驳回场景可直接透传用户 |
| v1.3 | 2026-10-28 | Base URL 写入文档；送审新增 `source` 来源标识（缺省记 `WorkBuddy`）；「我的任务」新增 `id`/`task_no`/`machine_result`/`machine_risk_count`/`machine_high_count`；Word 多篇拆分响应差异说明 |
