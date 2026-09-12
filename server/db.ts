import { Database } from 'bun:sqlite';

export const db = new Database('snagger.db');
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS channels (
    key         TEXT PRIMARY KEY,
    source      TEXT NOT NULL,
    channel_id  TEXT NOT NULL,
    name        TEXT NOT NULL,
    icon        TEXT,
    "group"     TEXT,
    stream_url  TEXT,
    last_seen   INTEGER NOT NULL,
    m3u_json    TEXT,
    epg_json    TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_channels_source ON channels(source);
  CREATE INDEX IF NOT EXISTS idx_channels_name   ON channels(name);

  CREATE TABLE IF NOT EXISTS programmes (
    channel_key TEXT NOT NULL,
    start       TEXT NOT NULL,
    stop        TEXT NOT NULL,
    data        TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_programmes_channel ON programmes(channel_key);
`);

const userVersion = (db.query('PRAGMA user_version').get() as { user_version: number }).user_version;

if (userVersion < 1) {
  const migrate = db.transaction(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS templates (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        name        TEXT NOT NULL UNIQUE,
        created_at  INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS meta (
        key   TEXT PRIMARY KEY,
        value TEXT
      );
    `);

    db.run(`INSERT OR IGNORE INTO templates (name, created_at) VALUES ('Default', ?)`, [Date.now()]);
    const def = db.query<{ id: number }, []>(`SELECT id FROM templates WHERE name = 'Default'`).get()!;
    db.run(`INSERT OR IGNORE INTO meta (key, value) VALUES ('active_template', ?)`, [String(def.id)]);

    const oldExists = (db
      .query<{ n: number }, []>(`SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name='overrides' AND sql NOT LIKE '%template_id%'`)
      .get()!).n > 0;

    if (oldExists) {
      db.exec(`
        CREATE TABLE overrides_new (
          template_id INTEGER NOT NULL REFERENCES templates(id) ON DELETE CASCADE,
          key         TEXT NOT NULL,
          enabled     INTEGER NOT NULL DEFAULT 1,
          name        TEXT,
          icon        TEXT,
          "group"     TEXT,
          PRIMARY KEY (template_id, key)
        );
        INSERT INTO overrides_new (template_id, key, enabled, name, icon, "group")
          SELECT ${def.id}, key, enabled, name, icon, "group" FROM overrides;
        DROP TABLE overrides;
        ALTER TABLE overrides_new RENAME TO overrides;
      `);
    } else {
      db.exec(`
        CREATE TABLE IF NOT EXISTS overrides (
          template_id INTEGER NOT NULL REFERENCES templates(id) ON DELETE CASCADE,
          key         TEXT NOT NULL,
          enabled     INTEGER NOT NULL DEFAULT 1,
          name        TEXT,
          icon        TEXT,
          "group"     TEXT,
          PRIMARY KEY (template_id, key)
        );
      `);
    }

    db.exec(`PRAGMA user_version = 1`);
  });
  migrate();
}

const userVersionV2 = (db.query('PRAGMA user_version').get() as { user_version: number }).user_version;
if (userVersionV2 < 2) {
  const migrate = db.transaction(() => {
    const hasStreamType = (db
      .query<{ n: number }, []>(`SELECT count(*) AS n FROM pragma_table_info('channels') WHERE name = 'stream_type'`)
      .get()!).n > 0;
    if (!hasStreamType) {
      db.exec(`ALTER TABLE channels ADD COLUMN stream_type TEXT NOT NULL DEFAULT 'live'`);
    }
    db.exec(`CREATE INDEX IF NOT EXISTS idx_channels_type ON channels(stream_type)`);
    db.exec(`PRAGMA user_version = 2`);
  });
  migrate();
}

const userVersionV3 = (db.query('PRAGMA user_version').get() as { user_version: number }).user_version;
if (userVersionV3 < 3) {
  const migrate = db.transaction(() => {
    const hasProxyMode = (db
      .query<{ n: number }, []>(`SELECT count(*) AS n FROM pragma_table_info('templates') WHERE name = 'proxy_mode'`)
      .get()!).n > 0;
    if (!hasProxyMode) {
      db.exec(`ALTER TABLE templates ADD COLUMN proxy_mode INTEGER NOT NULL DEFAULT 0`);
    }
    db.exec(`
      CREATE TABLE IF NOT EXISTS imdb_resolutions (
        imdb_id    TEXT NOT NULL,
        episode    TEXT NOT NULL DEFAULT '',
        url        TEXT NOT NULL,
        info_hash  TEXT,
        title      TEXT,
        quality    TEXT,
        resolved_at INTEGER NOT NULL,
        expires_at  INTEGER NOT NULL,
        PRIMARY KEY (imdb_id, episode)
      );
      CREATE INDEX IF NOT EXISTS idx_imdb_expires ON imdb_resolutions(expires_at);
    `);
    db.exec(`PRAGMA user_version = 3`);
  });
  migrate();
}

import { randomBytes } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';

const userVersionV4 = (db.query('PRAGMA user_version').get() as { user_version: number }).user_version;
if (userVersionV4 < 4) {
  const migrate = db.transaction(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS sources (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        name            TEXT NOT NULL UNIQUE,
        type            TEXT NOT NULL,
        config_json     TEXT NOT NULL,
        enabled         INTEGER NOT NULL DEFAULT 1,
        created_at      INTEGER NOT NULL,
        last_refreshed  INTEGER,
        last_status     TEXT
      );
    `);

    const empty = (db.query<{ n: number }, []>(`SELECT count(*) AS n FROM sources`).get()!).n === 0;
    if (empty) {
      const insert = db.prepare(
        `INSERT INTO sources (name, type, config_json, enabled, created_at) VALUES (?, ?, ?, 1, ?)`
      );
      const now = Date.now();

      // Seed PlutoTV (no config needed)
      insert.run('PlutoTV', 'plutotv', '{}', now);

      // Migrate xtream-providers.json if present
      if (existsSync('./xtream-providers.json')) {
        try {
          const arr = JSON.parse(readFileSync('./xtream-providers.json', 'utf-8')) as Array<{
            name: string; host: string; username: string; password: string;
            output?: string; includeMovies?: boolean;
          }>;
          for (const p of arr) {
            if (!p?.name || !p?.host || !p?.username || !p?.password) continue;
            const cfg = {
              host: p.host,
              username: p.username,
              password: p.password,
              output: p.output ?? 'ts',
              includeMovies: p.includeMovies !== false,
            };
            insert.run(p.name, 'xtream', JSON.stringify(cfg), now);
          }
        } catch (e) {
          console.warn('Failed to migrate xtream-providers.json:', e);
        }
      }
    }

    // Migrate resolvers.json into meta
    if (existsSync('./resolvers.json')) {
      try {
        const cfg = JSON.parse(readFileSync('./resolvers.json', 'utf-8')) as {
          realdebrid?: { apiKey?: string };
          torrentio?: { endpoint?: string };
        };
        if (cfg.realdebrid?.apiKey) {
          db.run(
            `INSERT OR IGNORE INTO meta (key, value) VALUES ('setting:rd_api_key', ?)`,
            [cfg.realdebrid.apiKey]
          );
        }
        if (cfg.torrentio?.endpoint) {
          db.run(
            `INSERT OR IGNORE INTO meta (key, value) VALUES ('setting:torrentio_endpoint', ?)`,
            [cfg.torrentio.endpoint]
          );
        }
      } catch (e) {
        console.warn('Failed to migrate resolvers.json:', e);
      }
    }

    db.exec(`PRAGMA user_version = 4`);
  });
  migrate();
}

const userVersionV5 = (db.query('PRAGMA user_version').get() as { user_version: number }).user_version;
if (userVersionV5 < 5) {
  const migrate = db.transaction(() => {
    const hasInfoJson = (db
      .query<{ n: number }, []>(`SELECT count(*) AS n FROM pragma_table_info('sources') WHERE name = 'info_json'`)
      .get()!).n > 0;
    if (!hasInfoJson) {
      db.exec(`ALTER TABLE sources ADD COLUMN info_json TEXT`);
    }
    db.exec(`PRAGMA user_version = 5`);
  });
  migrate();
}

const userVersionV6 = (db.query('PRAGMA user_version').get() as { user_version: number }).user_version;
if (userVersionV6 < 6) {
  const migrate = db.transaction(() => {
    // Convert single-credential xtream configs into credentials:[{username, password}]
    const rows = db.query<{ id: number; config_json: string }, []>(
      `SELECT id, config_json FROM sources WHERE type = 'xtream'`
    ).all();
    for (const r of rows) {
      const cfg = JSON.parse(r.config_json) as Record<string, unknown>;
      if (!Array.isArray(cfg.credentials) && typeof cfg.username === 'string' && typeof cfg.password === 'string') {
        cfg.credentials = [{ username: cfg.username, password: cfg.password }];
        delete cfg.username;
        delete cfg.password;
        db.run(`UPDATE sources SET config_json = ? WHERE id = ?`, [JSON.stringify(cfg), r.id]);
      }
    }
    // Clear the v5 info_json since the new shape is per-credential
    db.exec(`UPDATE sources SET info_json = NULL WHERE type = 'xtream'`);
    db.exec(`PRAGMA user_version = 6`);
  });
  migrate();
}

const userVersionV7 = (db.query('PRAGMA user_version').get() as { user_version: number }).user_version;
if (userVersionV7 < 7) {
  const migrate = db.transaction(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS imdb_pins (
        imdb_id    TEXT NOT NULL,
        season     INTEGER NOT NULL DEFAULT -1,
        episode    INTEGER NOT NULL DEFAULT -1,
        pins_json  TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (imdb_id, season, episode)
      );
    `);
    db.exec(`PRAGMA user_version = 7`);
  });
  migrate();
}

const userVersionV8 = (db.query('PRAGMA user_version').get() as { user_version: number }).user_version;
if (userVersionV8 < 8) {
  const migrate = db.transaction(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS series_episodes (
        series_key       TEXT NOT NULL,        -- references channels.key (the series row)
        season           INTEGER NOT NULL,
        episode          INTEGER NOT NULL,
        episode_id       TEXT NOT NULL,        -- provider's episode id (used to build stream URL)
        title            TEXT,
        container_ext    TEXT,                 -- e.g. "mp4", "mkv"
        info_json        TEXT,                 -- raw metadata
        fetched_at       INTEGER NOT NULL,
        PRIMARY KEY (series_key, season, episode)
      );
      CREATE INDEX IF NOT EXISTS idx_episodes_series ON series_episodes(series_key);
    `);
    db.exec(`PRAGMA user_version = 8`);
  });
  migrate();
}

const userVersionV9 = (db.query('PRAGMA user_version').get() as { user_version: number }).user_version;
if (userVersionV9 < 9) {
  const migrate = db.transaction(() => {
    const hasCol = (db
      .query<{ n: number }, []>(`SELECT count(*) AS n FROM pragma_table_info('sources') WHERE name = 'refresh_interval_ms'`)
      .get()!).n > 0;
    if (!hasCol) {
      // Default 6 hours; UI/API allow override. 0 = manual only.
      db.exec(`ALTER TABLE sources ADD COLUMN refresh_interval_ms INTEGER NOT NULL DEFAULT 21600000`);
      // Sensible defaults per type
      db.exec(`UPDATE sources SET refresh_interval_ms = 3600000  WHERE type = 'plutotv'`); // 1h (EPG-heavy)
      db.exec(`UPDATE sources SET refresh_interval_ms = 43200000 WHERE type = 'm3u'`);     // 12h
    }
    db.exec(`PRAGMA user_version = 9`);
  });
  migrate();
}

const userVersionV10 = (db.query('PRAGMA user_version').get() as { user_version: number }).user_version;
if (userVersionV10 < 10) {
  const migrate = db.transaction(() => {
    // 1) series_episodes: add a proper extra_json column + drop the container_ext hack we
    //    were using to stash Pluto's stitched paths.
    const hasExtra = (db
      .query<{ n: number }, []>(`SELECT count(*) AS n FROM pragma_table_info('series_episodes') WHERE name = 'extra_json'`)
      .get()!).n > 0;
    if (!hasExtra) {
      db.exec(`ALTER TABLE series_episodes ADD COLUMN extra_json TEXT`);
      // For rows whose container_ext is a /stitch/... path (Pluto), promote it.
      db.exec(`
        UPDATE series_episodes
        SET extra_json = json_object('stitchedPath', container_ext),
            container_ext = NULL
        WHERE container_ext LIKE '/stitch/%'
      `);
    }

    // 2) Opaque-token vouchers for hiding upstream URLs in /imdb output.
    db.exec(`
      CREATE TABLE IF NOT EXISTS stream_vouchers (
        token       TEXT PRIMARY KEY,
        target_url  TEXT NOT NULL,
        created_at  INTEGER NOT NULL,
        expires_at  INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_vouchers_target  ON stream_vouchers(target_url);
      CREATE INDEX IF NOT EXISTS idx_vouchers_expires ON stream_vouchers(expires_at);
    `);

    db.exec(`PRAGMA user_version = 10`);
  });
  migrate();
}

const userVersionV11 = (db.query('PRAGMA user_version').get() as { user_version: number }).user_version;
if (userVersionV11 < 11) {
  const migrate = db.transaction(() => {
    const has = (db
      .query<{ n: number }, []>(`SELECT count(*) AS n FROM pragma_table_info('overrides') WHERE name = 'imdb_id'`)
      .get()!).n > 0;
    if (!has) {
      db.exec(`ALTER TABLE overrides ADD COLUMN imdb_id TEXT`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_overrides_imdb ON overrides(imdb_id) WHERE imdb_id IS NOT NULL`);
    }
    db.exec(`PRAGMA user_version = 11`);
  });
  migrate();
}

const userVersionV12 = (db.query('PRAGMA user_version').get() as { user_version: number }).user_version;
if (userVersionV12 < 12) {
  const migrate = db.transaction(() => {
    const has = (db
      .query<{ n: number }, []>(`SELECT count(*) AS n FROM pragma_table_info('templates') WHERE name = 'exports_json'`)
      .get()!).n > 0;
    if (!has) {
      db.exec(`ALTER TABLE templates ADD COLUMN exports_json TEXT`);
    }
    db.exec(`PRAGMA user_version = 12`);
  });
  migrate();
}

export type TemplateExports = { m3u: boolean; epg: boolean };

export function parseTemplateExports(raw: string | null | undefined): TemplateExports {
  if (!raw) return { m3u: true, epg: true };
  try {
    const v = JSON.parse(raw) as Partial<TemplateExports>;
    return { m3u: v.m3u !== false, epg: v.epg !== false };
  } catch { return { m3u: true, epg: true }; }
}

export function getSetting(key: string): string | null {
  const row = db.query<{ value: string }, [string]>(
    `SELECT value FROM meta WHERE key = ?`
  ).get('setting:' + key);
  return row?.value ?? null;
}

export function setSetting(key: string, value: string | null): void {
  if (value === null || value === '') {
    db.run(`DELETE FROM meta WHERE key = ?`, ['setting:' + key]);
  } else {
    db.run(`INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)`, ['setting:' + key, value]);
  }
}

export function listSettings(): Record<string, string> {
  const rows = db.query<{ key: string; value: string }, []>(
    `SELECT key, value FROM meta WHERE key LIKE 'setting:%'`
  ).all();
  const out: Record<string, string> = {};
  for (const r of rows) out[r.key.slice('setting:'.length)] = r.value;
  return out;
}


export function getProxySecret(): string {
  const row = db.query<{ value: string }, []>(`SELECT value FROM meta WHERE key = 'proxy_secret'`).get();
  if (row?.value) return row.value;
  const secret = randomBytes(32).toString('hex');
  db.run(`INSERT OR REPLACE INTO meta (key, value) VALUES ('proxy_secret', ?)`, [secret]);
  return secret;
}

export function getActiveTemplateId(): number {
  const row = db.query<{ value: string }, []>(`SELECT value FROM meta WHERE key = 'active_template'`).get();
  if (row) return Number(row.value);
  const def = db.query<{ id: number }, []>(`SELECT id FROM templates ORDER BY id LIMIT 1`).get();
  if (!def) throw new Error('No templates defined');
  db.run(`INSERT OR REPLACE INTO meta (key, value) VALUES ('active_template', ?)`, [String(def.id)]);
  return def.id;
}

export function getTemplateByName(name: string): { id: number; name: string } | null {
  return db.query<{ id: number; name: string }, [string]>(`SELECT id, name FROM templates WHERE name = ?`).get(name);
}

export function getTemplateById(id: number): { id: number; name: string } | null {
  return db.query<{ id: number; name: string }, [number]>(`SELECT id, name FROM templates WHERE id = ?`).get(id);
}
