import fs from 'node:fs'

let s = fs.readFileSync('src/style.css', 'utf8')
const before = s

// 深色标签渐变 → 品牌变量
s = s.replace(`.mw-tag-deep {
  background: linear-gradient(180deg, #2e63e7, #1d4ed8);
  color: #fff;
  box-shadow: 0 1px 2px rgba(29, 78, 216, 0.25);
}`, `.mw-tag-deep {
  background: linear-gradient(180deg, var(--mw-primary-light), var(--mw-primary));
  color: #fff;
  box-shadow: 0 1px 2px var(--mw-primary-shadow);
}`)

// 步骤条激活
s = s.replace(`.mw-step.active .mw-step-index {
  background: linear-gradient(180deg, #2e63e7, #1d4ed8);
  color: #fff;
  box-shadow: 0 1px 3px rgba(29, 78, 216, 0.35);
}`, `.mw-step.active .mw-step-index {
  background: linear-gradient(180deg, var(--mw-primary-light), var(--mw-primary));
  color: #fff;
  box-shadow: 0 1px 3px var(--mw-primary-shadow);
}`)

// 主按钮
s = s.replace(`.arco-btn-primary {
  background: linear-gradient(180deg, #2e63e7, #1d4ed8);
  border: none;
  box-shadow: var(--mw-shadow-primary);
}`, `.arco-btn-primary {
  background: linear-gradient(180deg, var(--mw-primary-light), var(--mw-primary));
  border: none;
  box-shadow: 0 1px 2px var(--mw-primary-shadow), inset 0 1px 0 rgba(255, 255, 255, 0.14);
}`)
s = s.replace(`.arco-btn-primary:hover {
  background: linear-gradient(180deg, #3a6eec, #2455dc);`, `.arco-btn-primary:hover {
  background: linear-gradient(180deg, var(--mw-primary-light), var(--mw-primary));
  filter: brightness(1.06);`)

// 导航激活
s = s.replace(`.mw-nav-item.active {
  background: linear-gradient(90deg, #e9f0ff, rgba(243, 247, 255, 0.55));`, `.mw-nav-item.active {
  background: linear-gradient(90deg, var(--mw-primary-bg), rgba(255, 255, 255, 0.4));`)
s = s.replace(`  background: linear-gradient(180deg, #2e63e7, #1d4ed8);
}

/* ============================================================
   表头底色`, `  background: linear-gradient(180deg, var(--mw-primary-light), var(--mw-primary));
}

/* ============================================================
   表头底色`)

// 时间线光晕
s = s.replace('box-shadow: 0 0 0 3px rgba(29, 78, 216, 0.1);', 'box-shadow: 0 0 0 3px var(--mw-primary-ring);')

// 品牌语义工具类
s = s.replace(`/* ============================================================
   滚动条与焦点`, `/* ============================================================
   品牌语义工具类（页面内替代硬编码品牌色）
   ============================================================ */
.text-primary-c { color: var(--mw-primary) !important; }
.border-primary-c { border-color: var(--mw-primary) !important; }
.ring-primary-c { --tw-ring-color: var(--mw-primary) !important; }
.border-primary-mid { border-color: var(--mw-primary-mid) !important; }
.border-primary-soft { border-color: var(--mw-primary-soft) !important; }
.ring-primary-soft { --tw-ring-color: var(--mw-primary-soft) !important; }
.bg-primary-faint { background: var(--mw-primary-faint) !important; }

/* ============================================================
   滚动条与焦点`)

if (s === before) { console.error('NO CHANGES APPLIED'); process.exit(1) }
fs.writeFileSync('src/style.css', s)
console.log('style.css updated, var count:', (s.match(/var\(--mw-primary/g) || []).length)
