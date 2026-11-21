-- UTC timestamps use one canonical ISO-8601 representation throughout the app.
-- URL rows are permanent tombstones: never delete or replace an identifier.
PRAGMA foreign_keys = ON;

CREATE TABLE urls (
    identifier TEXT PRIMARY KEY NOT NULL,
    destination TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT,
    deleted_at TEXT,
    version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0)
);
CREATE INDEX urls_created ON urls(created_at, identifier);

CREATE TABLE admin_idempotency (
    admin TEXT NOT NULL,
    key TEXT NOT NULL,
    request_json TEXT NOT NULL,
    response_status INTEGER NOT NULL CHECK (response_status BETWEEN 100 AND 599),
    response_body TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    PRIMARY KEY (admin, key)
);
CREATE INDEX admin_idempotency_expiry ON admin_idempotency(expires_at);

CREATE TABLE click_events (
    identifier TEXT PRIMARY KEY NOT NULL,
    url TEXT NOT NULL REFERENCES urls(identifier),
    occurred_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
);
CREATE INDEX click_events_expiry ON click_events(expires_at);

CREATE TABLE daily_clicks (
    url TEXT NOT NULL REFERENCES urls(identifier),
    day TEXT NOT NULL,
    count INTEGER NOT NULL CHECK (count >= 0),
    PRIMARY KEY (url, day)
);
CREATE INDEX daily_clicks_day ON daily_clicks(day, url);

-- Queue acknowledgements happen only after the failed event is durably stored.
CREATE TABLE failed_events (
    identifier TEXT PRIMARY KEY NOT NULL,
    url TEXT NOT NULL REFERENCES urls(identifier),
    occurred_at TEXT NOT NULL,
    payload TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    last_error TEXT,
    expires_at TEXT NOT NULL
);
CREATE INDEX failed_events_expiry ON failed_events(expires_at);
CREATE INDEX failed_events_status ON failed_events(status, occurred_at, identifier);

CREATE TABLE exports (
    identifier TEXT PRIMARY KEY NOT NULL,
    start_day TEXT NOT NULL,
    end_day TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    requested_by TEXT NOT NULL,
    created_at TEXT NOT NULL,
    snapshot_at TEXT,
    last_enqueued_at TEXT,
    completed_at TEXT,
    expires_at TEXT,
    object_key TEXT NOT NULL UNIQUE,
    last_error TEXT,
    CHECK (julianday(end_day) - julianday(start_day) BETWEEN 0 AND 365)
);
CREATE INDEX exports_expiry ON exports(expires_at);
CREATE INDEX exports_created ON exports(created_at, identifier);

-- Materialized by INSERT SELECT in the same transaction as snapshot_at.
-- Once snapshot_at is set, retries use these rows without re-reading counters.
CREATE TABLE export_rows (
    export TEXT NOT NULL REFERENCES exports(identifier) ON DELETE CASCADE,
    url TEXT NOT NULL REFERENCES urls(identifier),
    day TEXT NOT NULL,
    count INTEGER NOT NULL CHECK (count >= 0),
    PRIMARY KEY (export, url, day)
);

-- INSERT OR IGNORE click_events is the sole aggregation operation: duplicates
-- cannot increment counters, including deliveries processed concurrently.
CREATE TRIGGER aggregate_new_click AFTER INSERT ON click_events
BEGIN
    INSERT INTO daily_clicks(url, day, count)
    VALUES (NEW.url, substr(NEW.occurred_at, 1, 10), 1)
    ON CONFLICT(url, day) DO UPDATE SET count = count + 1;
END;
