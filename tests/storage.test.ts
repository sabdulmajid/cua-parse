import { describe, it, expect } from "vitest";
import { LocalStore } from "../src/server/storage.js";
import {
  startSchema,
  querySchema,
  aspectSchema,
} from "../src/shared/contracts.js";
const input = startSchema.parse({
  product: "AcmeFlow",
  question: "What about pricing?",
  mode: "fixture",
  idempotencyKey: "storage-case-1",
});
describe("persistent job and session contracts", () => {
  it("scopes idempotency and research ownership to one session", () => {
    const db = new LocalStore(":memory:");
    const a = db.session(),
      b = db.session();
    const first = db.insertJob(a.id, input);
    expect(db.insertJob(a.id, input)).toEqual({
      job: first.job,
      created: false,
    });
    expect(db.findJob(b.id, first.job.id)).toBeUndefined();
    expect(db.insertJob(b.id, input).job.id).not.toBe(first.job.id);
    expect(() =>
      db.insertJob(a.id, { ...input, question: "Changed request" }),
    ).toThrow(/Idempotency/);
    db.close();
  });
  it("recovers interrupted jobs, preserving terminal jobs", () => {
    const db = new LocalStore(":memory:");
    const s = db.session();
    const a = db.insertJob(s.id, input).job;
    const b = db.insertJob(s.id, {
      ...input,
      idempotencyKey: "storage-case-2",
    }).job;
    b.state = "ready";
    db.saveJob(b);
    expect(db.recover()).toBe(1);
    expect(db.findJob(s.id, a.id)?.state).toBe("failed");
    expect(db.findJob(s.id, b.id)?.state).toBe("ready");
    db.close();
  });
  it("binds a one-use lease to its owner and conversation", () => {
    const db = new LocalStore(":memory:");
    const a = db.session(),
      b = db.session();
    const lease = db.lease(a.id);
    expect(db.bind(b.id, lease, "conversation-A")).toBe(false);
    expect(db.bind(a.id, lease, "conversation-A")).toBe(true);
    expect(db.bind(a.id, lease, "conversation-B")).toBe(false);
    expect(db.ownsConversation(b.id, "conversation-A")).toBe(false);
    db.close();
  });
  it("rejects extra tool arguments and malformed schemas", () => {
    expect(() =>
      startSchema.parse({ ...input, sessionId: "victim" }),
    ).toThrow();
    expect(() =>
      querySchema.parse({
        researchId: "bad-id",
        question: "price",
        filters: {},
        requestId: "x",
      }),
    ).toThrow();
    expect(() =>
      aspectSchema.parse({
        aspect: "pricing",
        sentiment: "positive",
        quote: "",
      }),
    ).toThrow();
  });
});
