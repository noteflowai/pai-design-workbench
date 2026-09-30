import { DatabaseSync } from "node:sqlite";
import { mkdirSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import { DomainError } from "./domain.js";

/** Durable domain records. Native controller retains its separate admission ledger. */
export class Store {
  private db: DatabaseSync;
  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    if (path !== ":memory:") chmodSync(path, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS documents(
        kind TEXT NOT NULL, id TEXT NOT NULL, revision INTEGER NOT NULL, body TEXT NOT NULL,
        PRIMARY KEY(kind,id));
      CREATE TABLE IF NOT EXISTS requests(
        request_id TEXT PRIMARY KEY, digest TEXT NOT NULL, run_id TEXT NOT NULL);
    `);
  }
  get<T>(kind: string, id: string): T | undefined {
    const row = this.db.prepare("SELECT body FROM documents WHERE kind=? AND id=?").get(kind, id) as { body: string } | undefined;
    return row ? JSON.parse(row.body) as T : undefined;
  }
  list<T>(kind: string): T[] {
    return (this.db.prepare("SELECT body FROM documents WHERE kind=? ORDER BY rowid").all(kind) as { body: string }[])
      .map(row => JSON.parse(row.body) as T);
  }
  insert(kind: string, value: { id: string; revision?: number }): void {
    this.db.prepare("INSERT INTO documents VALUES(?,?,?,?)").run(kind, value.id, value.revision ?? 1, JSON.stringify(value));
  }
  put(kind: string, value: { id: string; revision?: number }, expectedRevision?: number): void {
    const revision = value.revision ?? 1;
    const result = expectedRevision === undefined
      ? this.db.prepare("UPDATE documents SET revision=?,body=? WHERE kind=? AND id=?").run(revision, JSON.stringify(value), kind, value.id)
      : this.db.prepare("UPDATE documents SET revision=?,body=? WHERE kind=? AND id=? AND revision=?")
        .run(revision, JSON.stringify(value), kind, value.id, expectedRevision);
    if (result.changes !== 1) throw new DomainError("REVISION_CONFLICT", "Record changed; reload before editing");
  }
  claim(requestId: string, digest: string, record: { id: string }, kind = "review"): string {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.db.prepare("SELECT digest,run_id FROM requests WHERE request_id=?").get(requestId) as { digest: string; run_id: string } | undefined;
      if (existing && existing.digest !== digest) throw new DomainError("REQUEST_CONFLICT", "Request identity cannot be reused for different inputs");
      if (!existing) {
        this.db.prepare("INSERT INTO requests VALUES(?,?,?)").run(requestId, digest, record.id);
        this.db.prepare("INSERT INTO documents VALUES(?,?,1,?)").run(kind, record.id, JSON.stringify(record));
      }
      this.db.exec("COMMIT");
      return existing?.run_id ?? record.id;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  requestRun(requestId: string): string | undefined {
    const row = this.db.prepare("SELECT run_id FROM requests WHERE request_id=?").get(requestId) as { run_id: string } | undefined;
    return row?.run_id;
  }
  interruptPending(): void {
    for (const kind of ["review", "proposal", "scene-review"]) for (const record of this.list<{ id: string; state: string; error?: string }>(kind)) {
      if (record.state === "running") {
        record.state = "interrupted"; record.error = "Process restarted. Retained identity; no automatic command replay.";
        this.put(kind, record);
      }
    }
  }
  close(): void { this.db.close(); }
}
