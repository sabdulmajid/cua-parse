import Database from "better-sqlite3";
import { randomUUID, randomBytes } from "node:crypto";
import type {
  StartInput,
  ResearchJob,
  EvidencePacket,
  DecisionBrief,
} from "../shared/contracts.js";
export class LocalStore {
  db: Database.Database;
  constructor(file: string) {
    this.db = new Database(file);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY,csrf TEXT NOT NULL,created INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,session TEXT NOT NULL,idem TEXT NOT NULL,input TEXT NOT NULL,job TEXT NOT NULL, UNIQUE(session,idem)); CREATE TABLE IF NOT EXISTS views(session TEXT NOT NULL,research TEXT NOT NULL,sequence INTEGER NOT NULL,packet TEXT,PRIMARY KEY(session,research)); CREATE TABLE IF NOT EXISTS briefs(session TEXT NOT NULL,research TEXT NOT NULL,scope TEXT NOT NULL,brief TEXT NOT NULL,PRIMARY KEY(session,research,scope)); CREATE TABLE IF NOT EXISTS conversations(id TEXT PRIMARY KEY,session TEXT NOT NULL,lease TEXT NOT NULL,expires INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS leases(id TEXT PRIMARY KEY,session TEXT NOT NULL,expires INTEGER NOT NULL,used INTEGER NOT NULL DEFAULT 0);`,
    );
    const columns = this.db.prepare("PRAGMA table_info(leases)").all() as {
      name: string;
    }[];
    if (!columns.some((column) => column.name === "conversation"))
      this.db.exec("ALTER TABLE leases ADD COLUMN conversation TEXT");
  }
  session(id?: string) {
    if (id) {
      const found = this.db
        .prepare("SELECT id,csrf FROM sessions WHERE id=? AND created>?")
        .get(id, Date.now() - 86400000) as
        { id: string; csrf: string } | undefined;
      if (found) return found;
    }
    const s = { id: randomUUID(), csrf: randomBytes(24).toString("hex") };
    this.db
      .prepare("INSERT INTO sessions VALUES(?,?,?)")
      .run(s.id, s.csrf, Date.now());
    return s;
  }
  findJob(session: string, id: string) {
    const row = this.db
      .prepare("SELECT job FROM jobs WHERE id=? AND session=?")
      .get(id, session) as { job: string } | undefined;
    return row ? (JSON.parse(row.job) as ResearchJob) : undefined;
  }
  listJobs(session: string): ResearchJob[] {
    return (
      this.db
        .prepare(
          "SELECT job FROM jobs WHERE session=? ORDER BY rowid DESC LIMIT 30",
        )
        .all(session) as { job: string }[]
    ).map((r) => JSON.parse(r.job));
  }
  findJobByIdempotency(
    session: string,
    input: StartInput,
  ): ResearchJob | undefined {
    const row = this.db
      .prepare("SELECT input,job FROM jobs WHERE session=? AND idem=?")
      .get(session, input.idempotencyKey) as
      { input: string; job: string } | undefined;
    if (row) {
      if (row.input !== JSON.stringify(input))
        throw Object.assign(
          new Error("Idempotency key was already used for another request."),
          { status: 409 },
        );
      return JSON.parse(row.job) as ResearchJob;
    }
    return undefined;
  }
  insertJob(
    session: string,
    input: StartInput,
  ): { job: ResearchJob; created: boolean } {
    const existing = this.findJobByIdempotency(session, input);
    if (existing) return { job: existing, created: false };
    const now = new Date().toISOString();
    const job: ResearchJob = {
      id: randomUUID(),
      product: input.product,
      question: input.question,
      mode: input.mode,
      state: "queued",
      createdAt: now,
      updatedAt: now,
      collected: 0,
      analyzed: 0,
      indexed: 0,
      duplicates: 0,
      attempts: [],
      failures: [],
      partial: false,
      evidenceVersion: 0,
    };
    this.db
      .prepare("INSERT INTO jobs VALUES(?,?,?,?,?)")
      .run(
        job.id,
        session,
        input.idempotencyKey,
        JSON.stringify(input),
        JSON.stringify(job),
      );
    return { job, created: true };
  }
  saveJob(job: ResearchJob) {
    job.updatedAt = new Date().toISOString();
    this.db
      .prepare("UPDATE jobs SET job=? WHERE id=?")
      .run(JSON.stringify(job), job.id);
  }
  recover() {
    const rows = this.db.prepare("SELECT job FROM jobs").all() as {
      job: string;
    }[];
    let count = 0;
    for (const row of rows) {
      const job = JSON.parse(row.job) as ResearchJob;
      if (
        ["queued", "collecting", "analyzing", "indexing"].includes(job.state)
      ) {
        job.state = "failed";
        job.failures.push(
          "Service restarted before completion. Start a new research job.",
        );
        this.saveJob(job);
        count++;
      }
    }
    return count;
  }
  nextQuery(session: string, research: string) {
    this.db
      .prepare(
        "INSERT INTO views(session,research,sequence) VALUES(?,?,1) ON CONFLICT(session,research) DO UPDATE SET sequence=sequence+1,packet=NULL",
      )
      .run(session, research);
    return (
      this.db
        .prepare("SELECT sequence FROM views WHERE session=? AND research=?")
        .get(session, research) as { sequence: number }
    ).sequence;
  }
  savePacket(session: string, packet: EvidencePacket, sequence: number) {
    return (
      this.db
        .prepare(
          "UPDATE views SET packet=? WHERE session=? AND research=? AND sequence=?",
        )
        .run(JSON.stringify(packet), session, packet.researchId, sequence)
        .changes > 0
    );
  }
  saveBrief(session: string, brief: DecisionBrief) {
    this.db
      .prepare("INSERT OR REPLACE INTO briefs VALUES(?,?,?,?)")
      .run(
        session,
        brief.researchId,
        brief.scopeVersion,
        JSON.stringify(brief),
      );
  }
  lease(session: string, conversation?: string) {
    const id = randomUUID();
    this.db
      .prepare(
        "INSERT INTO leases(id,session,expires,conversation) VALUES(?,?,?,?)",
      )
      .run(id, session, Date.now() + 120000, conversation || null);
    return id;
  }
  bind(session: string, lease: string, conversation: string) {
    return this.db.transaction(() => {
      const l = this.db
        .prepare(
          "SELECT id FROM leases WHERE id=? AND session=? AND used=0 AND expires>? AND (conversation IS NULL OR conversation=?)",
        )
        .get(lease, session, Date.now(), conversation);
      if (!l) return false;
      const old = this.db
        .prepare("SELECT session FROM conversations WHERE id=?")
        .get(conversation) as { session: string } | undefined;
      if (old && old.session !== session) return false;
      this.db.prepare("UPDATE leases SET used=1 WHERE id=?").run(lease);
      this.db
        .prepare("INSERT OR REPLACE INTO conversations VALUES(?,?,?,?)")
        .run(conversation, session, lease, Date.now() + 3600000);
      return true;
    })();
  }
  ownsConversation(session: string, id: string) {
    return !!this.db
      .prepare(
        "SELECT id FROM conversations WHERE session=? AND id=? AND expires>?",
      )
      .get(session, id, Date.now());
  }
  close() {
    this.db.close();
  }
}
