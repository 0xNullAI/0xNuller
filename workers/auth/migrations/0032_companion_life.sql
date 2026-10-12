-- Structured, explicitly authored private relationship history; no public profile projection.
CREATE TABLE companion_life_records (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  relationship_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('person','event','milestone','lifecycle')),
  label TEXT NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  occurred_on TEXT,
  person_ids TEXT NOT NULL DEFAULT '[]',
  version INTEGER NOT NULL CHECK(version > 0),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  PRIMARY KEY(user_id,id),
  FOREIGN KEY(user_id,relationship_id) REFERENCES character_relationships(user_id,id) ON DELETE CASCADE
);
CREATE INDEX idx_companion_life_relationship ON companion_life_records(user_id,relationship_id,deleted_at,updated_at);
CREATE UNIQUE INDEX idx_companion_life_stage ON companion_life_records(user_id,relationship_id)
  WHERE kind='lifecycle' AND deleted_at IS NULL;
CREATE TRIGGER companion_life_relationship_deleted AFTER UPDATE OF deleted_at ON character_relationships
WHEN NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL BEGIN
  UPDATE companion_life_records SET title='',content='',label='',occurred_on=NULL,person_ids='[]',
    deleted_at=NEW.deleted_at,updated_at=NEW.deleted_at,version=version+1
    WHERE user_id=NEW.user_id AND relationship_id=NEW.id AND deleted_at IS NULL;
END;
CREATE TRIGGER companion_life_person_deleted AFTER UPDATE OF deleted_at ON companion_life_records
WHEN NEW.kind='person' AND NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL BEGIN
  UPDATE companion_life_records SET person_ids=(SELECT json_group_array(value) FROM json_each(person_ids) WHERE value<>NEW.id),
    updated_at=NEW.deleted_at,version=version+1
    WHERE user_id=NEW.user_id AND relationship_id=NEW.relationship_id AND deleted_at IS NULL
      AND EXISTS(SELECT 1 FROM json_each(person_ids) WHERE value=NEW.id);
END;
CREATE TRIGGER companion_life_pause_insert AFTER INSERT ON companion_life_records
WHEN NEW.kind='lifecycle' AND NEW.label IN ('paused','ended') AND NEW.deleted_at IS NULL BEGIN
  UPDATE companion_schedules SET paused=1,config_json=json_set(config_json,'$.paused',json('true')),
    next_run_at=NULL,updated_at=NEW.updated_at,version=version+1
    WHERE user_id=NEW.user_id AND relationship_id=NEW.relationship_id AND deleted_at IS NULL;
END;
CREATE TRIGGER companion_life_pause_update AFTER UPDATE OF label ON companion_life_records
WHEN NEW.kind='lifecycle' AND NEW.label IN ('paused','ended') AND NEW.deleted_at IS NULL BEGIN
  UPDATE companion_schedules SET paused=1,config_json=json_set(config_json,'$.paused',json('true')),
    next_run_at=NULL,updated_at=NEW.updated_at,version=version+1
    WHERE user_id=NEW.user_id AND relationship_id=NEW.relationship_id AND deleted_at IS NULL;
END;
