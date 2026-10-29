# @dsh-external/dsh-archive-mover

归档会话冷存器：被归档的会话目录 + 摘要缓存记录搬出 DSH 扫描面，列表/索引/摘要在内存与磁盘上都不再见到它们。

## 原理

DSH 的「归档」只改 `~/.dsh/storages/workspace.json` 里的 `archivedSessionIds` 名单，文件原地不动——所以归档再多也占着 `sessions/` 目录扫描、`session_projcache` 域、SQLite 搜索索引的全部体积。本插件把这个名单当作唯一事实来源做双向同步：

- 新进入归档名单 → 目录从 `~/.dsh/sessions/<projectKey>/<id>` 挪到 `~/.dsh/archived-sessions/<projectKey>/<id>`（同文件系统 rename，原子、零拷贝），摘要缓存 `session_projcache/sessions/<id>.json` 同步挪到 `archived-sessions/_projcache/`。
- 从归档名单消失（unarchive）→ 整个目录挪回原位，摘要缓存同样归位，`mover.json` 标记清除。
- agent 想临时翻已归档会话 → `archive_mover fetch <id>` 拉回热区并自动 hold `holdHours` 小时防立刻被搬走；`rearchive <id>` 立即送还。

## 安全约束

- 只搬非 live 会话（`ctx.sessions` 查不到）且最新文件 mtime 老于 60 秒，防搬到正在写的会话；
- 每轮 `movesPerRound`（默认 200）限速，大批归档不一次打爆 IO；
- 每个归档目标目录带 `mover.json` 标记，状态文件丢失后可按目录重建索引；
- `dryRun: true` 演练模式只打印 "would move N" 不真动文件，配置由 `cordis.patch.yml` 下发。

## 工具

`archive_mover(action, id?)`

| action | 作用 |
|---|---|
| `status` | 热区还剩多少、冷区已存多少、hold 中名单 |
| `fetch <id>` | 拉回指定已归档会话，hold `holdHours` 小时（默认 6） |
| `rearchive <id>` | 提前解除 hold 并立即送回冷区 |
| `sweep` | 立刻跑一轮 reconcile，不等定时器 |

## 构建与装配

```bash
bash scripts/build.sh          # 需 DSH_CHECKOUT 指向 dsh 源码 checkout
# 运行时注入：dev_inject_plugin /home/chenzongwei/dsh-archive-mover
# 持久化装配：dev_install_package dir=<dir> profile=web（bundle + link 入 profile）
```

配置字段见 `src/index.ts` 的 `Config`（`sessionsRoot`、`archiveRoot`、`projcacheDir`、`movesPerRound`、`scanIntervalMs`、`holdHours`、`dryRun`）。
