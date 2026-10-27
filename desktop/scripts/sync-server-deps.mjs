#!/usr/bin/env node
/** 同步 server 生产依赖到 .build/server-node（不触碰开发环境的 node_modules） */
import { execSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const repo = path.resolve(root, '..')

const dev = JSON.parse(execSync('node -e "console.log(JSON.stringify(require(\'./package.json\').devDependencies ?? {}))"', { cwd: path.join(repo, 'server') }).toString())
const devNames = Object.keys(dev).map((n) => `--exclude='${n}'`).join(' ')

execSync(
  `rsync -a --delete ${path.join(repo, 'server/node_modules')}/ ${path.join(root, '.build/server-node')}/ --exclude='.bin' --exclude='.cache' ${devNames} --exclude='@types' --exclude='@vitest' --exclude='eslint*'`,
  { stdio: 'inherit' },
)
console.log('✓ server 生产依赖已同步到 desktop/.build/server-node')
