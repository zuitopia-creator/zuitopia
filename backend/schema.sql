CREATE TABLE IF NOT EXISTS posts (
 id TEXT PRIMARY KEY,
 source_url TEXT NOT NULL UNIQUE,
 topic TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('pending','published','rejected')),
 content TEXT NOT NULL,
 version INTEGER NOT NULL DEFAULT 1,
 updated_at INTEGER NOT NULL,
 published_at INTEGER
);
CREATE INDEX IF NOT EXISTS posts_feed ON posts(status, published_at DESC);
CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS login_attempts (key TEXT PRIMARY KEY, count INTEGER NOT NULL, resets_at INTEGER NOT NULL);
