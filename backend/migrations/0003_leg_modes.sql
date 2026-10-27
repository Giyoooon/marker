-- 구간별 이동수단. 지도 기본 이동수단(mode)과 다른 구간만 {"출발 좌표>도착 좌표": mode} JSON 으로
-- 좌표는 소수 5자리 "lat,lng" (화면의 posKey 와 같음). 순서를 바꿔 구간이 사라져도 남겨 둠 → 같은 구간이 다시 생기면 그대로 씀
ALTER TABLE maps ADD COLUMN leg_modes TEXT NOT NULL DEFAULT '{}';
