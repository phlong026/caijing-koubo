import fs from 'node:fs'
import path from 'node:path'

const reps = [
  ['!text-[#1d4ed8]', '!text-[color:var(--mw-primary)]'],
  ['text-[#1d4ed8]', 'text-[color:var(--mw-primary)]'],
  ['border-[#1d4ed8]', 'border-[color:var(--mw-primary)]'],
  ['ring-[#1d4ed8]', 'ring-[color:var(--mw-primary)]'],
  ['border-[#8fb5f7]', 'border-[color:var(--mw-primary-mid)]'],
  ['border-[#bdd3fb]', 'border-[color:var(--mw-primary-soft)]'],
  ['ring-[#bdd3fb]', 'ring-[color:var(--mw-primary-soft)]'],
  ['border-[#dce7fd]', 'border-[color:var(--mw-primary-soft)]'],
  ['bg-[#f7faff]', 'bg-[color:var(--mw-primary-faint)]'],
  ['bg-[#f0f5ff]', 'bg-[color:var(--mw-primary-faint)]'],
]

function walk(dir) {
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f)
    const st = fs.statSync(p)
    if (st.isDirectory()) walk(p)
    else if (f.endsWith('.vue')) {
      let s = fs.readFileSync(p, 'utf8')
      let changed = false
      for (const [from, to] of reps) {
        if (s.includes(from)) { s = s.split(from).join(to); changed = true }
      }
      if (changed) { fs.writeFileSync(p, s); console.log('fixed:', p) }
    }
  }
}
walk('src')
