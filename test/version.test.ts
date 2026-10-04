import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { describe, it } from "node:test";
import { versionAffichee, versionDuPaquet } from "../src/version.ts";

describe("dbox --version", () => {
  it("annonce la version gravée dans l'image, numéro ou SHA", () => {
    assert.equal(versionAffichee("1.1.0", "1.1.0"), "1.1.0");
    assert.equal(versionAffichee("111e097f847c", "1.1.0"), "111e097f847c");
  });

  it("retombe sur package.json, en disant que ce sont des sources", () => {
    assert.equal(versionAffichee(undefined, "1.1.0"), "1.1.0 (sources)");
    // « inconnue » est le défaut de l'ARG d'une image construite à la main.
    assert.equal(versionAffichee("inconnue", "1.1.0"), "1.1.0 (sources)");
    assert.equal(versionAffichee("", null), "inconnue");
  });

  it("lit le numéro de package.json", () => {
    assert.match(versionDuPaquet() ?? "", /^\d+\.\d+\.\d+$/);
  });

  it("la commande répond sans charger de configuration", () => {
    const sortie = execFileSync(process.execPath, ["src/cli.ts", "--version"], {
      env: { ...process.env, DBOX_VERSION: "9.9.9", HOME: "/nonexistent" },
      encoding: "utf8",
    });
    assert.equal(sortie, "dbox 9.9.9\n");
  });
});
