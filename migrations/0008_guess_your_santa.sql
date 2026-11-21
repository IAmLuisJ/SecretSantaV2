ALTER TABLE seasons ADD COLUMN santa_guess_enabled INTEGER NOT NULL DEFAULT 0 CHECK (santa_guess_enabled IN (0, 1));
ALTER TABLE seasons ADD COLUMN santa_guess_revealed INTEGER NOT NULL DEFAULT 0
  CHECK (santa_guess_revealed IN (0, 1) AND (
    santa_guess_revealed = 0 OR (santa_guess_enabled = 1 AND active_draw_id IS NOT NULL)
  ));

CREATE TABLE santa_guesses (
  draw_id TEXT NOT NULL,
  guesser_id TEXT NOT NULL,
  guessed_giver_id TEXT NOT NULL,
  CHECK (guesser_id <> guessed_giver_id),
  PRIMARY KEY (draw_id, guesser_id),
  FOREIGN KEY (draw_id, guesser_id) REFERENCES assignments(draw_id, recipient_id) ON DELETE CASCADE,
  FOREIGN KEY (draw_id, guessed_giver_id) REFERENCES assignments(draw_id, giver_id) ON DELETE CASCADE
);

CREATE INDEX santa_guesses_by_giver ON santa_guesses(draw_id, guessed_giver_id);
