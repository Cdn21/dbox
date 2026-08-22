import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { idPath, ROTATE_WITHIN_DAYS, rotateOnce, type RotateDeps } from "../src/rotate.ts";

const NOW = Date.parse("2026-08-15T12:00:00.000Z");
const AUTHKEY_FILE = "/home/serve/dbox/authkey";

function harness(overrides: Partial<RotateDeps> = {}) {
  const files = new Map<string, string>();
  const modes = new Map<string, number>();
  const logs: string[] = [];
  const created: { tailnet: string; token: string; tag: string | null }[] = [];
  const revoked: { tailnet: string; token: string; keyId: string }[] = [];

  const deps: RotateDeps = {
    authkeyFile: AUTHKEY_FILE,
    tailnet: "tail4bb652.ts.net",
    tag: "tag:dbox",
    readFile: async (path) => {
      const found = files.get(path);
      if (found === undefined) throw new Error("absent");
      return found;
    },
    writeFile: async (path, content, mode) => {
      files.set(path, content);
      modes.set(path, mode);
    },
    readToken: async () => "tskey-api-abc",
    createKey: async (tailnet, token, tag) => {
      created.push({ tailnet, token, tag });
      return { id: "knew111CNTRL", key: "tskey-auth-new", expiresOn: "2026-11-13" };
    },
    revokeKey: async (tailnet, token, keyId) => {
      revoked.push({ tailnet, token, keyId });
    },
    now: () => NOW,
    log: (line) => logs.push(line),
    ...overrides,
  };

  return { deps, files, modes, logs, created, revoked };
}

describe("rotation de la clé d'auth", () => {
  it("ne fait rien tant que l'échéance est loin", async () => {
    const h = harness();
    h.files.set(`${AUTHKEY_FILE}.expires`, "2026-12-01\n");

    await rotateOnce(h.deps);

    assert.equal(h.created.length, 0);
    assert.equal(h.files.has(AUTHKEY_FILE), false);
  });

  it("régénère dans la fenêtre de rotation, et pose l'identifiant de la nouvelle clé", async () => {
    const h = harness();
    h.files.set(`${AUTHKEY_FILE}.expires`, "2026-08-20\n"); // 5 jours

    await rotateOnce(h.deps);

    assert.equal(h.created.length, 1);
    assert.equal(h.created[0]!.tag, "tag:dbox");
    assert.equal(h.created[0]!.token, "tskey-api-abc");
    assert.equal(h.files.get(AUTHKEY_FILE), "tskey-auth-new\n");
    assert.equal(h.files.get(`${AUTHKEY_FILE}.expires`), "2026-11-13\n");
    assert.equal(h.files.get(idPath(AUTHKEY_FILE)), "knew111CNTRL\n");
    assert.equal(h.modes.get(AUTHKEY_FILE), 0o600);
    assert.match(h.logs.join("\n"), /expire le 2026-11-13/);
  });

  it("révoque l'ancienne clé une fois la nouvelle en place, quand son identifiant est connu", async () => {
    const h = harness();
    h.files.set(`${AUTHKEY_FILE}.expires`, "2026-08-20\n");
    h.files.set(idPath(AUTHKEY_FILE), "kold999CNTRL\n");

    await rotateOnce(h.deps);

    assert.deepEqual(h.revoked, [{ tailnet: "tail4bb652.ts.net", token: "tskey-api-abc", keyId: "kold999CNTRL" }]);
    // La nouvelle clé écrase l'ancien identifiant : la prochaine rotation
    // révoquera celle-ci, pas l'actuelle ancienne.
    assert.equal(h.files.get(idPath(AUTHKEY_FILE)), "knew111CNTRL\n");
    assert.match(h.logs.join("\n"), /ancienne clé \(kold999CNTRL\) révoquée/);
  });

  it("ne révoque rien à la première rotation — aucun identifiant connu", async () => {
    const h = harness();
    h.files.set(`${AUTHKEY_FILE}.expires`, "2026-08-20\n");

    await rotateOnce(h.deps);

    assert.equal(h.revoked.length, 0);
  });

  it("un échec de révocation n'empêche pas la rotation d'avoir réussi", async () => {
    const h = harness({
      revokeKey: async () => {
        throw new Error("clé déjà révoquée");
      },
    });
    h.files.set(`${AUTHKEY_FILE}.expires`, "2026-08-20\n");
    h.files.set(idPath(AUTHKEY_FILE), "kold999CNTRL\n");

    await rotateOnce(h.deps);

    // La nouvelle clé est bien en place malgré l'échec de révocation.
    assert.equal(h.files.get(AUTHKEY_FILE), "tskey-auth-new\n");
    assert.match(h.logs.join("\n"), /non révoquée : clé déjà révoquée/);
  });

  it("régénère aussi quand aucune échéance n'est connue — premier passage", async () => {
    const h = harness();
    await rotateOnce(h.deps);
    assert.equal(h.created.length, 1);
  });

  it("régénère une fois expirée", async () => {
    const h = harness();
    h.files.set(`${AUTHKEY_FILE}.expires`, "2026-08-01\n");

    await rotateOnce(h.deps);

    assert.equal(h.created.length, 1);
  });

  it("n'appelle jamais l'API sans token", async () => {
    const h = harness({ readToken: async () => "" });
    h.files.set(`${AUTHKEY_FILE}.expires`, "2026-08-16\n");

    await rotateOnce(h.deps);

    assert.equal(h.created.length, 0);
    assert.match(h.logs.join("\n"), /token.*absent/);
  });

  it("respecte le seuil documenté", () => {
    assert.equal(ROTATE_WITHIN_DAYS, 14);
  });
});
