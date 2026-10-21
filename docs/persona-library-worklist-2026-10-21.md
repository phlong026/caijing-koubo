# 人物库模块 · 剩余工作清单（2026-10-21）

对照《人物库模块-需求与开发任务书-v1.0》§5 / §6 / §8 / §9 与当前代码（master `e8b2330` 之后）逐项核对。状态列在每项完成后回写。

## 0. 现状结论

| 范围 | 结论 |
|---|---|
| 后端 API（§5.1 共 50 个接口） | 全部已实现，逐条与路由表比对无缺失 |
| 后端模块 PL0~PL5 | 已实现；本轮在真实 MySQL / BullMQ / OSS 协议下实测，发现并修复 5 处缺陷（见 §1） |
| 前端 PL6 / PL7 | **未开发**：`PeopleLibrary.vue` 仍是 180 行静态原型并引用 `mocks/data.ts` 的 `people`；`api/personas.ts`（361 行）与 `stores/personas.ts` 已就绪但页面未接 |
| 自动化验收（§9） | `smoke-personas` 99 项只覆盖主链路；AC-L2/L4/L6、I2/I3、A1/A5/A6、C1/C2/C4~C7、V2/V3/V5/V6/V8、U4~U7、场景 3~7 缺断言 |
| 文档（§9.11 DoD） | 任务书未升 v1.1；§0.3 复用清单未标注；§12 对其他文档的同步未做 |

## 1. 本轮已完成：真实服务接通（基础设施）

| # | 事项 | 状态 | 说明 |
|---|---|---|---|
| I1 | MySQL 8 实跑迁移 | ✅ | 32 张表建立成功，重复执行幂等 |
| I2 | MySQL 下全部 smoke | ✅ | 修复 `JSON` 列被驱动自动解析导致的 4 处 `JSON.parse` 缺陷；其中 `seedPersonaExtensions` 会在 MySQL 上**覆盖示例人物的 `ip_profile`**（数据损坏） |
| I3 | Redis / BullMQ 实跑 | ✅ | 修复克隆轮询在 BullMQ 下「运行期间用同一去重键重入队被丢弃」导致轮询链断裂 |
| I4 | OSS 协议路径 | ✅（仿真） | 修复 `getObjectStream` 误用 `get()`、签名 URL 误走内网、大文件整体读内存；新增 `OSS_ENDPOINT / OSS_CNAME / OSS_SIGN_ENDPOINT / OSS_MULTIPART_THRESHOLD_MB`；**沙箱无法访问 aliyuncs.com，真实桶联调需在有网络和 AK 的环境执行 `npm run test:oss:real`** |
| I5 | 集成测试补入人物库 | ✅ | `test:integration`（SQLite + 内存队列）、`test:integration:real`（MySQL + Redis）、`--oss`（OSS 仿真）均跑四套 smoke，含 `smoke-personas` |
| I6 | 修正已漂移的既有断言 | ✅ | `smoke-topics` / `smoke-copy` 对 `PERSONA_NOT_FOUND`（404）与 `{items,total}` 的旧假设；`smoke-topics` 提前返回时退出码为 0 的缺陷 |

## 2. 待开发清单

### B. 后端验收缺口（自动化）

| # | 内容 | 对应验收 | 状态 |
|---|---|---|---|
| B1 | 验收脚本框架：进程内启动服务（可注入飞影 mock 故障），支持 SQLite / `--real` / `--oss` | §9 全部 | ⬜ |
| B2 | 人物与列表：三线计数、`%` `_` 字面匹配、重名（全半角 / 首尾空白）、归档后可重名、改线被拒、停用联动（选题分配 / 文案预检）、启用缺项 409 | AC-L1/L2/L4 | ⬜ |
| B3 | IP 定位：超长 / 控制字符 400、配比合计校验、禁用表达立即生效 | AC-I2/I3/I5 | ⬜ |
| B4 | 素材样例集：伪造扩展名、截断文件、超限、最短边 <720、EXIF 旋转、重复上传、软删后重传；分身素材时长不足 / 无视频流 / 素人线拒绝；驳回须原因；未审核不可封面 / 制作；Range 206；响应不含存储路径；`original` 记敏感审计；数量上限 | AC-A1~A6 | ⬜ |
| B5 | 分身：无授权 / consent 不符、幂等只调一次 `create_by_video`、业务码 1011 / 1002、不确定态与核对（含只调一次创建）、默认分身约束与软删、`api_call_log` 不含签名 URL | AC-C1~C7 | ⬜ |
| B6 | 声音：样本边界、授权与 consent、幂等、参数范围与「先飞影后本地」、试听缓存、共享授权、不确定态 | AC-V1~V8 | ⬜ |
| B7 | 授权与绑定：到期读时派生（不跑定时任务）、30 天提醒去重、经理 / KOS / 素人绑定规则、敏感访问审计、素人免授权 | AC-U2~U6 | ⬜ |
| B8 | `policy.ts` §3.2 全分支与质检纯函数单测，纳入 `npm run check` | AC-U7、AC-0.2 | ⬜ |
| B9 | 联调场景 3（授权失效联动）、4（不确定态防重复扣费与重启）、5（飞影错误可读）、6（线规则）、7（审计与脱敏） | §9.10 | ⬜ |
| B10 | 性能：500 人 `GET /personas` P95 < 300ms，无 N+1，记录实测 | AC-L6 | ⬜ |

### C. 前端（PL6 / PL7，任务书 §6）

| # | 内容 | 对应验收 | 状态 |
|---|---|---|---|
| C1 | `PeopleLibrary.vue` 改为编排层：页头（积分 / 提醒 badge / 新增）、线 Tab 计数、状态筛选、搜索、卡片网格、右侧详情；去掉「演示数据」与「原型预览」字样 | AC-F1/F2 | ⬜ |
| C2 | `PersonaCardGrid`、`PersonaDetailPanel`、启停 / 归档（缺项清单、阻断原因） | AC-F4/F5 | ⬜ |
| C3 | `ProfileTab`：IP 定位表单、内容配比、折叠区文案人设、脏态保存、冲突「载入最新」、归属 / 可用范围 / 授权入口 | AC-F3 | ⬜ |
| C4 | `PhotoTab` + `BackgroundTab`：上传进度与处理中轮询、审核 / 驳回 / 封面 / 删除、标签编辑 | AC-F6 | ⬜ |
| C5 | `AvatarTab` + `AvatarCloneDialog`：素材与飞影分身两区、制作弹窗（授权 + 确认文本 + 幂等键防重复）、不确定态只给「核对状态」、失败业务码说明 | AC-F7 | ⬜ |
| C6 | `VoiceTab` + `VoiceCloneWizard`：三步向导、试听 / 确认 / 参数滑杆 / 任意文本试听 / 设默认 | AC-F8 | ⬜ |
| C7 | `AuthorizationDrawer`、`AccountBindingDialog`、`PersonaFormDialog`、`VersionDrawer`；素人线空态 | AC-F9/F10 | ⬜ |
| C8 | 选题 / 文案 / 对标送入的人物下拉：不可用人物置灰并显示原因；删除 `mocks/data.ts` 的 `people` | AC-X6、AC-F1 | ⬜ |
| C9 | 前端构建 `vue-tsc` + `vite build`；浏览器实测；控制台 0 error | §9.10 场景 8 | ⬜ |

### D. 文档与收尾

| # | 内容 | 状态 |
|---|---|---|
| D1 | 任务书升 v1.1：回写评审决策、§0.3 复用清单标注「已复用 / 自研」、验收勾选与联调记录 | ⬜ |
| D2 | §12 同步：《技术方案》2.1 / 2.3、《爆款选题》D13、《文案工坊》§4.3 / FR-R3⑤ | ⬜ |
| D3 | 飞影探活报告模板与 `docs/` 记录位（真实结果待账号） | ⬜ |

### E. 需要外部条件，无法在当前沙箱完成

| # | 事项 | 阻塞原因 | 到位后执行 |
|---|---|---|---|
| E1 | 真实阿里云 OSS 联调 | 沙箱不能访问 `aliyuncs.com`，也没有 AccessKey | 配置 `OSS_*` 后 `npm run test:oss:real` |
| E2 | 真实飞影探活（AC-H5）、场景 1 真实一次 | 缺 `HIFLY_API_KEY`，并会消耗积分，须先与你确认 | `test-hifly.ts` 探活（尚未编写，随 D3 提供脚本骨架） |
| E3 | 生产 MySQL / Redis 实例验证 | 本轮用本地 MySQL 8.0.46 与 Redis 7.0.15 验证，生产实例参数（字符集、sql_mode、连接数）需复核 | 在生产同版本实例跑 `npm run migrate` 与 `npm run test:integration:real` |
| E4 | 授权确认文本 v1 法务确认（Q12）、Q1~Q11 评审拍板 | 需要业务 / 合规决策 | 评审后回写 v1.1 |
| E5 | 人工验收项 AC-F2~F10、AC-X6、AC-0.6 | 需真人在浏览器逐项核对并签字 | 提供验收清单与截图 |
