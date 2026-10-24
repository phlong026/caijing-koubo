# 2026-10-24 跨模块联合测试（联动链路贯通）

## 目的与范围

此前七套冒烟均为"各模块独立环境内的垂直链路"，不存在一条数据从选题贯通到发布的端到端测试。
本次新增 `smoke:chain`（`server/scripts/smoke-chain.ts`）：**同一条数据**依次经过全部已交付模块，
以任务中心为最终验收视图，验证模块交接契约而非模块内部细节。

覆盖模块：人物库 → 爆款选题（资讯/生成/送入）→ 文案工坊（写稿/审核链三关+人工）→
视频创作（口播 completed）→ 视频剪辑（渲染 v1 + 成片复审）→ 发布管理（消费过审成片 → published）→ 任务中心（五节点聚合）。

未覆盖（属既有边界，非本次范围）：真实渲染（本机 ffmpeg 缺 libass/freetype，剪辑引擎自动降级 mock）、
真实平台发布（Playwright 四平台未平移）、前端 UI 层（e2e 仍仅人物库）、真实第三方（飞影/LLM/资讯全 mock）。

## 链路与关键交接点断言

1. **人物满配**（mock 克隆）：授权上传+核验 → 素材审核 → 双 consent → 分身/声音克隆 ready → 设默认。
2. **选题→文案**：资讯入库 → `/topics/generate` 批次 done → 候选 assigned 绑定人物 → `/topics/send`
   → copy 按 topic×persona 展开、回链 `topic_id`、`source_ref_type='news_item'` 带 `source_text` → 送入即有初始稿。
3. **文案过审**：保存 → 提交 → 审核链三关至 pending_manual → reviewer 人工通过 → `GET /copy/{id}/approved` 200。
4. **文案→视频**：`source=news` 的过审文案创建口播任务 → sweep 至 completed（此前只有 manual 来源文案验证过此路）。
5. **视频→剪辑**：cut-config 默认草稿（versionNo=0）+ base 时间轴 → 存草稿（normal 段编辑 + 剪气口）→
   渲染 v1（is_mock=1）→ 复审 pending_manual → reviewer 通过 → `final` 契约（videoJobId/versionNo=1/approved）。
6. **剪辑→发布**：建号自动登录 active → 建计划**缺省 videoJobId** → 断言消费过审成片（`baseVideoVersionNo=1`、
   `reviewState='none'`）→ execute-now → publish_log `published` + video_url → 计划收敛 completed。
7. **任务中心**：列表中找到本条数据的任务树，五节点 statusKey 依次为
   `topic:done / copy:approved / base_video:completed / edit:cut_approved / publish:published`；
   任务级 `status='completed'`、`needAttention=false`、`stage=publish`；详情时间线覆盖
   任务创建/审核通过/基础视频生成完成/成片渲染+复审通过/发布成功；chips 四段齐全。

## 结果

- **48/48 全绿**（`npm run smoke:chain`，隔离环境：临时 SQLite + 内存队列 + 全 mock）。
- 未发现跨模块契约缺陷。此前评估中担心的三个交接点（选题来源文案进视频创作、
  发布缺省消费过审成片、任务中心跨表聚合）均验证通过。

## 过程中发现的两个问题（均为测试侧，非产品缺陷）

1. `bootIsolated` 不执行 `index.ts` 启动序列，发布模块的 execute worker / sweep 未注册，
   `execute-now` 入队的任务无人消费、发布停在 scheduled——`smoke-publish.ts` 已有手动
   `registerPublishModule()` 的先例，`smoke-chain` 照此装配解决。
2. 任务中心时间线基础视频完成事件的 label 是「生成完成」而非「已完成」（断言文案修正）。

## 后续接入

- `smoke:chain` 已注册进 `package.json` 并加入 `smoke:all` 默认八套（随 CI 运行）；
  `run-smoke-all.ts` 头部过时的"四套"注释已同步修正。
- 运行一次约 2 分钟（含 mock 克隆轮询、视频 sweep、渲染 sweep 与发布 sweep 等待）。

## 验证边界

全部第三方（飞影、LLM、资讯源、发布引擎、OSS）为 mock；数据库为临时 SQLite、队列为内存队列。
通过仅证明业务流转与状态机正确，不证明真实渲染效果与真实平台发布成功率——
后者待 libass 环境与 Playwright 四平台平移（发布任务书 PU2/PU3/PU9）后另行验收。
