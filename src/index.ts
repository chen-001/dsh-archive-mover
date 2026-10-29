/**
 * dsh-archive-mover
 *
 * 归档会话是 DSH 列表/索引/摘要扫描面上的死重量（~1540 个目录、253MB 摘要域）。
 * 本插件把被归档会话的目录从 ~/.dsh/sessions/<project>/<id> 整体挪到
 * ~/.dsh/archived-sessions/<project>/<id>，并把摘要缓存记录
 * ~/.dsh/storages/session_projcache/sessions/<id>.json 挪到
 * ~/.dsh/archived-sessions/_projcache/<id>.json。
 *
 * DSH 本身永远写原路径：workspace.json 的 archivedSessionIds 是唯一事实来源。
 * 守护循环 diff 前后两份名单：新进归档 → 挪出；离开归档 → 挪回。
 * agent 想临时分析已归档会话时用 archive_mover fetch 拉回（自动 hold），
 * 用 archive_mover rearchive 提前归还。
 *
 * 安全约束：
 *  - 只搬非 live 会话（ctx.sessions 无实例）且日志 mtime 老于 60s；
 *  - 每轮移动上限，防一次性大搬家打爆 IO；
 *  - 崩溃恢复：归档目标目录带 mover.json 标记，状态文件丢失时可按目录重建。
 */

import type { Context } from '@deepseek-ai/cordis'
import type ToolRegistry from '@deepseek-ai/dsh-tools'
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  existsSync, mkdirSync, renameSync, readdirSync, readFileSync, writeFileSync, rmSync, statSync,
} from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import z from '@deepseek-ai/schemastery'

const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')

export const name = 'dsh-archive-mover'
export const inject = ['sessions', 'timer', 'tools']

export interface Config {
  sessionsRoot: string
  archiveRoot: string
  projcacheDir: string
  statePath: string
  workspacePath: string
  scanIntervalMs: number
  movesPerRound: number
  holdHours: number
  dryRun: boolean
}

export const Config = z.object({
  sessionsRoot: z.string().default(join(dshHome, 'sessions')),
  archiveRoot: z.string().default(join(dshHome, 'archived-sessions')),
  projcacheDir: z.string().default(join(dshHome, 'storages/session_projcache/sessions')),
  statePath: z.string().default(join(dshHome, 'archived-sessions/_mover-state.json')),
  workspacePath: z.string().default(join(dshHome, 'storages/workspace.json')),
  scanIntervalMs: z.number().default(30_000),
  movesPerRound: z.number().default(200),
  holdHours: z.number().default(6),
  dryRun: z.boolean().default(false),
})

interface MoverState {
  archived: Record<string, string>
  holdUntil: Record<string, number>
  project: Record<string, string>
}

const MOVER_MARK = 'mover.json'

function readJson<T>(path: string): T | undefined {
  try { return JSON.parse(readFileSync(path, 'utf8')) as T } catch { return undefined }
}

function loadState(cfg: Config): MoverState {
  const s = readJson<Partial<MoverState>>(cfg.statePath)
  return { archived: s?.archived ?? {}, holdUntil: s?.holdUntil ?? {}, project: s?.project ?? {} }
}

function saveState(cfg: Config, st: MoverState) {
  mkdirSync(cfg.archiveRoot, { recursive: true })
  const tmp = cfg.statePath + '.tmp'
  writeFileSync(tmp, JSON.stringify(st, null, 2))
  renameSync(tmp, cfg.statePath)
}

function archivedIdsFromWorkspace(path: string): Set<string> {
  const g = readJson<{ global?: { archivedSessionIds?: string[] } }>(path)
  return new Set(g?.global?.archivedSessionIds ?? [])
}

interface SessionLoc { projectDir: string; sessionDir: string }

function buildSessionIndex(cfg: Config): Map<string, SessionLoc> {
  const idx = new Map<string, SessionLoc>()
  if (!existsSync(cfg.sessionsRoot)) return idx
  for (const proj of readdirSync(cfg.sessionsRoot, { withFileTypes: true })) {
    if (!proj.isDirectory()) continue
    const pdir = join(cfg.sessionsRoot, proj.name)
    for (const ent of readdirSync(pdir, { withFileTypes: true })) {
      if (ent.isDirectory()) idx.set(ent.name, { projectDir: proj.name, sessionDir: join(pdir, ent.name) })
    }
  }
  return idx
}

function scanArchive(cfg: Config): { archived: Record<string, string>; project: Record<string, string> } {
  const archived: Record<string, string> = {}
  const project: Record<string, string> = {}
  if (!existsSync(cfg.archiveRoot)) return { archived, project }
  for (const ent of readdirSync(cfg.archiveRoot, { withFileTypes: true })) {
    if (!ent.isDirectory() || ent.name.startsWith('_')) continue
    const pdir = join(cfg.archiveRoot, ent.name)
    for (const s of readdirSync(pdir, { withFileTypes: true })) {
      if (!s.isDirectory()) continue
      const sdir = join(pdir, s.name)
      if (existsSync(join(sdir, MOVER_MARK))) { archived[s.name] = sdir; project[s.name] = ent.name }
    }
  }
  return { archived, project }
}

function newestMtime(dir: string): number {
  let m = 0
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    try {
      const st = e.isDirectory() ? newestMtime(p) : statSync(p).mtimeMs
      if (st > m) m = st
    } catch { /* skip */ }
  }
  return m
}

function moveSessionToArchive(cfg: Config, st: MoverState, id: string, projectDir: string, sessionDir: string) {
  const dest = join(cfg.archiveRoot, projectDir, id)
  mkdirSync(dirname(dest), { recursive: true })
  renameSync(sessionDir, dest)
  writeFileSync(join(dest, MOVER_MARK), JSON.stringify({ id, project: projectDir, movedAt: Date.now() }))
  const cache = join(cfg.projcacheDir, `${id}.json`)
  if (existsSync(cache)) {
    mkdirSync(join(cfg.archiveRoot, '_projcache'), { recursive: true })
    renameSync(cache, join(cfg.archiveRoot, '_projcache', `${id}.json`))
  }
  st.archived[id] = dest
  st.project[id] = projectDir
}

function restoreSession(cfg: Config, st: MoverState, id: string): { ok: boolean; to?: string; reason?: string } {
  const src = st.archived[id]
  const proj = st.project[id]
  if (!src || !proj) return { ok: false, reason: 'not-in-archive-index' }
  if (!existsSync(src)) return { ok: false, reason: 'archive-dir-missing' }
  const dest = join(cfg.sessionsRoot, proj, id)
  if (existsSync(dest)) return { ok: false, reason: 'target-exists' }
  mkdirSync(join(cfg.sessionsRoot, proj), { recursive: true })
  renameSync(src, dest)
  try { rmSync(join(dest, MOVER_MARK), { force: true }) } catch { /* ignore */ }
  const cache = join(cfg.archiveRoot, '_projcache', `${id}.json`)
  if (existsSync(cache)) renameSync(cache, join(cfg.projcacheDir, `${id}.json`))
  delete st.archived[id]
  delete st.project[id]
  return { ok: true, to: dest }
}

type AppContext = Context & {
  tools: ToolRegistry
  sessions: { get(id: string): unknown }
  timer: {
    timeout(cb: () => void, ms: number): () => void
    interval(cb: () => void, ms: number): () => void
  }
}

export function apply(ctx: AppContext, cfg: Config) {
  mkdirSync(cfg.archiveRoot, { recursive: true })
  const state = loadState(cfg)
  let busy = false

  const log = (msg: string) => { try { console.log(`[archive-mover] ${msg}`) } catch { /* noop */ } }
  const isLive = (id: string) => { try { return !!ctx.sessions?.get?.(id) } catch { return false } }

  // 启动自愈：归档区目录重建状态索引
  const found = scanArchive(cfg)
  let healed = 0
  for (const id of Object.keys(found.archived)) {
    if (!state.archived[id]) { state.archived[id] = found.archived[id]; state.project[id] = found.project[id]; healed++ }
  }
  if (healed) { saveState(cfg, state); log(`healed ${healed} entries from archive dirs`) }

  function reconcile() {
    if (busy) return
    busy = true
    try {
      const nowArchived = archivedIdsFromWorkspace(cfg.workspacePath)
      const added = [...nowArchived].filter(id => !state.archived[id])
      const removed = Object.keys(state.archived).filter(id => !nowArchived.has(id))
      if (!added.length && !removed.length) return
      const index = buildSessionIndex(cfg)
      const now = Date.now()
      let moved = 0, restored = 0, skippedLive = 0, skippedMissing = 0, skippedHold = 0

      for (const id of added) {
        if (moved >= cfg.movesPerRound) break
        const hold = state.holdUntil[id]
        if (hold === 0 || (typeof hold === 'number' && now < hold)) { skippedHold++; continue }
        const loc = index.get(id)
        if (!loc) { skippedMissing++; continue }
        if (isLive(id) || now - newestMtime(loc.sessionDir) < 60_000) { skippedLive++; continue }
        if (cfg.dryRun) { moved++; continue }
        try { moveSessionToArchive(cfg, state, id, loc.projectDir, loc.sessionDir); moved++ }
        catch (e) { log(`move ${id} failed: ${String(e)}`) }
      }

      for (const id of removed) {
        if (cfg.dryRun) { restored++; continue }
        const r = restoreSession(cfg, state, id)
        if (r.ok) restored++
        else log(`restore ${id} failed: ${r.reason}`)
      }

      if (!cfg.dryRun) saveState(cfg, state)
      log(`reconcile${cfg.dryRun ? ' (dryRun)' : ''}: moved=${moved} restored=${restored} liveSkip=${skippedLive} holdSkip=${skippedHold} missing=${skippedMissing} archivedSet=${nowArchived.size}`)
    } finally { busy = false }
  }

  // 首次延迟启动，让 storage/domain 先就位
  ctx.effect(() => ctx.timer.timeout(reconcile, 15_000), 'archive-mover:first')
  ctx.effect(() => ctx.timer.interval(reconcile, cfg.scanIntervalMs), 'archive-mover:loop')

  // ── agent 工具 ────────────────────────────────────────────────────────────

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'archive_mover',
    description:
      '已归档会话冷存管理。归档会话文件被搬到 ~/.dsh/archived-sessions，不占列表/索引/摘要扫描面。' +
      'action=status 看规模；fetch 把指定会话拉回热区（自动 hold 数小时防被立刻搬走）；' +
      'rearchive 立即把已取回的会话送回冷区；sweep 立刻跑一轮 reconcile。' +
      '要翻已归档会话的原文/事件时先 fetch，用完 rearchive 或等 hold 过期自动再归档。',
    parameters: {
      action: { type: 'string', required: true, description: 'status | fetch | rearchive | sweep' },
      id: { type: 'string', description: '会话 id（fetch/rearchive 必填）' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_a: unknown, v: unknown) => [{ type: 'text' as const, text: JSON.stringify(v, null, 2) }],
    },
    async execute(args: { action: string; id?: string }) {
      const nowArchived = archivedIdsFromWorkspace(cfg.workspacePath)
      switch (args.action) {
        case 'status': {
          const idx = buildSessionIndex(cfg)
          const arc = scanArchive(cfg)
          return {
            sessionsOnDisk: idx.size,
            archivedInWorkspace: nowArchived.size,
            archivedInCold: Object.keys(arc.archived).length,
            heldIds: Object.entries(state.holdUntil).filter(([, t]) => t === 0 || t > Date.now()).map(([id]) => id),
            projcacheColdFiles: existsSync(join(cfg.archiveRoot, '_projcache')) ? readdirSync(join(cfg.archiveRoot, '_projcache')).length : 0,
          }
        }
        case 'fetch': {
          if (!args.id) throw new Error('id required')
          if (!state.archived[args.id]) {
            if (nowArchived.has(args.id)) return { ok: false, reason: 'archived-but-still-warm; 先 sweep 再 fetch' }
            return { ok: false, reason: 'not archived' }
          }
          const r = restoreSession(cfg, state, args.id)
          if (!r.ok) return r
          state.holdUntil[args.id] = Date.now() + cfg.holdHours * 3600_000
          saveState(cfg, state)
          return {
            ok: true, to: r.to,
            holdUntil: new Date(state.holdUntil[args.id]).toISOString(),
            note: '已拉回热区。archivedSessionIds 仍含此 id，hold 期内 reconcile 跳过，过期自动再归档。',
          }
        }
        case 'rearchive': {
          if (!args.id) throw new Error('id required')
          delete state.holdUntil[args.id]
          const idx = buildSessionIndex(cfg)
          const loc = idx.get(args.id)
          if (loc && nowArchived.has(args.id) && !isLive(args.id) && Date.now() - newestMtime(loc.sessionDir) >= 60_000) {
            moveSessionToArchive(cfg, state, args.id, loc.projectDir, loc.sessionDir)
            saveState(cfg, state)
            return { ok: true, moved: true }
          }
          saveState(cfg, state)
          return { ok: true, moved: false, note: loc ? '会话仍热或不在归档名单，下轮 reconcile 再处理' : '磁盘上找不到该会话目录' }
        }
        case 'sweep': {
          reconcile()
          return { ok: true }
        }
        default:
          throw new Error(`unknown action ${args.action}`)
      }
    },
  })), 'dsh-archive-mover:tool')
}
