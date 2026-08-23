import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { checkTagOnce, type TagCheckDeps } from "../src/tagcheck.ts";

const NOW = Date.parse("2026-08-16T12:00:00.000Z");
const REPORT_FILE = "/home/serve/dbox/tag-report.json";

function harness(overrides: Partial<TagCheckDeps> = {}) {
  const logs: string[] = [];
  const files = new Map<string, string>();
  const deps: TagCheckDeps = {
    tailnet: "mon-tailnet.ts.net",
    tag: "tag:dbox",
    reportFile: REPORT_FILE,
    readToken: async () => "tskey-api-abc",
    writeFile: async (path, content) => {
      files.set(path, content);
    },
    listTagOwners: async () => ({ "tag:dbox-admin": ["autogroup:admin"] }),
    now: () => NOW,
    log: (line) => logs.push(line),
    ...overrides,
  };
  return { deps, logs, files };
}

describe("vérification du tag qui sème les nouvelles apps", () => {
  it("signale que le tag est présent quand il l'est", async () => {
    const h = harness({ listTagOwners: async () => ({ "tag:dbox": ["autogroup:admin"] }) });
    await checkTagOnce(h.deps);

    const report = JSON.parse(h.files.get(REPORT_FILE)!);
    assert.equal(report.present, true);
    assert.equal(report.suggestedLine, null);
    assert.match(h.logs.join("\n"), /déjà déclaré/);
  });

  it("signale l'absence et compose une ligne à coller, calquée sur tag:dbox-admin", async () => {
    const h = harness({
      listTagOwners: async () => ({ "tag:dbox-admin": ["autogroup:admin", "quelqu'un@github"] }),
    });
    await checkTagOnce(h.deps);

    const report = JSON.parse(h.files.get(REPORT_FILE)!);
    assert.equal(report.present, false);
    assert.equal(report.suggestedLine, '"tag:dbox": ["autogroup:admin","quelqu\'un@github"],');
    assert.match(h.logs.join("\n"), /absent de tagOwners/);
  });

  it("retombe sur autogroup:admin si aucun tag n'existe déjà (policy jamais configurée pour DBox)", async () => {
    const h = harness({ listTagOwners: async () => ({}) });
    await checkTagOnce(h.deps);

    const report = JSON.parse(h.files.get(REPORT_FILE)!);
    assert.equal(report.suggestedLine, '"tag:dbox": ["autogroup:admin"],');
  });

  it("n'appelle jamais l'API sans token, et n'écrit pas de rapport", async () => {
    const h = harness({ readToken: async () => "" });
    let called = false;
    h.deps.listTagOwners = async () => {
      called = true;
      return {};
    };
    await checkTagOnce(h.deps);
    assert.equal(called, false);
    assert.equal(h.files.has(REPORT_FILE), false);
  });

  it("ne fait rien sans tag configuré, et n'écrit pas de rapport", async () => {
    const h = harness({ tag: null });
    let called = false;
    h.deps.listTagOwners = async () => {
      called = true;
      return {};
    };
    await checkTagOnce(h.deps);
    assert.equal(called, false);
    assert.equal(h.files.has(REPORT_FILE), false);
  });
});
