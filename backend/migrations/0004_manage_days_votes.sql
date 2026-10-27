-- 공유 지도 관리·일차·투표

-- 지도를 만든 사람 (지도 삭제는 이 사람만). 이미 있는 지도는 가장 먼저 들어온 닉네임을 만든 사람으로
ALTER TABLE maps ADD COLUMN created_by INTEGER REFERENCES members(id) ON DELETE SET NULL;
UPDATE maps SET created_by = (SELECT MIN(id) FROM members WHERE members.map_code = maps.code);

-- 마커의 일차 (1일차, 2일차 …). 경로는 일차마다 따로 이어짐
ALTER TABLE markers ADD COLUMN day INTEGER NOT NULL DEFAULT 1 CHECK (day BETWEEN 1 AND 9);

-- 가볼 곳 투표: 마커마다 사람마다 하나 (👍 1 / 👎 -1). 표를 거두면 행을 지움
CREATE TABLE marker_votes (
  marker_id   INTEGER NOT NULL REFERENCES markers(id) ON DELETE CASCADE,
  member_id   INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  value       INTEGER NOT NULL CHECK (value IN (-1, 1)),
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (marker_id, member_id)
);
CREATE TRIGGER marker_votes_touch AFTER UPDATE ON marker_votes FOR EACH ROW WHEN NEW.updated_at = OLD.updated_at
BEGIN
  UPDATE marker_votes SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE marker_id = NEW.marker_id AND member_id = NEW.member_id;
END;

-- 표가 바뀌면 지도의 수정일도 갱신 (다른 사람 화면이 변경을 알아챔)
CREATE TRIGGER marker_votes_bump_map_ins AFTER INSERT ON marker_votes FOR EACH ROW
BEGIN
  UPDATE maps SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE code = (SELECT map_code FROM markers WHERE id = NEW.marker_id);
END;
CREATE TRIGGER marker_votes_bump_map_upd AFTER UPDATE ON marker_votes FOR EACH ROW
BEGIN
  UPDATE maps SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE code = (SELECT map_code FROM markers WHERE id = NEW.marker_id);
END;
CREATE TRIGGER marker_votes_bump_map_del AFTER DELETE ON marker_votes FOR EACH ROW
BEGIN
  UPDATE maps SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE code = (SELECT map_code FROM markers WHERE id = OLD.marker_id);
END;
