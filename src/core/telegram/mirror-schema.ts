/** The schema version a current mirror has: the number of `MIGRATIONS`. */
export const MIRROR_VERSION = 3

/**
 * `MIGRATIONS[i]` takes a mirror from version `i` to `i + 1`; entry 0 creates
 * the first schema. A change to the schema adds an entry and never edits one,
 * so a mirror of any older version reaches the current one.
 *
 * A chat is Telegram's marked id as text; a message is its chat and its id in
 * that chat. Times are Unix milliseconds, durations seconds. A boolean is 0 or
 * 1. `entities`, `media`, `action`, `reply`, `forward` and `reactions` hold
 * JSON (see `mirror-input.ts`) and are NULL when empty. `deleted` holds only
 * where and when a message was deleted for everyone, no content, so that a
 * delivery arriving after its delete is dropped; its `chat` is NULL for a
 * delete that named none (private chats and basic groups). `gaps` are the
 * spans the sync service was not watching. `sync_list` holds the supergroups
 * and channels the user chose to keep: `added` is when a chat was put on the
 * list and `seeded` when its newest messages were fetched after that, NULL
 * until then.
 */
export const MIGRATIONS: readonly string[] = [
  `
CREATE TABLE chats (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('user', 'bot', 'self', 'group', 'supergroup', 'channel')),
  name TEXT,
  username TEXT,
  forum INTEGER NOT NULL DEFAULT 0 CHECK (forum IN (0, 1)),
  left INTEGER NOT NULL DEFAULT 0 CHECK (left IN (0, 1)),
  can_send INTEGER CHECK (can_send IN (0, 1)),
  archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
  followed INTEGER NOT NULL DEFAULT 0 CHECK (followed IN (0, 1)),
  unread INTEGER NOT NULL DEFAULT 0,
  read_max INTEGER,
  top_id INTEGER,
  last_ts INTEGER,
  ttl INTEGER,
  updated INTEGER NOT NULL
);

CREATE TABLE topics (
  chat TEXT NOT NULL,
  id INTEGER NOT NULL,
  title TEXT,
  closed INTEGER NOT NULL DEFAULT 0 CHECK (closed IN (0, 1)),
  updated INTEGER NOT NULL,
  PRIMARY KEY (chat, id)
);

CREATE TABLE messages (
  chat TEXT NOT NULL,
  id INTEGER NOT NULL,
  topic INTEGER,
  ts INTEGER NOT NULL,
  from_me INTEGER NOT NULL DEFAULT 0 CHECK (from_me IN (0, 1)),
  sender TEXT,
  sender_name TEXT,
  kind TEXT NOT NULL DEFAULT 'message' CHECK (kind IN ('message', 'service')),
  body TEXT,
  entities TEXT,
  media TEXT,
  action TEXT,
  reply TEXT,
  forward TEXT,
  grouped TEXT,
  reactions TEXT,
  edited INTEGER,
  expires INTEGER,
  view_once INTEGER NOT NULL DEFAULT 0 CHECK (view_once IN (0, 1)),
  self_destruct INTEGER,
  kept INTEGER NOT NULL DEFAULT 0 CHECK (kept IN (0, 1)),
  received INTEGER NOT NULL,
  PRIMARY KEY (chat, id)
);
CREATE INDEX messages_ts ON messages (chat, ts);
CREATE INDEX messages_id ON messages (id);
CREATE INDEX messages_expires ON messages (expires) WHERE expires IS NOT NULL;

CREATE TABLE edits (
  chat TEXT NOT NULL,
  id INTEGER NOT NULL,
  seq INTEGER NOT NULL,
  at INTEGER NOT NULL,
  body TEXT,
  entities TEXT,
  media TEXT,
  PRIMARY KEY (chat, id, seq)
);

CREATE TABLE deleted (
  chat TEXT,
  id INTEGER NOT NULL,
  at INTEGER NOT NULL
);
CREATE UNIQUE INDEX deleted_key ON deleted (coalesce(chat, ''), id);
CREATE INDEX deleted_id ON deleted (id);

CREATE TABLE gaps (
  start INTEGER NOT NULL,
  until INTEGER NOT NULL
);

CREATE TABLE meta (
  key TEXT PRIMARY KEY,
  value TEXT
);
`,
  // Entry 1 serves a search across every chat, which reads messages in time order.
  "CREATE INDEX messages_time ON messages (ts, chat, id);",
  // Entry 2 names the supergroups and channels the mirror keeps.
  "CREATE TABLE sync_list (chat TEXT PRIMARY KEY, added INTEGER NOT NULL, seeded INTEGER);",
]
