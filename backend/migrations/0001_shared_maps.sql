-- 공유 지도: 4자리 번호로 여럿이 같은 지도에 마커를 꽂음
-- 모든 테이블은 created_at(생성일), updated_at(수정일)을 가짐. 시각은 UTC ISO 8601 (예: 2026-10-26T12:34:56.789Z)
-- updated_at 은 행이 바뀌면 트리거가 자동으로 갱신

-- 공유 지도
CREATE TABLE maps (
  code        TEXT PRIMARY KEY
              CHECK (length(code) = 4 AND code NOT GLOB '*[^A-Z0-9]*'),        -- 지도 번호: [A-Z0-9]{4}
  title       TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 60),           -- 지도 제목
  mode        TEXT NOT NULL DEFAULT 'car' CHECK (mode IN ('car', 'transit', 'walk')),  -- 이동수단
  loop        INTEGER NOT NULL DEFAULT 1 CHECK (loop IN (0, 1)),             -- 숙소 출발·복귀
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- 지도 안에서 쓰는 닉네임 (로그인 없음, 기기에 기억)
CREATE TABLE members (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  map_code    TEXT NOT NULL REFERENCES maps(code) ON DELETE CASCADE,
  nickname    TEXT NOT NULL CHECK (length(nickname) BETWEEN 1 AND 20),
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (map_code, nickname)
);

-- 지도에 꽂은 마커와 마킹한 사람
CREATE TABLE markers (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  map_code    TEXT NOT NULL REFERENCES maps(code) ON DELETE CASCADE,
  marked_by   INTEGER REFERENCES members(id) ON DELETE SET NULL,           -- 마킹한 사람
  name        TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  lat         REAL NOT NULL,
  lng         REAL NOT NULL,
  cat         TEXT NOT NULL DEFAULT 'etc' CHECK (cat IN ('stay', 'food', 'cafe', 'sight', 'etc')),
  included    INTEGER NOT NULL DEFAULT 1 CHECK (included IN (0, 1)),        -- 경로에 포함
  position    INTEGER NOT NULL,                                            -- 목록 순서 (경로에 든 것끼리, 뺀 것끼리 비교)
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (map_code, lat, lng)                                              -- 같은 자리 중복 마킹 방지 (좌표는 소수 5자리로 맞춰 저장)
);
CREATE INDEX markers_by_map ON markers (map_code, included DESC, position);
CREATE INDEX members_by_map ON members (map_code);

-- 수정일 자동 갱신 (updated_at 을 직접 바꾼 경우는 그대로 둠)
CREATE TRIGGER maps_touch AFTER UPDATE ON maps FOR EACH ROW WHEN NEW.updated_at = OLD.updated_at
BEGIN
  UPDATE maps SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE code = NEW.code;
END;
CREATE TRIGGER members_touch AFTER UPDATE ON members FOR EACH ROW WHEN NEW.updated_at = OLD.updated_at
BEGIN
  UPDATE members SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id;
END;
CREATE TRIGGER markers_touch AFTER UPDATE ON markers FOR EACH ROW WHEN NEW.updated_at = OLD.updated_at
BEGIN
  UPDATE markers SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id;
END;

-- 지도 안의 마커·닉네임이 바뀌면 지도의 수정일도 갱신 → 다른 사람 화면이 이 값으로 변경을 알아챔
CREATE TRIGGER markers_bump_map_ins AFTER INSERT ON markers FOR EACH ROW
BEGIN
  UPDATE maps SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE code = NEW.map_code;
END;
CREATE TRIGGER markers_bump_map_upd AFTER UPDATE ON markers FOR EACH ROW
BEGIN
  UPDATE maps SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE code = NEW.map_code;
END;
CREATE TRIGGER markers_bump_map_del AFTER DELETE ON markers FOR EACH ROW
BEGIN
  UPDATE maps SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE code = OLD.map_code;
END;
CREATE TRIGGER members_bump_map_ins AFTER INSERT ON members FOR EACH ROW
BEGIN
  UPDATE maps SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE code = NEW.map_code;
END;
