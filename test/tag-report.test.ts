import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readTagReport, serializeTagReport } from "../src/tag-report.ts";

describe("rapport de vérification du tag", () => {
  it("sérialise et relit le même contenu", async () => {
    const report = {
      checkedAt: "2026-08-16T12:00:00.000Z",
      tag: "tag:dbox",
      present: false,
      suggestedLine: '"tag:dbox": ["autogroup:admin"],',
    };
    const read = await readTagReport("/whatever", async () => serializeTagReport(report));
    assert.deepEqual(read, report);
  });

  it("renvoie null si le fichier est absent", async () => {
    const read = await readTagReport("/absent", async () => {
      throw new Error("ENOENT");
    });
    assert.equal(read, null);
  });

  it("renvoie null sur un contenu mal formé, plutôt que de planter", async () => {
    assert.equal(await readTagReport("/x", async () => "pas du json"), null);
    assert.equal(await readTagReport("/x", async () => "{}"), null);
    assert.equal(await readTagReport("/x", async () => JSON.stringify({ checkedAt: "x", tag: "tag:dbox" })), null);
  });
});
