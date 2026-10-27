# 真实数据联调 · API 参数与环境清单（2026-10-24）

> 依据：`server/.env.example` 与 `server/src/config.ts` 逐项对照代码核实（各集成模块的真实消费点均已确认，
> 非文档转抄）。当前 dev 环境全部第三方走 mock（`MOCK_FALLBACK=true`），本清单是切换到真实数据联调所需
> 的**全部**参数与前提。
> 用法：`cp server/.env.example server/.env`，按下文填入真实值；改完重启服务生效。

---

## 一、外部服务 API 参数（按服务分组）

### 1. 飞影 HiFly —— 数字人分身 / 声音克隆 / 口播视频（人物库 + 视频创作）

消费点：`src/integrations/hifly/client.ts`（`Authorization: Bearer <key>`）；
接口：`/api/v2/hifly/avatar/*`、`voice/*`、`video/create_by_tts`、`audio/create_by_tts`。

| 参数 | 必填 | 说明 |
|---|---|---|
| `HIFLY_API_KEY` | ✅ | 开放平台密钥；缺失时（无 MOCK_FALLBACK）直接抛 `HIFLY_NOT_CONFIGURED` |
| `HIFLY_BASE_URL` | 默认即可 | `https://hfw-api.hifly.cc` |
| `HIFLY_RESULT_HOSTS` | 真实联调建议配 | 成片结果域名白名单（防 SSRF）；未配置时放行 `*.hifly.cc` / `*.hiflycdn.com`，PoC 实际域名后固化 |
| `VIDEO_GEN_CONCURRENCY` | 建议核 | 飞影账号并发上限（默认 3，PoC 实测后修订） |
| `VIDEO_CREDITS_PER_SEC` | 建议核 | 积分单价展示（默认 0.5 元/秒，仅供界面） |

**业务侧前提（无 key 之外的真实数据）**：真人出镜素材视频（mp4/mov，10 秒–10 分钟，短边 ≥720p，建议 9:16）+
真人声音样本（wav/mp3/m4a，5–180 秒）+ 授权书实体文件（pdf/jpg/png ≤20MB，需 reviewer 核验）+ 授权确认（consent）。

### 2. 阿里云百炼 —— LLM 文案生成 + ASR 视频提取文案

消费点：`src/integrations/dashscope/`（LLM 走 OpenAI 兼容协议；ASR 走 native `/services/audio/asr/transcription`，录音文件识别模式）。

| 参数 | 必填 | 说明 |
|---|---|---|
| `DASHSCOPE_API_KEY` | ✅ | 百炼密钥；文案生成（4 模板×风格）与对标视频提取文案共用 |
| `LLM_MODEL` | 默认即可 | `qwen-plus` |
| `ASR_MODEL` | 默认即可 | `qwen3-asr-flash-filetrans` |
| `ASR_PRICE_PER_SEC` | ✅ 建议配 | ASR 按音频时长计价（元/秒，**以百炼账单为准**）；成本核算与超窗拦截依赖它 |
| `LLM_UNIT_PRICE` | 可选 | 计费展示（默认 0.004 元/千 token） |

### 3. 文案二创专用模型（可选，与百炼并行）

消费点：`src/integrations/copy-llm/`；三件套齐备才启用，否则自动回退百炼。

| 参数 | 必填 | 说明 |
|---|---|---|
| `COPY_LLM_BASE_URL` / `COPY_LLM_API_KEY` / `COPY_LLM_MODEL` | 三者齐备才启用 | 已实测 CCG 中转（`https://ccg-cli.online/v1` + claude 系列） |
| `COPY_LLM_PROTOCOL` | 默认 `auto` | 按 baseurl+模型名自动判断 anthropic/openai |
| `COPY_LLM_COMPLIANCE_APPROVED` | 可选 | 合规闸门：文案与人物档案会发往第三方。**决策 D1（2026-10-27）：文案二创采用第三方中转的 Claude，缺省 `true`**；设 `false` 时文案生成回退百炼（百炼只负责语音转文案） |
| `COPY_LLM_INPUT_PRICE_PER_1K` / `_OUTPUT_PRICE_PER_1K` | 可选 | 成本核算单价 |

### 4. TikHub —— 对标账号检测 / 监控 / 爆款解析 / 视频下载（对标线主数据源）

消费点：`src/integrations/tikhub/client.ts`。

| 参数 | 必填 | 说明 |
|---|---|---|
| `TIKHUB_API_KEY` | ✅ | 第三方抖音数据服务 |
| `TIKHUB_BASE_URL` + `TIKHUB_PATH_*` | 默认即可 | 4 个路径（用户资料/作品列表/视频详情/分享链接解析），默认抖音 V3 |
| `TIKHUB_UNIT_PRICE` | 建议核 | 单次调用计价（默认 0.003 元），成本台账用 |

### 5. 曙光舆情 MCP —— 资讯源（响应最快的主源）

消费点：`src/integrations/saturn-news/client.ts`（JSON-RPC over streamableHttp）。

| 参数 | 必填 | 说明 |
|---|---|---|
| `SATURN_NEWS_MCP_KEY` | ✅ | ⚠️ **Authorization 头直放 key，不要加 `Bearer ` 前缀**——加了不报 401 而是返回 Output validation error，极易误判 |
| `SATURN_NEWS_MCP_URL` | 默认即可 | |
| `SATURN_NEWS_KEYWORDS` | 建议调 | 周期采集关键词（默认 `A股,基金,央行`，逗号分隔） |
| `SATURN_NEWS_CHANNELS` / `_LOOKBACK_DAYS` / `_LIMIT` | 可选 | 通道子集（flash/wechat/web_v1/weibo_blog）/ 回看天数 / 单次条数 |

### 6. FinStep 财跃 —— 资讯补充源（ReAct，单轮 40–60 秒）

| 参数 | 必填 | 说明 |
|---|---|---|
| `FINSTEP_API_KEY` | 可选 | 留空则整源不启用（回落内置 RSS + 东财） |
| `FINSTEP_SOURCES` | 默认即可 | `alpha_morning,hot_topics`（search_news/search_opinion 版权未确认，默认不启用） |

**免 key 资讯源**：财联社（ClsProvider）、东方财富（EastMoneyProvider）为内置抓取，无需申请——`NEWS_MOCK_SOURCE=false` 后即可出真实资讯。

### 7. 阿里云 OSS —— 音频中转 / 素材与封面存储 / 飞影签名 URL

消费点：`src/integrations/aliyun-oss/`；`hasOss()` = bucket+AK+SK 三者齐备，否则回落本地存储。
**关键依赖**：对标视频提取（下载音频 → OSS → 百炼 ASR 回调）与飞影自取素材（签名 URL 必须 https 公网可访问）都需要它。

| 参数 | 必填 | 说明 |
|---|---|---|
| `OSS_BUCKET` / `OSS_ACCESS_KEY_ID` / `OSS_ACCESS_KEY_SECRET` | ✅ 三件套 | 缺一按未配置处理（回落本地存储，飞影自取将不可用） |
| `OSS_REGION` | 默认即可 | `oss-cn-shanghai` |
| `OSS_SIGN_ENDPOINT` | 视情况 | 自定义公网签名端点，**必须 https**；留空用官方公网域名 |
| `OSS_INTERNAL` / `OSS_CNAME` / `OSS_ENDPOINT` | 可选 | 内网域名 / CNAME 绑定 / 数据面自定义端点 |
| `EXTRACT_MODE` | 默认 `oss` | 提取链路走 OSS 中转 |

---

## 二、环境依赖（非 API Key，缺了自动降级或不可用）

| 项 | 要求 | 缺失时的表现 | 消费点 |
|---|---|---|---|
| **剪辑真实渲染** | ffmpeg 带 `--enable-libass` + `--enable-freetype`；`server/assets/fonts/` 放置 OFL 授权字体（推荐思源黑体，目录首个文件为 default） | 渲染引擎降级 mock：字幕不烧录、尾页纯黑，仅流程联调（本机当前就是这个状态，`npm run check:media-env` 可探测） | `src/modules/cut/engine.ts`（四项齐备才判定 ffmpeg 引擎） |
| **真实发布引擎** | ⚠️ **代码尚未平移**：`integrations/publish/` 不存在（发布任务书 PU2/PU3），需先开发 Playwright 四平台流程 | 发布引擎恒为 mock（`publish_log` 是模拟数据） | `src/modules/publish/engine.ts` 预留了全部参数：`PUBLISH_HEADLESS` / `PUBLISH_MAX_CONTEXTS` / `PUBLISH_BROWSER_DATA_DIR`（含登录态，排除备份）等 |
| **审核链三关真实对接** | 第 1 关内容安全 API / 第 2 关审核智能体 HTTP / 第 3 关风险提示 Skill，**对接物与代码均未落地** | 生产环境 `REVIEW_STUB_ENABLED` 自动关闭，审核单停在「已提交」；人工复核接口/页面可用（reviewer 裁决） | `src/config.ts` copy.reviewStubEnabled |
| **MySQL** | 生产必须真实 MySQL（`DB_DRIVER=mysql`） | 生产下 `auto` 不再退回 SQLite，连不上直接退出 | |
| **Redis / BullMQ** | 生产建议真实 Redis（持久化队列、多实例） | 退回内存队列：单实例、重启丢进行中任务 | `REDIS_HOST/PORT/PASSWORD/QUEUE_PREFIX` |

---

## 三、生产/真实联调必须复核的全局参数

| 参数 | 要求 |
|---|---|
| `MOCK_FALLBACK` | **生产必须 `false`**（否则无 key 时静默走 mock 产物）。⚠️ 它同时影响 TikHub / ASR / LLM / OSS / 飞影 / 发布引擎——别为了「资讯要真实」单独关它 |
| `NEWS_MOCK_SOURCE` | 真实资讯联调设 `false`（与 MOCK_FALLBACK 解耦，只关内置示意源） |
| `SEED_DEMO` | 生产 `false`（否则启动写入示例人物与占位授权，污染合规审计口径） |
| `AUTH_JWT_SECRET` | 生产必须 ≥32 字符（否则拒绝启动） |
| `AUTH_BOOTSTRAP_ADMIN_PASSWORD` | 生产必须配置（首个管理员密码） |
| `CORS_ORIGINS` | 生产配置前端来源白名单（留空 = 仅同源） |
| `RATE_LIMIT_ENABLED` / `RATE_LIMIT_SCALE` | 计费接口限流保持开启，SCALE=1 |

---

## 四、按联调场景的最小真实配置

| 场景 | 需要的真实参数 | 业务侧前提 |
|---|---|---|
| A. 真实资讯流 | `SATURN_NEWS_MCP_KEY`（+可选 `FINSTEP_API_KEY`）、`NEWS_MOCK_SOURCE=false` | 无 |
| B. 对标账号检测/监控/解析/提取文案 | `TIKHUB_API_KEY` + `DASHSCOPE_API_KEY`（ASR）+ OSS 三件套 | 真实对标主页链接（粉丝≥1w） |
| C. 真实文案生成 | COPY_LLM 三件套（决策 D1 默认走第三方中转 Claude）；未配置时回退 `DASHSCOPE_API_KEY` | 可用人物（授权已核验） |
| D. 真实分身/声音/口播视频 | `HIFLY_API_KEY` + OSS 三件套（签名 URL）+ `HIFLY_RESULT_HOSTS` | 真人素材视频 + 真人声音样本 + 授权书实体 + reviewer 核验 + consent |
| E. 真实剪辑渲染（字幕烧录/尾页文字） | 带 libass+freetype 的 ffmpeg + OFL 字体入 `assets/fonts/` | 已完成的基础视频 |
| F. 真实平台发布 | **不可用**——PU2/PU3 Playwright 平移未开发；参数已预留（见二） | 真实平台账号扫码（待引擎就绪） |
| G. 生产部署 | 上表「三」全部 + MySQL + Redis | — |

---

## 五、真实联调 `.env` 模板（填 key 即用）

```bash
# ── 基础设施 ──
PORT=8787
DB_DRIVER=mysql
DB_HOST=127.0.0.1
DB_PORT=3306
DB_USER=root
DB_PASSWORD=<真实密码>
DB_NAME=viral_topics
REDIS_HOST=127.0.0.1
REDIS_PORT=6379
QUEUE_PREFIX=viral

# ── 生产/真实联调全局 ──
MOCK_FALLBACK=false
NEWS_MOCK_SOURCE=false
SEED_DEMO=false
AUTH_JWT_SECRET=<≥32字符随机串>
AUTH_BOOTSTRAP_ADMIN_PASSWORD=<真实管理员密码>
CORS_ORIGINS=http://<前端域名>

# ── 飞影（场景 D）──
HIFLY_API_KEY=<飞影开放平台密钥>
HIFLY_RESULT_HOSTS=<PoC 实际域名后配置>

# ── 百炼（场景 B/C/D）──
DASHSCOPE_API_KEY=<百炼密钥>
ASR_PRICE_PER_SEC=<按账单填写>

# ── 文案二创模型（决策 D1：第三方中转 Claude；COPY_LLM_COMPLIANCE_APPROVED 缺省 true）──
COPY_LLM_BASE_URL=https://ccg-cli.online/v1
COPY_LLM_API_KEY=<key>
COPY_LLM_MODEL=claude-opus-5.5

# ── TikHub（场景 B）──
TIKHUB_API_KEY=<TikHub 密钥>

# ── 曙光（场景 A；key 直放，不加 Bearer）──
SATURN_NEWS_MCP_KEY=<曙光密钥>

# ── FinStep（可选）──
# FINSTEP_API_KEY=<财跃密钥>

# ── OSS（场景 B/D 必需）──
OSS_BUCKET=<桶名>
OSS_ACCESS_KEY_ID=<AK>
OSS_ACCESS_KEY_SECRET=<SK>

# ── 发布（PU2/PU3 平移后才生效；参数已预留）──
# PUBLISH_HEADLESS=true
# PUBLISH_MAX_CONTEXTS=3
# PUBLISH_BROWSER_DATA_DIR=server/.data/browser-data
```

## 六、当前 mock 状态对照（哪些环节现在是假的）

| 环节 | 现状 | 切真实 |
|---|---|---|
| 资讯 | 东财真实源已在拉（277 条），曙光/FinStep 关闭 | 场景 A |
| 选题生成 | LLM mock（固定模板角度） | 场景 C |
| 文案生成/变体 | LLM mock | 场景 C |
| 分身/声音/口播 | 飞影 mock（秒级完成、产物带「模拟」标记） | 场景 D |
| 对标解析/提取 | TikHub + ASR mock | 场景 B |
| 剪辑渲染 | ffmpeg mock（缺 libass+字体） | 场景 E |
| 发布 | 引擎 mock（全链路模拟） | 场景 F（待开发） |
| 审核 | 三关桩（REVIEW_STUB_ENABLED） | 待审核模块对接；人工复核已可用 |
