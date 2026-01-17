import { Database } from "bun:sqlite"
import { drizzle } from "drizzle-orm/bun-sqlite"
import { lazy } from "../util/lazy"
import { Global } from "../global"
import { Log } from "../util/log"
import { migrations } from "./migrations.generated"
import { migrateFromJson } from "./json-migration"
import { NamedError } from "@opencode-ai/util/error"
import z from "zod"
import path from "path"

export const NotFoundError = NamedError.create(
  "NotFoundError",
  z.object({
    message: z.string(),
  }),
)

const log = Log.create({ service: "db" })

export type DB = ReturnType<typeof drizzle>

const connection = lazy(() => {
  const dbPath = path.join(Global.Path.data, "opencode.db")
  log.info("opening database", { path: dbPath })

  const sqlite = new Database(dbPath, { create: true })

  sqlite.run("PRAGMA journal_mode = WAL")
  sqlite.run("PRAGMA synchronous = NORMAL")
  sqlite.run("PRAGMA busy_timeout = 5000")
  sqlite.run("PRAGMA cache_size = -64000")
  sqlite.run("PRAGMA foreign_keys = ON")

  migrate(sqlite)

  // Run JSON migration asynchronously after schema is ready
  migrateFromJson(sqlite).catch((e) => log.error("json migration failed", { error: e }))

  return drizzle(sqlite)
})

function migrate(sqlite: Database) {
  sqlite.run(`
    CREATE TABLE IF NOT EXISTS _migrations (
      name TEXT PRIMARY KEY,
      applied_at INTEGER NOT NULL
    )
  `)

  const applied = new Set(
    sqlite
      .query<{ name: string }, []>("SELECT name FROM _migrations")
      .all()
      .map((r) => r.name),
  )

  for (const migration of migrations) {
    if (applied.has(migration.name)) continue
    log.info("applying migration", { name: migration.name })
    sqlite.run(migration.sql)
    sqlite.run("INSERT INTO _migrations (name, applied_at) VALUES (?, ?)", [migration.name, Date.now()])
  }
}

export function db() {
  return connection()
}
