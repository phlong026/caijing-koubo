# 财经口播智能体（caijing-koubo）

面向财经/金融口播短视频的 AI 内容生产系统：一条从选题到发布的完整流水线——

**爆款选题 → 文案工坊 → 人物库 / 素材库 → 视频创作 / 视频剪辑 → 审核校对 → 发布管理 → 数据看板**，任务中心贯穿全程。

## 目录结构

```
caijing-koubo/
├── frontend/            # 前端 matrix-workshop：Vue 3 + Vite + Tailwind + Arco
│   └── e2e/             #   Playwright 端到端测试（npm run e2e）
├── server/              # 后端 viral-topics-server：Node + TypeScript（tsx 运行 / vitest 单测）
│   ├── src/modules/     #   各业务模块（选题、文案、人物库、素材库、视频、审核、发布…）
│   ├── scripts/         #   smoke / 集成测试脚本（smoke:chain 全链路贯通等）
│   └── .env.example     #   环境变量样例（含第三方密钥，真实 .env 绝不入库）
├── desktop/             # Electron 桌面版：壳内嵌 Fastify，单机运行零外部依赖
├── docs/                # 开发文档（见下）
├── 参考效果图/           # UI 视觉确认稿（.gitignore 中有白名单例外，勿移动）
└── .github/             # CI 工作流
```

## 快速开始

后端（默认 `DB_DRIVER=auto`：优先连 MySQL，自动退回内置 SQLite）：

```bash
cd server
npm install
cp .env.example .env      # 按需填写第三方服务密钥
npm run migrate           # 建表/迁移
npm run dev               # tsx watch 启动
```

前端：

```bash
cd frontend
npm install
npm run dev               # http://127.0.0.1:5173
```

桌面版：见 `desktop/README.md`。

## 质量检查

```bash
# 后端：类型检查 + 单测 + SQL/DDL 校验 + 各模块回归（一条龙）
cd server && npm run check

# 前端：lint + 格式检查
cd frontend && npm run lint

# 端到端与全链路冒烟
cd frontend && npm run e2e
cd server && npm run smoke:chain
```

## 文档索引（docs/）

| 子目录 | 内容 |
|--------|------|
| `docs/任务书/` | 各模块《需求与开发任务书》（人物库、文案工坊、视频创作/剪辑、发布管理等 10 份） |
| `docs/评审报告/` | 代码评审报告、争议项裁定、design-qa、上线前综合分析 |
| `docs/方案/` | 技术方案与模块清单、跨模块联动修改方案 |
| `docs/*.md`（根） | 按日期归档的开发日志：联调、e2e、联合测试、评审决议等 |

上位文档《技术方案与模块清单》（`docs/方案/`）是各模块任务书的总纲。

## 约定

- 提交信息使用中文；文档放 `docs/` 对应子目录，不堆在仓库根目录。
- `.env`、`*.db`、构建产物（`dist/`）均不入库；e2e 截图产物目录已 ignore。
