import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { listWorkspaces, removeTarget, resolveWorkspacePath } from "../src/actions.ts";
import type { Compose } from "../src/docker.ts";
import type { Entry } from "../src/registry.ts";

function entry(): Entry {
  return {
    descriptor: {
      app: "budget",
      target: "prod",
      mode: "deployed",
      hostname: "budget",
      url: "https://budget.mon-tailnet.ts.net",
      healthUrl: "https://budget.mon-tailnet.ts.net/api/session",
      project: "dbox-budget-prod",
      source: "/home/serve/dbox/budget",
      autoDeploy: false,
    },
    state: null,
    status: "en marche",
    containers: [],
    directory: "/home/serve/dbox/apps/budget/prod",
  };
}

describe("suppression d'une cible", () => {
  it("arrête via compose down, puis supprime le dossier généré", async () => {
    const calls: string[][] = [];
    const compose: Compose = async (directory, args) => {
      calls.push([directory, ...args]);
      return { code: 0, stdout: "", stderr: "" };
    };
    const removed: string[] = [];

    const result = await removeTarget(entry(), compose, async (path) => {
      removed.push(path);
    });

    assert.equal(result.code, 0);
    assert.deepEqual(calls, [["/home/serve/dbox/apps/budget/prod", "down"]]);
    assert.deepEqual(removed, ["/home/serve/dbox/apps/budget/prod"]);
  });

  it("ne touche pas au disque si down échoue", async () => {
    const compose: Compose = async () => ({ code: 1, stdout: "", stderr: "réseau occupé" });
    const removed: string[] = [];

    const result = await removeTarget(entry(), compose, async (path) => {
      removed.push(path);
    });

    assert.equal(result.code, 1);
    assert.equal(result.stderr, "réseau occupé");
    assert.deepEqual(removed, []);
  });

  it("ne demande jamais --volumes : le dossier source et les volumes nommés survivent", async () => {
    const calls: string[][] = [];
    const compose: Compose = async (_directory, args) => {
      calls.push(args);
      return { code: 0, stdout: "", stderr: "" };
    };

    await removeTarget(entry(), compose, async () => {});

    assert.deepEqual(calls, [["down"]]);
  });
});

describe("résolution d'un chemin de dossier local", () => {
  it("joint le chemin relatif à la racine", () => {
    assert.equal(resolveWorkspacePath("/home/cde/dev", "mon-projet"), "/home/cde/dev/mon-projet");
  });

  it("accepte un sous-dossier", () => {
    assert.equal(resolveWorkspacePath("/home/cde/dev", "equipe/mon-projet"), "/home/cde/dev/equipe/mon-projet");
  });

  it("refuse un chemin vide", () => {
    assert.throws(() => resolveWorkspacePath("/home/cde/dev", ""), /chemin invalide/);
  });

  it("refuse un chemin absolu — jamais hors de la racine configurée", () => {
    assert.throws(() => resolveWorkspacePath("/home/cde/dev", "/etc/passwd"), /chemin invalide/);
  });

  it("refuse une remontée « .. », même noyée dans le chemin", () => {
    assert.throws(() => resolveWorkspacePath("/home/cde/dev", "../ailleurs"), /chemin invalide/);
    assert.throws(() => resolveWorkspacePath("/home/cde/dev", "projet/../../ailleurs"), /chemin invalide/);
  });
});

function entree(name: string, dossier: boolean): { name: string; isDirectory: () => boolean } {
  return { name, isDirectory: () => dossier };
}

describe("liste des projets d'un dossier de travail", () => {
  const sansPackageJson = async () => {
    throw new Error("ENOENT");
  };

  it("ne garde que les dossiers, triés", async () => {
    const readdir = async () => [entree("zeta", true), entree("README.md", false), entree("alpha", true)];
    assert.deepEqual(await listWorkspaces("/home/cde/dev", readdir, sansPackageJson), [
      { name: "alpha", command: null },
      { name: "zeta", command: null },
    ]);
  });

  it("ignore les dossiers cachés", async () => {
    const readdir = async () => [entree(".git", true), entree("projet", true)];
    assert.deepEqual(await listWorkspaces("/home/cde/dev", readdir, sansPackageJson), [
      { name: "projet", command: null },
    ]);
  });

  it("rend une liste vide si la racine est illisible, sans planter", async () => {
    const readdir = async () => {
      throw new Error("ENOENT");
    };
    assert.deepEqual(await listWorkspaces("/absent", readdir, sansPackageJson), []);
  });

  it("suggère « npm run dev » quand le package.json déclare ce script", async () => {
    const readdir = async () => [entree("budget", true)];
    const readFile = async (path: string) => {
      assert.equal(path, "/home/cde/dev/budget/package.json");
      return JSON.stringify({ scripts: { dev: "vite" } });
    };
    assert.deepEqual(await listWorkspaces("/home/cde/dev", readdir, readFile), [
      { name: "budget", command: "npm run dev" },
    ]);
  });

  it("ne suggère rien sans script dev, package.json absent, ou JSON invalide", async () => {
    const readdir = async () => [entree("a", true), entree("b", true), entree("c", true)];
    const readFile = async (path: string) => {
      if (path.endsWith("/a/package.json")) return JSON.stringify({ scripts: { build: "tsc" } });
      if (path.endsWith("/b/package.json")) throw new Error("ENOENT");
      return "{ pas du json";
    };
    assert.deepEqual(await listWorkspaces("/home/cde/dev", readdir, readFile), [
      { name: "a", command: null },
      { name: "b", command: null },
      { name: "c", command: null },
    ]);
  });
});
