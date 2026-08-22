import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { appKeyFile, ensureKey, gitSshCommand, keyPaths, readPublicKey, resolveKeyFile, type KeyIo } from "../src/sshkey.ts";

describe("chemins de la clé", () => {
  it("déduit la publique de la privée", () => {
    assert.deepEqual(keyPaths("/home/serve/dbox/ssh_key"), {
      private: "/home/serve/dbox/ssh_key",
      public: "/home/serve/dbox/ssh_key.pub",
    });
  });
});

describe("commande SSH dédiée", () => {
  it("force la clé et ignore les autres", () => {
    assert.equal(
      gitSshCommand("/home/serve/dbox/ssh_key"),
      "ssh -i '/home/serve/dbox/ssh_key' -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new",
    );
  });
});

function harness(files: Record<string, string> = {}) {
  const calls: { run: string[][]; chmod: [string, number][]; mkdir: string[] } = {
    run: [],
    chmod: [],
    mkdir: [],
  };
  const io: KeyIo = {
    readFile: async (path) => {
      const content = files[path];
      if (content === undefined) throw new Error(`absent : ${path}`);
      return content;
    },
    mkdir: async (path) => {
      calls.mkdir.push(path);
    },
    chmod: async (path, mode) => {
      calls.chmod.push([path, mode]);
    },
    run: async (file, args) => {
      calls.run.push([file, ...args]);
      // Simule ssh-keygen : dépose la paire là où on la lui a demandée.
      const dest = args[args.indexOf("-f") + 1]!;
      files[dest] = "clé-privée-simulée";
      files[`${dest}.pub`] = "ssh-ed25519 AAAAsimulée dbox";
      return { code: 0, stdout: "", stderr: "" };
    },
  };
  return { io, files, calls };
}

describe("lecture de la clé publique", () => {
  it("rend null quand rien n'existe", async () => {
    const { io } = harness();
    assert.equal(await readPublicKey(keyPaths("/x/ssh_key"), io), null);
  });

  it("rend la clé, sans espaces de fin", async () => {
    const { io } = harness({ "/x/ssh_key.pub": "ssh-ed25519 AAAA dbox\n" });
    assert.equal(await readPublicKey(keyPaths("/x/ssh_key"), io), "ssh-ed25519 AAAA dbox");
  });
});

describe("génération", () => {
  it("crée la paire quand elle n'existe pas encore", async () => {
    const { io, calls } = harness();
    const result = await ensureKey(keyPaths("/x/ssh_key"), io);

    assert.equal(result.created, true);
    assert.equal(result.publicKey, "ssh-ed25519 AAAAsimulée dbox");
    assert.deepEqual(calls.run[0], ["ssh-keygen", "-t", "ed25519", "-N", "", "-C", "dbox", "-f", "/x/ssh_key"]);
    // La privée doit être verrouillée : ssh refuse une clé trop permissive.
    assert.deepEqual(calls.chmod, [["/x/ssh_key", 0o600]]);
  });

  it("n'écrase jamais une clé existante", async () => {
    // Même règle que ts.env et .env : une clé déjà collée dans GitHub ne doit
    // jamais devenir invalide parce qu'on a cliqué le bouton une seconde fois.
    const { io, calls } = harness({ "/x/ssh_key.pub": "ssh-ed25519 déjà-là\n" });
    const result = await ensureKey(keyPaths("/x/ssh_key"), io);

    assert.equal(result.created, false);
    assert.equal(result.publicKey, "ssh-ed25519 déjà-là");
    assert.deepEqual(calls.run, []);
  });

  it("propage l'erreur si ssh-keygen échoue", async () => {
    const { io } = harness();
    io.run = async () => ({ code: 1, stdout: "", stderr: "disque plein" });
    await assert.rejects(() => ensureKey(keyPaths("/x/ssh_key"), io), /disque plein/);
  });
});

describe("clé dédiée par app", () => {
  it("vit à côté de la clé machine, jamais dans le dépôt cloné", () => {
    assert.equal(appKeyFile("/home/serve/dbox/ssh_key", "budget"), "/home/serve/dbox/app-keys/budget");
  });
});

describe("résolution de la clé à utiliser", () => {
  it("sans clé machine configurée, rien à résoudre", async () => {
    const { io } = harness();
    assert.equal(await resolveKeyFile(undefined, "budget", io), undefined);
  });

  it("retombe sur la clé machine quand l'app n'a pas la sienne", async () => {
    const { io } = harness();
    assert.equal(await resolveKeyFile("/home/serve/dbox/ssh_key", "budget", io), "/home/serve/dbox/ssh_key");
  });

  it("préfère la clé dédiée une fois qu'elle existe", async () => {
    const { io } = harness({ "/home/serve/dbox/app-keys/budget.pub": "ssh-ed25519 AAAA budget\n" });
    assert.equal(
      await resolveKeyFile("/home/serve/dbox/ssh_key", "budget", io),
      "/home/serve/dbox/app-keys/budget",
    );
  });

  it("ne se mélange pas entre apps", async () => {
    const { io } = harness({ "/home/serve/dbox/app-keys/temoin.pub": "ssh-ed25519 AAAA temoin\n" });
    assert.equal(
      await resolveKeyFile("/home/serve/dbox/ssh_key", "budget", io),
      "/home/serve/dbox/ssh_key",
    );
  });
});
