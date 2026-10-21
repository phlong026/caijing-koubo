# 人物库模块 · 真实服务接通与验收记录（2026-10-21）

范围：本地 MySQL 8.0.46 / Redis 7.0.15（BullMQ）真实实例接通；OSS 协议路径验证；人物库补入集成测试；验收缺口补测；前端 PL6 / PL7 开发与浏览器实测。
环境：Linux 容器，Node 22；沙箱无法访问 `aliyuncs.com`，**没有真实 OSS / 飞影账号**，对应部分用本地协议仿真 / mock 验证，结论见 §4。

## 1. 验证矩阵

| 验证项 | 命令 | 结果 |
|---|---|---|
| 静态与单元 | `cd server && npm run check` | typecheck、MySQL DDL 1054 项、DDL 自检 8/8、飞影协议 20、**人物 policy / 质检 / 禁用词 109**、**OSS 接入 39**、资讯清洗 31 + 28、评审回归 9 组，全部通过 |
| 集成（SQLite + 内存队列） | `npm run test:integration` | smoke 44 + topics 25 + copy + **personas 99**，全绿 |
| 集成（**真实 MySQL + Redis/BullMQ**） | `npm run test:integration:real` | 同上四套，全绿；临时库与 Redis 键测完清理 |
| 集成（OSS 协议路径） | `npm run test:integration -- --oss` | 素材经 put / getStream / 签名 URL 全链路，仿真端 0 次被拒 |
| 人物库验收（§9 缺口） | `npm run test:personas:acceptance` | **SQLite 与 `--real --oss`（真实 MySQL + Redis + OSS 仿真）各完整跑一遍（B2–B11：237 项通过 + 1 项我写错的期望值，修正后 B10 单独复跑通过 → 238 项；B12 另跑 5 项通过）**；B10：500 人 `GET /personas` P95 ≈ 30–45ms，原 415ms；见 §2 |
| 前端构建 | `cd frontend && npm run build` | `vue-tsc` + Vite 通过 |
| 浏览器实测 | `npm run e2e:people`（Playwright，Chromium，1440 / 1280 / 1024），最新后端上复跑 | 32 项全过，覆盖新建 / 重名 / 定位保存 / 授权 / 照片 / 分身 / 声音向导 / 试听 / 绑定 / 启停 / 搜索 / 素人空态 / 响应式 / 控制台 0 error |

## 2. 验收脚本覆盖（`scripts/test-personas-acceptance.ts`，进程内，可注入飞影故障）

| 节 | 覆盖 AC | 要点 |
|---|---|---|
| B2 | L1~L5 | 三线计数、`%` `_` 字面匹配、全半角 / 空白 / 大小写重名、归档后可重名、改线被拒、同 rev 冲突、停用联动（选题 / 文案 / 预检 ⑤）、启用缺项 409、审核中文案阻断归档、归档后写接口被拒 |
| B3 | I2 / I3 / I5 | 长度与控制字符、内容方向 / 配比上限与合计 100、禁用表达保存后立即进入合规扫描与预检 |
| B4 | A1~A6 | 伪造扩展名 / 魔数 / 截断 / 超限 / 最短边 / EXIF 方向、去重与软删重传、分身素材时长 / 无视频流 / 横屏软提示 / 素人拒绝、驳回须原因、未审核不可封面或制作、Range 206 与字节正确、原件读取记审计、背景标签与数量上限 |
| B5 | C1~C7 | 授权范围 / consent 版本 / 素材不符、幂等并发只调 1 次 `create_by_video`、1011 / 1002 业务码、uncertain（未受理 / 受理但响应丢失）核对、重启不重提、默认分身与软删、`api_call_log` 留痕与脱敏 |
| B6 | V1~V8 | 样本边界、授权与 consent、幂等、参数范围与「先飞影后本地」、试听缓存、共享授权、uncertain 核对 |
| B7 | U1~U7、场景 3 | 读时到期（不跑定时任务）、30 天提醒去重与已读、经理 / KOS / 素人绑定规则、敏感访问审计、授权续期后恢复 |
| B9 | 场景 5~7 | 飞影错误码可读、线规则、审计与脱敏 |
| B10 | L6 | 500 人列表 / 详情延迟 |

## 3. 验证中发现并修复的缺陷

接通真实服务和补测之前，仓库的 smoke 全绿；下列问题都是在真实 MySQL / BullMQ / 浏览器 / 补充验收下才暴露的。

### 3.1 后端

| # | 缺陷 | 影响 | 修复 |
|---|---|---|---|
| 1 | MySQL 的 `JSON` 列被 mysql2 自动解析为对象，多处 `JSON.parse(对象)` 抛错被 `catch` 吞掉；其中 `seedPersonaExtensions` 随后用空对象**覆盖了示例人物的 `ip_profile`** | MySQL 上迁移会丢示例人物角色 / 受众 / 风格；选题批次 `produced=expected` 仍被判 failed；稿件分段 / 提纲读取失败 | 统一改用 `jdec`；`pairKey`、`sections`、`outline`、`sentences`、种子全部修复 |
| 2 | 克隆轮询在**运行期间用同一去重键**重入队，BullMQ 当作重复丢弃 | 真实 Redis 下轮询链断裂，分身 / 声音 / 试听永远停在制作中（内存队列掩盖） | 去重键并入轮询序号 |
| 3 | OSS `getObjectStream` 用 `client.get()`，`res.res` 不是流 | 真实 OSS 下素材处理 / 克隆取件会抛错或挂起 | 改 `getStream`，处理 404 / 416 |
| 4 | `OSS_INTERNAL=true` 时签名 URL 也走内网域名 | 飞影无法自取素材 | 签名客户端固定公网；新增 `OSS_SIGN_ENDPOINT` / `OSS_ENDPOINT` / `OSS_CNAME` |
| 5 | OSS `put` 把整个文件读进内存 | 200MB 分身素材内存峰值过大 | 超阈值走分片上传 |
| 6 | `policy.deriveStatus` 在已排除 `revoked` 的列表里再找 `revoked` | **「授权已撤销」永远不会出现**，撤销后显示成「待核验」 | 从全量授权判定；补单测 |
| 7 | `claimsToWords` 要求「整句不同于去前缀后」才保留 | **最常见的写法——禁用词本身（如“稳赚不赔”）从不参与合规扫描** | 保留整词；补单测与验收 |
| 8 | 启用前检查拿「当前已停用」当作缺项 | 停用后的人物**无法再启用** | 按「启用后」状态判定 |
| 9 | `PATCH` 带 `line` 被静默忽略 | 改线看似成功实则无效 | 显式 400 |
| 10 | 重名响应不带已有人物 | 前端无法提示是哪一个 | 返回 `existingId / existingName` |
| 11 | **素材 / 授权文件 / 试听文件读取接口返回 0 字节**：async 处理函数里 `reply.send(stream)` 后返回 `undefined`，Fastify 又以空载荷发送一次 | **页面上所有缩略图、分身封面、试听音频都是空的**；smoke 只断言了状态码 | 返回 `reply`；smoke 增加真实字节断言 |
| 12 | 超限上传在服务端读到上限时立即断流 | 客户端拿到 `fetch failed`，看不到 413 提示 | 停止落盘但继续读完丢弃（需 `resume()`）再返回 413 |
| 13 | 授权按「创建时那一份」绑定到分身 / 声音 | 授权续期（新授权）后旧分身永远不可用，场景 3 无法恢复 | 使用阶段改为「任一有效授权覆盖该范围」 |
| 14 | 过期原因不含到期日期 | 违反 AC-U2 | 文案带日期 |
| 15 | 「已配置」附加标签从未被计算 | 卡片永远没有该状态（§3.2） | `decoratePersona` 回填 |
| 16 | uncertain 状态删除返回通用 `invalid_state` | 与规格 `CLONE_UNCERTAIN` 不符 | 改用规格错误码 |
| 17 | `vendorErrorOf` 厂商原话优先于本地中文映射 | 业务码 1002 等显示为厂商英文 / 原话 | 已知码用中文映射，原话进 `details.vendorMessage` |
| 18 | mock 飞影客户端不写 `api_call_log`；故障注入器第二次注入永不触发 | AC-C7 无法验证；多场景测试失真 | 补日志代理；重写注入队列；新增 `uncertain_accepted` |
| 19 | `test-integration` 未注册人物库 worker；`smoke-topics` / `smoke-copy` 沿用旧断言；`smoke-topics` 失败时退出码仍为 0 | `npm run test:integration` 在当前 master 上已有 2 处失败且漏报 | 全部修复 |

### 3.2 前端

| # | 缺陷 | 修复 |
|---|---|---|
| 1 | Arco `@ok` 不等待异步，点「创建」弹窗立即关闭，重名 / 校验错误提示丢失 | 全部改 `:on-before-ok` |
| 2 | `a-input` 的 `aria-label` 挂在外层 `span`，真正的 `<input>` 无无障碍名称 | 改 `input-attrs`（`a-input-tag` 不支持，保留根节点标签） |
| 3 | `a-empty` 放了默认插槽后 `description` 不显示，空状态只剩按钮 | 文案放入插槽 |
| 4 | 选题 / 文案的人物下拉直接**隐藏**不可用人物 | 置灰并写明原因（FR-X7） |
| 5 | `mocks/data.ts` 残留 `people` / `Person` | 删除 |

## 4. 仍无法在本环境证明的部分

| 项 | 原因 | 到位后 |
|---|---|---|
| 真实阿里云 OSS | 沙箱到 `aliyuncs.com` 不通、无 AccessKey；仿真验证了 ali-oss 路径与签名，但**不代表**真实桶的权限 / CORS / 内网域名 | `npm run test:oss:real` |
| 真实飞影账号 | 无 `HIFLY_API_KEY`；探活脚本已就绪（默认零积分，`--spend` 才会克隆） | `npm run test:hifly`，结果回写任务书 §10 / §11 |
| 生产形态 MySQL / Redis | 本地为单机实例，未覆盖主从、连接池上限、`sql_mode` 差异 | 在生产同版本实例跑 `npm run test:integration:real` |
| 人工验收项 | AC-F2~F10、AC-X6 的视觉与交互判断、法务确认的授权文本（Q12） | 评审会签 |

## 5. 如何复现

```bash
# 依赖：Node ≥ 22、ffmpeg / ffprobe；真实模式另需本机 MySQL 8 与 Redis
cd server && npm ci

npm run check                         # 静态 + 单元（含 policy / OSS 仿真 / 飞影协议），约 1 分钟
npm run test:integration              # 临时 SQLite + 内存队列，四套 smoke
npm run test:integration -- --oss     # 同上，素材走 OSS 协议仿真
# 真实 MySQL + Redis/BullMQ（连接参数取环境变量；每次建临时库与独立前缀，结束清理）
DB_HOST=127.0.0.1 DB_USER=… DB_PASSWORD=… REDIS_HOST=127.0.0.1 REDIS_PORT=… \
  npm run test:integration:real -- --oss

npm run test:personas:acceptance                 # 人物库验收 B2~B12（SQLite）
npm run test:personas:acceptance -- --real --oss # 同上，真实 MySQL + Redis + OSS 仿真
npm run test:personas:acceptance -- --only=B5,B7 # 只跑某几节

# 需要真实账号时（本环境无法执行）
npm run test:oss:real                 # 真实 OSS：put / Range / 公网签名 URL / delete
npm run test:hifly                    # 飞影：余额 / 上传凭证 / 列表（零积分）
npm run test:hifly -- --spend         # 追加声音克隆（会消耗积分，先确认）

cd ../frontend && npm ci && npm run build   # vue-tsc + Vite
```

浏览器实测：`frontend/e2e/people-library.mjs`（`npm run e2e:people`），前置步骤写在脚本头部注释里（隔离后端 + Vite 开发服务 + Playwright）。
