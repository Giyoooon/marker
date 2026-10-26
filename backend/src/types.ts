export type Mode = 'car' | 'transit' | 'walk';

export interface Place { name: string; lat: number; lng: number }

export interface FixedInput extends Place { id: string; day: number; time: string; dur: number }
export interface SpotInput extends Place { id: string; dur: number; must?: boolean }
export interface DayInput { start: string; end: string; from?: Place | null; to?: Place | null }

export interface PlanRequest {
  mode: Mode;
  days: DayInput[];
  fixed: FixedInput[];
  spots: SpotInput[];
}

export interface Leg { min: number; walk: boolean }

export interface PlanItem extends Place {
  id: string;
  fixed: boolean;
  must: boolean;
  dur: number;
  arrive: string;
  begin: string;
  end: string;
  waitMin: number;
  lateMin: number;
  leg: Leg;
}

export interface PlanDay {
  day: number;
  start: string;
  finish: string;
  travelMin: number;
  overMin: number;
  from: Place | null;
  to: Place | null;
  items: PlanItem[];
  back: Leg;
  /** 실제 도로 경로 [lat, lng][] — 카카오모빌리티 조회에 성공한 자동차 일정에만 있음 */
  path: [number, number][] | null;
}

export interface PlanResponse {
  source: 'kakao' | 'estimate';
  days: PlanDay[];
  unplaced: { id: string; name: string }[];
  warnings: string[];
}

export interface Env {
  KAKAO_REST_KEY?: string;
  ALLOWED_ORIGINS?: string;
}
