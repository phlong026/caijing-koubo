# 校对台 · 内容审核平台开放接口文档

> 版本：v1.1（2026-10-23）｜来源：对方提供的 integration-api.md（2026-10-27 用户粘贴，**当前仅含第 1~3 节**，第 4 节起待补）
> 适用对象：内容生成平台 / 外部系统的后端开发者

本文档面向第三方内容生成平台接入审核流程的全部接口（文本送审 + Word 文件送审 + 进度查询 + 改稿重审）。

## 1. 平台能力与接入闭环

本平台提供「AI 机审 + 人工初审 + 终审」的三级内容审核服务：

```text
机审（规则要点库 + LLM 语义审查，数十秒）
  ├─ 高危风险 ≥1 → 拦截待修改（pending_revise），等接入方决策
  └─ 无高危     → 直接进入人工审核
人工审核（初审 → 视风险等级进入终审）
  → 通过锁定（approved，终态）/ 驳回（rejected，终态，可改稿重审）
```

标准接入闭环：

```text
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

## 2. 核心概念

| 概念 | 说明 |
|---|---|
| 审核单号 review_no | 对外唯一任务标识，格式 R+日期-时分秒（如 R20261023-165802）。同一篇稿件无论重审多少次，单号不变；后续一切查询/操作以它为准 |
| 版本 version | 每次重审 +1（v1、v2……）。查询类接口永远只返回最新版本 |
| 任务号 task_no | 业务标题。文本通道 = 正文提取标题（首行 ≤30 字取首行，否则取前 20 字）；Word 通道 = 文件名解析或显式传入。同一任务号同一时刻只允许一单在途（approved/rejected/superseded 之外的状态都算在途），重复送审返回 409 |
| 机审结果 machine_result | pending 待机审 / all_clear 全绿 / has_risk 有风险项 / failed 机审失败（自动降级按高风险走人工，不阻断单据） |
| 审核路径 review_path | full = 三级审核（初审+终审）、simple = 一级通过。高危 ≥1 走 full 且先拦截待修改；中/低风险不拦截、走 simple |
| 状态 status | 见下表，终态为 approved / rejected / superseded |

### 状态机

| status | status_label | 含义 | 接入方动作 |
|---|---|---|---|
| pending_machine | 待机审 | 已受理，排队机审 | 轮询 |
| machine_reviewing | 机审中 | 机审执行中（实测 11~25 秒） | 轮询 |
| pending_revise | 待修改 | 机审高危拦截，等提交人决策 | 改稿重送（resubmit）或确认继续（proceed） |
| pending_first | 待初审 | 等待初审人认领 | 低频轮询或等通知 |
| first_reviewing | 初审中 | 初审人已认领 | 低频轮询或等通知 |
| pending_final | 待终审 | 初审通过，等待终审（仅 full 路径） | 低频轮询或等通知 |
| final_reviewing | 终审中 | 终审人已认领 | 低频轮询或等通知 |
| approved | 通过 | 终态，内容锁定 | 流程结束 |
| rejected | 驳回 | 终态，附结构化驳回意见 | 可改稿后 resubmit |
| superseded | 已被新版替代 | 终态，仅历史版本可见 | — |

### 通用约定

- JSON（文件上传为 multipart/form-data），UTF-8
- 错误统一格式：`{"error": "中文错误描述"}`；400 参数错误 / 404 不存在 / 409 业务冲突 / 500 服务端错误
- **本期无鉴权**：提交人身份凭 `submitter` 字符串自证，需为每个真实用户传稳定一致的标识（"我的任务"查询与企微通知路由依据）
- `*_label` 为平台标准文案，建议直接展示
- 机审异步：送审/重审拿到 review_no 即受理成功，不要同步等机审结果

## 3. 文本送审

`POST /api/reviews/submit` —— 平台自动提取标题作为任务号 → 转 Word 归档 → 触发机审。

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| submitter | string | 是 | 提交人姓名/标识 |
| content_text | string | 是 | 正文纯文本，首行作为标题参与提取。上限 100,000 字符 |

成功 200：

```json
{ "review_no": "R20261023-165802", "version": 1, "status": "machine_reviewing", "status_label": "机审中" }
```

错误：

| 状态码 | 场景 | 响应示例 |
|---|---|---|
| 400 | 缺 submitter | `{"error": "submitter 必填"}` |
| 400 | 正文为空 | `{"error": "content_text 必填且不能为空"}` |
| 400 | 正文超长 | `{"error": "正文超长，上限 100000 字符"}` |
| 400 | 拆分超上限 | `{"error": "单次最多拆分 20 篇，当前识别出 21 篇"}` |
| 409 | 同标题有在审单 | `{"error": "稿件「…」存在在审单据，如需修改请对该单重新送审", "existing_review_no": "R20261023-165802"}` |

409 时改用 `existing_review_no` 走重新送审，不要换标题绕开。

### 多文章拆分提审（接入注意）

`content_text` 含 **≥2 行连续空行**（或整行仅 ≥3 个重复分隔符如 `===`、`---`）时平台会自动拆成多篇，逐篇独立发号；响应变为 `{"multiple": true, "count", "reviews": [...], "failures": [...]}`。单个空行不拆。

> 接入方送单篇文案时必须把连续空行压成单个空行、去掉纯分隔符行，否则一篇口播会被拆成多张审核单。

## 4. 及以后章节

（Word 上传、进度查询 by-no 响应结构、resubmit / proceed 请求体等——待对方文档补齐）
