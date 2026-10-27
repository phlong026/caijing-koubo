# 矩阵工场 · 桌面版（Electron）

把「前端 + Fastify 后端」打成单机桌面应用：Electron 主进程拉起后端（utilityProcess），
本地动态端口同源服务前端，数据全部落在用户数据目录，与安装目录解耦，覆盖升级不丢数据。

## 架构

```
Electron main (main.mjs)
  └─ utilityProcess ──▶ server/dist/src/desktop-entry.js（Node 22 内核）
       └─ Fastify 127.0.0.1:<随机端口>
            ├─ /api/*      后端接口（登录鉴权）
            └─ /*          frontend/dist 静态托管（SPA 回退 index.html）
```

- 队列：`QUEUE_BACKEND=memory`（进程内，不依赖 Redis；任务不持久化，重启丢失未完成异步任务）
- 数据库：SQLite，`userData/data/app.db`
- 日志：`userData/logs/server.log`（JSON 行）
- 密钥：首启生成 `userData/secrets.json`（0600）：JWT 签名密钥 + 初始 admin 密码（首启弹窗展示一次）
- ffmpeg：随包分发带 libass 的静态构建（字幕烧录/风险尾页），`FFMPEG_PATH` 注入
- 各业务 API Key（模型、数据源、飞影等）：登录后在「账号管理 → 系统设置」填写，即时生效

## 打包（打包机一次性环境）

```bash
# 1. 后端产物
cd server && npm ci && npm run build

# 2. 前端产物
cd frontend && npm ci && npm run build

# 3. 下载 ffmpeg（mac-arm64 / win-x64；慢源自动断点续传，可反复执行）
cd desktop && npm ci && npm run fetch:ffmpeg

# 4. 同步 server 生产依赖（不动开发环境 node_modules）
npm run pkg:deps

# 5. 打包
npm run dist:mac   # → release/ 矩阵工场-0.1.0-arm64.dmg
npm run dist:win   # → release/ 矩阵工场 Setup 0.1.0.exe（需在 CI 或 Windows 上跑）
```

国内网络加速：`ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`、
`ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/`。

## 开发调试

```bash
cd desktop && npm start    # 直接跑 electron .（用 server/dist + frontend/dist，改代码后需重新 build）
```

## 已知边界

- 内存队列：异步任务（选题生成/视频提取/文案生成/剪辑）不跨重启持久化；进行中任务重启即中断，
  由各模块的续跑/reconcile 逻辑在下次启动接住或标记失败。
- 自动更新未接入（菜单为占位）；内部分发用安装包覆盖升级，用户数据不受影响。
- 剪辑字体：`server/assets/fonts` 需放置 OFL 字体（libass 至少一个），缺字体时剪辑渲染会明确报错。
- 打包跳过签名（identity: null）；首次打开 mac 版需右键「打开」绕过 Gatekeeper，或企业分发签名后消除。
