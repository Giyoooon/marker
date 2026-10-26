export type Mode = 'car' | 'transit' | 'walk';

export interface Place { name: string; lat: number; lng: number }

export interface Leg { min: number; walk: boolean }

export interface Env {
  KAKAO_REST_KEY?: string;
  ALLOWED_ORIGINS?: string;
  DB: D1Database;
}
