CREATE TABLE elf_mail_messages (
  id INTEGER PRIMARY KEY,
  draw_id TEXT NOT NULL,
  giver_id TEXT NOT NULL,
  sender TEXT NOT NULL CHECK (sender IN ('giver', 'recipient')),
  request_id TEXT NOT NULL,
  body TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 500),
  UNIQUE (draw_id, giver_id, sender, request_id),
  FOREIGN KEY (draw_id, giver_id) REFERENCES assignments(draw_id, giver_id) ON DELETE CASCADE
);

CREATE INDEX elf_mail_messages_by_assignment ON elf_mail_messages(draw_id, giver_id, id);
