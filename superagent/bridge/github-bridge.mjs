#!/usr/bin/env node
/**
 * GitHub git bridge for hosts where github.com:22/443 is unreachable but api.github.com works.
 *
 * The worker's `git clone/push https://github.com/<owner>/<name>` is rewritten (see the
 * `[url ...] insteadOf` block in src/infra/environment.ts) to a local bare repository. This
 * script moves objects between that local repository and GitHub through the REST API, so the
 * checkout keeps ordinary git semantics while only api.github.com crosses the network.
 *
 *   node github-bridge.mjs import <ref>   # recreate a remote ref locally, byte-identical SHAs
 *   node github-bridge.mjs export <ref>... # send local commits missing on GitHub, then move the ref
 *   node github-bridge.mjs status
 *
 * `export` is what the bare repository's post-receive hook runs; `import` seeds and refreshes.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'

const API = 'https://api.github.com'
const token = process.env.GITHUB_BRIDGE_TOKEN ?? execFileSync('security', ['find-internet-password', '-s', 'github.com', '-w'], { encoding: 'utf8' }).trim()
const repo = process.env.GITHUB_BRIDGE_REPO ?? ''
const gitDir = process.env.GIT_DIR ?? ''
const log = (...parts) => console.error('[github-bridge]', ...parts)

if (!repo) throw new Error('GITHUB_BRIDGE_REPO=<owner/name> is required')
if (!gitDir) throw new Error('GIT_DIR is required (run me from a git hook or with GIT_DIR set)')

const git = (args, input) => execFileSync('git', args, { input, encoding: 'utf8', env: { ...process.env, GIT_DIR: gitDir } }).trim()

async function api(method, path, body) {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'content-type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (response.status === 404) return undefined
  if (!response.ok) throw new Error(`${method} ${path} -> ${response.status}: ${(await response.text()).slice(0, 300)}`)
  return response.status === 204 ? undefined : response.json()
}

const hasLocal = sha => {
  try { git(['cat-file', '-e', `${sha}^{commit}`]); return true } catch { return false }
}

const exists = async sha => (await api('GET', `/repos/${repo}/git/commits/${sha}`)) !== undefined

/** Local commit object as GitHub reports it, so an imported commit keeps its own sha. */
function commitParts(sha) {
  const raw = git(['cat-file', 'commit', sha])
  const [head, ...rest] = raw.split('\n\n')
  const message = rest.join('\n\n')
  const field = key => (new RegExp(`^${key} (.+)$`, 'm').exec(head) ?? [])[1]
  const ident = key => {
    const value = field(key)
    const match = /^(.*) <(.*)> (\d+) ([+-]\d{4})$/.exec(value)
    if (!match) throw new Error(`cannot parse ${key}: ${value}`)
    return { name: match[1], email: match[2], date: new Date(Number(match[3]) * 1000 + offsetMs(match[4])).toISOString() }
  }
  return {
    tree: field('tree'),
    parents: head.split('\n').filter(line => line.startsWith('parent ')).map(line => line.slice(7)),
    author: ident('author'),
    committer: ident('committer'),
    message,
  }
}

const offsetMs = text => (text[0] === '-' ? -1 : 1) * (Number(text.slice(1, 3)) * 60 + Number(text.slice(3, 5))) * 60_000

const apiRef = ref => ref.replace(/^refs\//, '')

async function importRef(ref) {
  const remote = await api('GET', `/repos/${repo}/git/ref/${apiRef(ref)}`)
  if (!remote) throw new Error(`remote has no ${ref}`)
  const wanted = remote.object.sha
  await importCommit(wanted)
  git(['update-ref', ref, wanted])
  log(`imported ${ref} at ${wanted}`)
}

async function importCommit(sha, seen = new Set()) {
  if (seen.has(sha)) return
  seen.add(sha)
  try {
    git(['cat-file', '-e', `${sha}^{commit}`])
    return
  } catch {}
  const commit = await api('GET', `/repos/${repo}/git/commits/${sha}`)
  if (!commit) throw new Error(`remote has no commit ${sha}`)
  for (const parent of commit.parents) await importCommit(parent.sha, seen)
  const tree = await importTree(commit.tree.sha)
  const env = {
    GIT_AUTHOR_NAME: commit.author.name,
    GIT_AUTHOR_EMAIL: commit.author.email,
    GIT_AUTHOR_DATE: commit.author.date,
    GIT_COMMITTER_NAME: commit.committer.name,
    GIT_COMMITTER_EMAIL: commit.committer.email,
    GIT_COMMITTER_DATE: commit.committer.date,
  }
  const args = ['commit-tree', tree, ...commit.parents.flatMap(parent => ['-p', parent.sha])]
  const made = execFileSync('git', args, { input: commit.message, encoding: 'utf8', env: { ...process.env, GIT_DIR: gitDir, ...env } }).trim()
  if (made !== sha) log(`warning: imported ${sha} as ${made} (object differs)`)
}

async function importTree(sha) {
  try {
    git(['cat-file', '-e', sha])
    return sha
  } catch {}
  const listing = await api('GET', `/repos/${repo}/git/trees/${sha}?recursive=1`)
  if (!listing) throw new Error(`remote has no tree ${sha}`)
  const bySha = new Map()
  for (const entry of listing.tree) {
    if (entry.type !== 'blob') continue
    if (bySha.has(entry.sha)) continue
    const blob = await api('GET', `/repos/${repo}/git/blobs/${entry.sha}`)
    const content = blob.encoding === 'base64' ? Buffer.from(blob.content, 'base64') : Buffer.from(blob.content, 'utf8')
    const made = execFileSync('git', ['hash-object', '-w', '--stdin', '-t', 'blob'], { input: content, encoding: 'utf8', env: { ...process.env, GIT_DIR: gitDir } }).trim()
    if (made !== entry.sha) log(`warning: blob ${entry.path} hashed to ${made}`)
    bySha.set(entry.sha, made)
  }
  // Rebuild the directory structure bottom-up and write each tree with `git mktree`.
  const node = { dirs: new Map(), files: [] }
  for (const entry of listing.tree) {
    const parts = entry.path.split('/')
    let cursor = node
    for (const part of parts.slice(0, -1)) {
      if (!cursor.dirs.has(part)) cursor.dirs.set(part, { dirs: new Map(), files: [] })
      cursor = cursor.dirs.get(part)
    }
    cursor.files.push({ name: parts.at(-1), mode: entry.mode, sha: bySha.get(entry.sha) ?? entry.sha, type: 'blob' })
  }
  const write = current => {
    const lines = [...current.files.map(file => `${file.mode} ${file.type} ${file.sha}\t${file.name}`)]
    for (const [name, dir] of current.dirs) lines.push(`040000 tree ${write(dir)}\t${name}`)
    return git(['mktree'], `${lines.join('\n')}\n`)
  }
  const made = write(node)
  if (made !== sha) log(`warning: tree ${sha} rebuilt as ${made}`)
  return made
}

/** local sha -> GitHub sha, so later pushes still line up although GitHub rewrites the dates. */
const mapPath = () => join(gitDir, 'bridge-map.json')
const loadMap = () => { try { return JSON.parse(readFileSync(mapPath(), 'utf8')) } catch { return {} } }
const saveMap = map => writeFileSync(mapPath(), JSON.stringify(map, null, 2))

/** Upload every local commit the remote does not have, oldest first, then move the remote ref. */
async function exportRef(ref) {
  const map = loadMap()
  const local = git(['rev-parse', ref])
  const parentsOf = sha => git(['rev-list', '--parents', '-n', '1', sha]).split(' ').slice(1)
  const known = async sha => map[sha] ?? ((await exists(sha)) ? sha : undefined)

  const missing = []
  let cursor = local
  while (cursor && !(await known(cursor))) {
    missing.push(cursor)
    const parents = parentsOf(cursor)
    if (parents.length > 1) log(`warning: ${cursor} merges branches; only its first parent is bridged`)
    cursor = parents[0] ?? ''
  }
  if (!missing.length) {
    log(`${ref} is already on GitHub`)
    return
  }

  for (const sha of missing.reverse()) {
    const parts = commitParts(sha)
    const remoteParent = parts.parents[0] ? await known(parts.parents[0]) : undefined
    const parentTree = remoteParent ? (await api('GET', `/repos/${repo}/git/commits/${remoteParent}`)).tree.sha : undefined
    const entries = []
    if (parts.parents[0]) {
      for (const line of git(['diff-tree', '-r', '--no-commit-id', '--name-status', parts.parents[0], sha]).split('\n').filter(Boolean)) {
        const [status, first, second] = line.split('\t')
        if (status.startsWith('D')) { entries.push({ path: first, mode: '100644', type: 'blob', sha: null }); continue }
        if (status.startsWith('R') || status.startsWith('C')) {
          entries.push({ path: first, mode: '100644', type: 'blob', sha: null })
          entries.push(await blobEntry(sha, second))
          continue
        }
        entries.push(await blobEntry(sha, first))
      }
    } else {
      for (const line of git(['ls-tree', '-r', sha]).split('\n').filter(Boolean)) {
        const [, , , , path] = /^(\d+) (\w+) ([0-9a-f]+)\t(.*)$/.exec(line) ?? []
        entries.push(await blobEntry(sha, path))
      }
    }
    const tree = entries.length
      ? await api('POST', `/repos/${repo}/git/trees`, { ...(parentTree ? { base_tree: parentTree } : {}), tree: entries })
      : { sha: parentTree }
    const created = await api('POST', `/repos/${repo}/git/commits`, {
      message: parts.message,
      tree: tree.sha,
      parents: remoteParent ? [remoteParent] : [],
      author: parts.author,
      committer: parts.committer,
    })
    map[sha] = created.sha
    saveMap(map)
    if (created.sha !== sha) log(`mapped ${sha} -> ${created.sha}`)
  }

  const tip = map[local]
  const remote = await api('GET', `/repos/${repo}/git/ref/${apiRef(ref)}`)
  if (remote) await api('PATCH', `/repos/${repo}/git/refs/${apiRef(ref)}`, { sha: tip, force: true })
  else await api('POST', `/repos/${repo}/git/refs`, { ref, sha: tip })
  log(`exported ${ref} to ${tip}`)
}

async function blobEntry(commitSha, path) {
  const mode = git(['ls-tree', commitSha, '--', path]).split(' ')[0] || '100644'
  const content = execFileSync('git', ['cat-file', 'blob', `${commitSha}:${path}`], { env: { ...process.env, GIT_DIR: gitDir } })
  const blob = await api('POST', `/repos/${repo}/git/blobs`, { content: content.toString('base64'), encoding: 'base64' })
  return { path, mode, type: 'blob', sha: blob.sha }
}

const [command, ...refs] = process.argv.slice(2)
if (command === 'import') for (const ref of refs) await importRef(ref)
else if (command === 'export') {
  // A post-receive hook reports "<old> <new> <ref>" lines on stdin; plain CLI use passes refs.
  for (const ref of refs.length ? refs : ['refs/heads/main']) await exportRef(ref)
} else if (command === 'status') {
  console.log(JSON.stringify({ repo, gitDir }, null, 2))
  console.log(git(['for-each-ref', '--format=%(refname) %(objectname:short)']))
} else {
  throw new Error('usage: github-bridge.mjs <import|export|status> <ref>...')
}
