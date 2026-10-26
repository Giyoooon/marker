-- 마커를 마지막으로 바꾼 사람 (이름·분류·경로 포함 여부를 바꿀 때 기록). 마킹만 하고 안 바꿨으면 NULL
ALTER TABLE markers ADD COLUMN updated_by INTEGER REFERENCES members(id) ON DELETE SET NULL;
