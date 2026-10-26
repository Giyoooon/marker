// 테스트용 D1: Node 내장 SQLite(메모리)에 실제 마이그레이션을 적용하고 D1 API 모양으로 감쌈
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

export function fakeD1(): D1Database {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');   // D1 은 외래 키를 항상 검사함
  const dir = fileURLToPath(new URL('../migrations/', import.meta.url).href);
  for (const f of readdirSync(dir).filter(f => f.endsWith('.sql')).sort()) db.exec(readFileSync(join(dir, f), 'utf8'));

  const plain = (r: unknown) => (r ? { ...(r as object) } : null);
  class Stmt {
    constructor(readonly sql: string, readonly args: unknown[] = []) {}
    bind(...args: unknown[]) { return new Stmt(this.sql, args); }
    async first<T>(col?: string): Promise<T | null> {
      const r = plain(db.prepare(this.sql).get(...(this.args as never[]))) as Record<string, unknown> | null;
      return (r && col ? r[col] : r) as T | null;
    }
    async all<T>() {
      return { results: db.prepare(this.sql).all(...(this.args as never[])).map(plain) as T[], success: true, meta: {} };
    }
    async run() {
      const r = db.prepare(this.sql).run(...(this.args as never[]));
      return { results: [], success: true, meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
    }
  }
  return {
    prepare: (sql: string) => new Stmt(sql),
    // D1 의 batch 는 한 트랜잭션. 여기서도 같이 묶음
    batch: async (stmts: Stmt[]) => {
      db.exec('BEGIN');
      try {
        const out = [];
        for (const s of stmts) out.push(/^\s*SELECT/i.test(s.sql) ? await s.all() : await s.run());
        db.exec('COMMIT');
        return out;
      } catch (e) { db.exec('ROLLBACK'); throw e; }
    },
    exec: async (sql: string) => { db.exec(sql); return { count: 0, duration: 0 }; },
    // 테스트에서 SQL 을 바로 실행하려고 원본도 노출
    raw: db,
  } as unknown as D1Database;
}
