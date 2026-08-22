import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readOrphansReport, serializeOrphansReport } from "../src/orphans-report.ts";

describe("rapport des nœuds orphelins", () => {
  it("sérialise et relit le même contenu", async () => {
    const report = {
      checkedAt: "2026-08-16T12:00:00.000Z",
      tag: "tag:dbox",
      stale: [{ hostname: "vieille-app", id: "3", lastSeen: "2026-07-01T00:00:00Z" }],
    };
    const serialized = serializeOrphansReport(report);
    const read = await readOrphansReport("/whatever", async () => serialized);
    assert.deepEqual(read, report);
  });

  it("renvoie null si le fichier est absent", async () => {
    const read = await readOrphansReport("/absent", async () => {
      throw new Error("ENOENT");
    });
    assert.equal(read, null);
  });

  it("renvoie null sur un contenu mal formé, plutôt que de planter", async () => {
    assert.equal(await readOrphansReport("/x", async () => "pas du json"), null);
    assert.equal(await readOrphansReport("/x", async () => "{}"), null);
    assert.equal(await readOrphansReport("/x", async () => JSON.stringify({ checkedAt: "x" })), null);
    assert.equal(
      await readOrphansReport("/x", async () => JSON.stringify({ checkedAt: "x", stale: [] })),
      null,
    );
  });
});
