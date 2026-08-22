import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readMachines, writeMachines, type MachineEntry } from "../src/machines.ts";

function harness(files: Record<string, string> = {}) {
  return {
    files,
    read: async (path: string) => {
      const content = files[path];
      if (content === undefined) throw new Error(`absent : ${path}`);
      return content;
    },
    write: async (path: string, content: string) => {
      files[path] = content;
    },
  };
}

describe("lecture des machines connues", () => {
  it("rend une liste vide quand le fichier n'existe pas", async () => {
    const { read } = harness();
    assert.deepEqual(await readMachines("/x/machines.json", read), []);
  });

  it("rend une liste vide sur un JSON invalide", async () => {
    const { read } = harness({ "/x/machines.json": "{ pas du json" });
    assert.deepEqual(await readMachines("/x/machines.json", read), []);
  });

  it("rend une liste vide quand ce n'est pas un tableau", async () => {
    const { read } = harness({ "/x/machines.json": '{"name":"serve"}' });
    assert.deepEqual(await readMachines("/x/machines.json", read), []);
  });

  it("filtre les entrées mal formées plutôt que de planter", async () => {
    const { read } = harness({
      "/x/machines.json": JSON.stringify([
        { name: "serve (prod)", url: "https://dbox.tail4bb652.ts.net" },
        { name: "sans url" },
        "pas un objet",
        { name: 12, url: "https://x" },
      ]),
    });
    assert.deepEqual(await readMachines("/x/machines.json", read), [
      { name: "serve (prod)", url: "https://dbox.tail4bb652.ts.net" },
    ]);
  });

  it("lit une liste bien formée", async () => {
    const entries: MachineEntry[] = [
      { name: "serve (prod)", url: "https://dbox.tail4bb652.ts.net" },
      { name: "pc-cde (dev)", url: "https://dbox-dev.tail4bb652.ts.net" },
    ];
    const { read } = harness({ "/x/machines.json": JSON.stringify(entries) });
    assert.deepEqual(await readMachines("/x/machines.json", read), entries);
  });
});

describe("écriture des machines connues", () => {
  it("fait l'aller-retour avec la lecture", async () => {
    const { read, write, files } = harness();
    const entries: MachineEntry[] = [{ name: "serve (prod)", url: "https://dbox.tail4bb652.ts.net" }];

    await writeMachines("/x/machines.json", entries, write);
    assert.deepEqual(await readMachines("/x/machines.json", read), entries);
    assert.match(files["/x/machines.json"]!, /\n$/);
  });
});
