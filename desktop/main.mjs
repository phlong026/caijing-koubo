/**
 * 矩阵工场 · 桌面版主进程。
 *
 * 结构：Electron main ──utilityProcess──▶ server（desktop-entry.ts，Node ESM）
 *                                    └──▶ Fastify（127.0.0.1 动态端口，同源服务前端）
 * 数据落 userData/（数据库、日志、密钥），与安装目录解耦；升级不丢数据。
 */
import { app, BrowserWindow, Menu, dialog, shell, utilityProcess, nativeTheme } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

const isDev = !app.isPackaged
const name = '矩阵工场'

/* ── 资源定位：打包后 extraResources 在 app.asar 外 ── */
const res = isDev ? path.resolve(app.getAppPath(), 'resources-dev') : process.resourcesPath
const serverEntry = isDev
  ? path.resolve(app.getAppPath(), '../server/dist/src/desktop-entry.js')
  : path.join(res, 'server/dist/src/desktop-entry.js')
const webDir = isDev ? path.resolve(app.getAppPath(), '../frontend/dist') : path.join(res, 'web')
const ffmpegName = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'
const ffmpegPath = path.join(res, 'bin', ffmpegName)
// 剪辑字幕渲染的字体目录（libass 至少需要一个字体；内容由运营按 README 放置 OFL 字体）
const fontsDir = isDev
  ? path.resolve(app.getAppPath(), '../server/assets/fonts')
  : path.join(res, 'server/assets/fonts')

/* ── userData 布局：data/app.db、logs/server.log、secrets.json ── */
const ud = () => app.getPath('userData')
const dataDir = () => path.join(ud(), 'data')
const logsDir = () => path.join(ud(), 'logs')

/** 首启生成的持久密钥：JWT 签名 + 首个管理员密码（展示一次，登录后自行修改） */
function loadOrCreateSecrets() {
  const file = path.join(ud(), 'secrets.json')
  let s = null
  try {
    s = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {}
  if (!s?.jwt || !s?.adminPassword) {
    s = {
      jwt: s?.jwt || crypto.randomBytes(48).toString('hex'),
      adminPassword: s?.adminPassword || crypto.randomBytes(9).toString('base64url'),
    }
    fs.mkdirSync(ud(), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(s, null, 2), { mode: 0o600 })
  }
  return s
}

let serverProc = null
let mainWindow = null
let serverPort = 0

function startServer(secrets) {
  fs.mkdirSync(dataDir(), { recursive: true })
  fs.mkdirSync(logsDir(), { recursive: true })
  serverProc = utilityProcess.fork(serverEntry, [], {
    serviceName: 'matrix-server',
    stdio: 'pipe',
    cwd: path.dirname(serverEntry),
    env: {
      ...process.env,
      NODE_ENV: 'production',
      DESKTOP_MODE: '1',
      DB_DRIVER: 'sqlite',
      DB_SQLITE_PATH: path.join(dataDir(), 'app.db'),
      DATA_DIR: dataDir(),
      QUEUE_BACKEND: 'memory',
      LOG_FILE: path.join(logsDir(), 'server.log'),
      STATIC_DIR: webDir,
      PORT: '0',
      AUTH_JWT_SECRET: secrets.jwt,
      AUTH_BOOTSTRAP_ADMIN_USER: 'admin',
      AUTH_BOOTSTRAP_ADMIN_PASSWORD: secrets.adminPassword,
      ...(fs.existsSync(ffmpegPath) ? { FFMPEG_PATH: ffmpegPath } : {}),
      CUT_FONTS_DIR: fontsDir,
    },
  })
  serverProc.stdout?.on('data', (d) => process.stdout.write(`[server] ${d}`))
  serverProc.stderr?.on('data', (d) => process.stderr.write(`[server!] ${d}`))
  serverProc.on('message', (msg) => {
    if (msg?.cmd === 'server-ready' && msg.port) {
      serverPort = msg.port
      loadWindow(secrets)
    }
    if (msg?.cmd === 'server-error') {
      dialog.showErrorBox(name, `服务启动失败：${msg.message}\n\n日志：${path.join(logsDir(), 'server.log')}`)
      app.quit()
    }
  })
  serverProc.on('exit', (code) => {
    // 服务崩溃：窗口仍在时给出明确提示，而不是白屏
    if (mainWindow && !app.quitting) {
      dialog.showErrorBox(name, `后端服务已退出（code=${code}）。\n\n日志：${path.join(logsDir(), 'server.log')}`)
      app.quit()
    }
  })
}

function loadWindow(secrets) {
  if (mainWindow) return
  nativeTheme.titleBarStyle = 'default'
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    title: name,
    autoHideMenuBar: false,
    show: false,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
  })
  mainWindow.once('ready-to-show', () => {
    mainWindow.show()
    // 首启展示初始管理员密码（仅一次：存在 secrets.seen 标记后不再弹）
    const secretsFile = path.join(ud(), 'secrets.json')
    const s = JSON.parse(fs.readFileSync(secretsFile, 'utf8'))
    if (!s.seen) {
      s.seen = true
      fs.writeFileSync(secretsFile, JSON.stringify(s, null, 2), { mode: 0o600 })
      dialog.showMessageBox(mainWindow, {
        type: 'info',
        title: '初始账号',
        message: `账号：admin\n密码：${secrets.adminPassword}`,
        detail: '请妥善保存，登录后可在账号管理中重置密码。此窗口不会再次显示。',
        buttons: ['我已保存'],
      })
    }
  })
  mainWindow.loadURL(`http://127.0.0.1:${serverPort}/`)
  mainWindow.on('closed', () => (mainWindow = null))
}

/* ── 菜单（第 5 步：数据目录 / 备份 / 开机自启 / 更新占位） ── */
function buildMenu() {
  const autoLaunch = () => app.getLoginItemSettings().openAtLogin
  const template = [
    {
      label: '文件',
      submenu: [
        {
          label: '备份数据库…',
          async click() {
            const db = path.join(dataDir(), 'app.db')
            const now = new Date()
            const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`
            const r = await dialog.showSaveDialog({ defaultPath: `matrix-backup-${stamp}.db` })
            if (r.canceled || !r.filePath) return
            try {
              fs.copyFileSync(db, r.filePath)
              dialog.showMessageBox({ type: 'info', message: '备份完成', detail: r.filePath })
            } catch (e) {
              dialog.showErrorBox('备份失败', String(e))
            }
          },
        },
        { type: 'separator' },
        { role: 'quit', label: '退出' },
      ],
    },
    {
      label: '视图',
      submenu: [
        { role: 'reload', label: '刷新' },
        { role: 'toggleDevTools', label: '开发者工具' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { role: 'resetZoom', label: '重置缩放' },
      ],
    },
    {
      label: '帮助',
      submenu: [
        {
          label: '打开数据目录',
          click: () => shell.openPath(dataDir()),
        },
        { label: '打开日志目录', click: () => shell.openPath(logsDir()) },
        {
          label: '开机自动启动',
          type: 'checkbox',
          checked: autoLaunch(),
          click(item) {
            app.setLoginItemSettings({ openAtLogin: item.checked })
          },
        },
        { type: 'separator' },
        {
          label: '检查更新…',
          click: () =>
            dialog.showMessageBox({
              type: 'info',
              message: '自动更新未启用',
              detail: '当前版本通过安装包覆盖升级；数据保存在用户目录，升级不丢失。后续接入 electron-updater 后此入口检查新版本。',
            }),
        },
        { label: `关于 ${name}`, click: () => app.showAboutPanel() },
      ],
    },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      mainWindow.show()
      mainWindow.focus()
    }
  })
  app.whenReady().then(() => {
    buildMenu()
    startServer(loadOrCreateSecrets())
  })
  app.on('before-quit', () => {
    app.quitting = true
  })
  app.on('window-all-closed', () => {
    serverProc?.kill()
    app.quit()
  })
}
