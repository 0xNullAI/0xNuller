-- Private visual preferences do not alter public character cards or device permissions.
CREATE TABLE character_appearances (
  user_id TEXT NOT NULL,
  relationship_id TEXT NOT NULL,
  photo_id TEXT,
  scale INTEGER NOT NULL CHECK(scale BETWEEN 15 AND 70),
  position TEXT NOT NULL CHECK(position IN ('left','center','right')),
  version INTEGER NOT NULL CHECK(version > 0),
  PRIMARY KEY(user_id, relationship_id),
  FOREIGN KEY(user_id, relationship_id) REFERENCES character_relationships(user_id,id) ON DELETE CASCADE
);
