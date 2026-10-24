# 素材库模块一期交付与验证记录（2026-10-24）

> 依据：《素材库模块-需求与开发任务书-v1.0.md》ML0~ML5；上位文档《技术方案与模块清单》§2.1「素材库」行、§2.3「字体管理」行。
> 结论：**一期交付完成**，`smoke:material` 48/48、`smoke:all` 九套全绿、`npm run check` 与前端 `lint` + `build` 全绿。
> 唯一待真实环境项：字幕烧录需带 libass + freetype 的 ffmpeg 实测（本机 ffmpeg 缺 libass，全部渲染走 mock 引擎）。

## 一、交付内容

### 后端（`server/src/modules/material/`，新增模块）

| 文件 | 职责 |
|---|---|
| `fonts.ts` | 字体域：上传（扩展名 / 30MB / magic bytes 校验、同 hash 幂等、同名不同内容拒绝）、启用前置授权校验（`other` 需出处）、删除守卫（被成片字幕样式引用即拒）、启用集与 default 解析、草稿保存校验、启动扫描（增量入库 / sha256 对账 / 清脏记录，幂等） |
| `voices.ts` | 声音库只读聚合：`persona_voice` JOIN `persona`，按线筛选，授权状态归纳为 `verified / pending / unbound`；不建表、不复制资产 |
| `routes.ts` | `/fonts`（5 个）、`/material-packs*`、`/material-keyword-groups*`（**路径与视频创作 V1 完全一致，仅代码归位**）、`/voice-library`；items 接口返回缩略图签名 URL |

配套改动：`db/schema.ts` 新增 `font_item` 表 + `material_pack.license_note` 列；`errors.ts` 新增 6 个错误码；`auth/guard.ts` 写接口收紧为 `ADMINS`（A6）；`index.ts` 启动时执行字体扫描；`config.ts` 新增 `CUT_FONT_MAX_MB`（默认 30）。

### 前端

- `views/assets/MaterialLibrary.vue` 整页重写：五 Tab（字体库 / 素材库 / 关键词组 / 声音库 / 数字人形象）全部接真，写操作按 `hasRole('admin')` 隐藏。
- `api/material.ts` 新增（20 个方法 + XHR 上传进度）。
- `views/video/VideoEdit.vue`：字幕样式新增「字体」下拉，数据源为素材库启用集；`default` 选项语义改为「启用集首个」。

### 剪辑联动（ML4）

| 位置 | 改动 |
|---|---|
| `cut/engine.ts` | `resolveFontFile()` 委托 `material/fonts.ts`，default = 启用集首个，无启用字体时回退目录首个（历史行为） |
| `cut/render.ts` | 按 `subtitleStyle.fontName` 解析字体文件；失效/停用 → 回退 default 并打 `cut.font_unavailable_fallback_default` warn |
| `cut/service.ts` | 草稿保存校验 `fontName ∈ 启用集 ∪ {default}`，越界 400 `CUT_STYLE_INVALID`；**素材域异常时放行**，保证剪辑保存不被素材库拖垮（AC-R1） |

## 二、落地中发现并修复的两个既有缺陷

1. **multipart 全局 `files: 1`**（`app.ts`）：素材包多文件上传此前实际只进第一个文件。已放宽为 20 并在 `/material-packs` 路由侧校验，单文件路由仍只取 `files[0]`，无回归。
2. **zip 经 multipart 上传不解压**（`video/material.ts`）：V1 只在 `sourcePath` 以 `.zip` 结尾时解压，临时目录链路把 zip 当普通素材扫描 → 空包报 `MATERIAL_PACK_EMPTY`。已加 zip 分支并清理临时文件。

## 三、验证证据

### 1. `smoke:material`（新增，48 项全绿，纳入 `smoke:all`）

| 分组 | 覆盖 |
|---|---|
| 角色口径 | ops 可读 `/fonts`；ops 上传/改字体 403 |
| 字体上传（AC-F1） | `.woff` 拒、伪字体拒、`.ttf`/`.otf` 入库 enabled=false、同 hash 幂等、同名不同内容 409 |
| 授权与启用（AC-F2） | `other` 无出处启用 409 `FONT_LICENSE_REQUIRED` → 补出处 → 启用 → 出现在启用集 |
| default 与扫描（AC-F4/F5） | 启用集按文件名升序（default = 首个）；手工放置文件被 `bootstrap` 收编；二次执行 added=0 / removed=0 |
| 删除守卫（AC-F3） | 插入 `video_cut` 引用 → `inUseCount=1` → 删除 409 `FONT_IN_USE` → 解除 → 删除成功且目录文件移除 |
| 素材包（AC-P1/P2/P4） | 目录导入 2 项、自动打标、手动补标（去重/超长拒绝）、启停往返、包级授权出处 |
| 关键词组（AC-K1） | 空关键词 / `min ≥ max` / 不存在包全部 400；创建与编辑成功 |
| 删除守卫（AC-P3） | 被启用组引用 409 `MATERIAL_PACK_IN_USE`；停用并删除组后可删 |
| 上传通道 | 单个 zip 解压导入 2 项；多文件直传 2 项 |
| 声音库（AC-V1） | KOS 人物声音样本入库 → 聚合可见 → `line=kos` 命中 / `line=manager` 不命中 |

### 2. 其余门禁

- `npm run check`（server）：类型检查、`check:sql-columns` 222 条、`check:mysql-ddl` 1627 项 + 自检 8/8、回归单测 13 + 14 组、快照 hash 7 项 —— 全绿。
- `vitest run`：70 → **83**（新增 `test/unit/material-font.test.ts` 13 项：文件名清洗 / 魔数 / fontBaseName / 授权状态）。
- 前端：`vue-tsc --noEmit`、`eslint`、`prettier --check`、`vite build` —— 全绿。
- `npm run smoke:all`：九套全绿（smoke / copy / topics / personas / video / publish / cut / **material** / chain），总耗时约 6 分钟。

## 四、遗留

| # | 遗留 | 处理建议 |
|---|---|---|
| 1 | 真实字幕烧录验收（剪辑 §14.4 遗留 1） | 字体链路已就绪，需在带 libass + freetype 的 ffmpeg 环境上传真实中文字体后人工验收 |
| 2 | 语义向量打标（ML4 二期） | 一期 tags = 文件名分词 + 关键词组命中；二期沿用 `material_item.tags` 扩展 |
| 3 | 背景空镜（ML7 / Q4） | 等数据看板沉淀「空镜类型偏好」再立项 |
| 4 | 大包上传内存占用 | multipart 走 `toBuffer` 全量入内存（V1 既有实现），大包建议 zip 上传；后续可改流式落盘 |
