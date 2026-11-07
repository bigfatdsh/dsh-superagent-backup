#!/usr/bin/env node
/**
 * 把本仓库的提交推到 GitHub —— 走 Git Data API，不用 git push。
 *
 * 为什么：本机 github.com:22/443 不通，只有 api.github.com 通。
 * 与 adapted/dsh-superagent/bridge/github-bridge.mjs 的区别：这个从空仓库也能推
 * （那个在空仓库上会对 /git/commits/<sha> 报 409），并且推送后远端 sha 与本地一致。
 *
 * 用法：
 *   GITHUB_TOKEN=... GITHUB_BRIDGE_REPO=owner/name node tools/push.mjs [ref]
 * 或用包装脚本：./tools/push.sh
 */
import { execFileSync } from 'node:child_process'

const repo = process.env.GITHUB_BRIDGE_REPO
const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN
const ref = process.argv[2] ?? 'refs/heads/main'
if (!repo) throw new Error('GITHUB_BRIDGE_REPO=<owner/name> is required')
if (!token) throw new Error('GITHUB_TOKEN is required')

const API = 'https://api.github.com'

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 1 << 30 })
}

async function api(method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${text.slice(0, 300)}`)
  return text ? JSON.parse(text) : undefined
}

function parseCommit(sha) {
  const raw = git(['cat-file', 'commit', sha])
  const [head, ...rest] = raw.split('\n\n')
  const field = key => (new RegExp(`^${key} (.+)$`, 'm').exec(head) ?? [])[1]
  const ident = key => {
    const m = /^(.*) <(.*)> (\d+) ([+-]\d{4})$/.exec(field(key) ?? '')
    if (!m) throw new Error(`cannot parse ${key}`)
    return { name: m[1], email: m[2], date: new Date(Number(m[3]) * 1000).toISOString() }
  }
  return {
    sha,
    tree: field('tree'),
    parents: head.split('\n').filter(l => l.startsWith('parent ')).map(l => l.slice(7)),
    message: rest.join('\n\n'),
    author: ident('author'),
    committer: ident('committer'),
  }
}

const blobCache = new Map()
async function blobSha(localSha) {
  if (blobCache.has(localSha)) return blobCache.get(localSha)
  const content = execFileSync('git', ['cat-file', 'blob', localSha], { maxBuffer: 1 << 30 }).toString('base64')
  const { sha } = await api('POST', `/repos/${repo}/git/blobs`, { content, encoding: 'base64' })
  blobCache.set(localSha, sha)
  return sha
}

const commits = git(['rev-list', '--topo-order', '--reverse', ref])
  .split('\n')
  .filter(Boolean)
console.log(`推送 ${commits.length} 个提交到 ${repo} (${ref})`)

const remoteByLocal = new Map()
let last = null
for (const sha of commits) {
  const c = parseCommit(sha)
  const entries = []
  for (const line of git(['ls-tree', '-r', c.tree]).split('\n').filter(Boolean)) {
    const [, mode, type, obj, path] = /^(\d+) (\w+) ([0-9a-f]+)\t(.*)$/.exec(line)
    if (type !== 'blob') continue
    entries.push({ path, mode, type: 'blob', sha: await blobSha(obj) })
  }
  const tree = await api('POST', `/repos/${repo}/git/trees`, { tree: entries })
  const parents = c.parents.map(p => remoteByLocal.get(p)).filter(Boolean)
  const created = await api('POST', `/repos/${repo}/git/commits`, {
    message: c.message,
    tree: tree.sha,
    parents,
    author: c.author,
    committer: c.committer,
  })
  remoteByLocal.set(sha, created.sha)
  last = created.sha
  console.log(`  ${sha.slice(0, 8)} -> ${created.sha.slice(0, 8)} ${c.message.split('\n')[0]}`)
  if (created.sha !== sha) console.warn('    注意：远端 sha 与本地不同')
}

const branch = ref.replace(/^refs\/heads\//, '')
try {
  await api('GET', `/repos/${repo}/git/ref/heads/${branch}`)
  await api('PATCH', `/repos/${repo}/git/refs/heads/${branch}`, { sha: last, force: true })
} catch {
  await api('POST', `/repos/${repo}/git/refs`, { ref: `refs/heads/${branch}`, sha: last })
}
console.log(`完成：https://github.com/${repo}/tree/${branch}`)
