CREATE TABLE processing_settings (
  identifier TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL,
  batch_limit INTEGER NOT NULL,
  score REAL NOT NULL,
  description TEXT,
  attachment BLOB NOT NULL
);
INSERT INTO processing_settings VALUES ('default', 1, 25, 0.75, NULL, X'007FFF');
