import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { emitYaml } from "../src/yaml.ts";

describe("citation des scalaires", () => {
  it("laisse nues les chaînes qui ne peuvent être relues qu'ainsi", () => {
    const out = emitYaml({ image: "tailscale/tailscale:stable", dir: "/var/lib/tailscale" });
    assert.match(out, /^image: tailscale\/tailscale:stable$/m);
    assert.match(out, /^dir: \/var\/lib\/tailscale$/m);
  });

  it("cite ce qui serait relu comme un booléen", () => {
    // Sans guillemets, YAML relit `no`, `on`, `y` comme des booléens.
    for (const value of ["no", "yes", "on", "off", "true", "false", "null", "y", "n"]) {
      assert.match(emitYaml({ key: value }), new RegExp(`^key: "${value}"$`, "m"));
    }
  });

  it("cite ce qui serait relu comme un nombre", () => {
    // Le piège Compose : un port qui doit rester une chaîne.
    assert.match(emitYaml({ port: "8080" }), /^port: "8080"$/m);
    assert.match(emitYaml({ version: "1.5" }), /^version: "1\.5"$/m);
    assert.equal(emitYaml({ port: 8080 }).trim(), "port: 8080");
  });

  it("cite ce qui serait relu en base 60", () => {
    // Le `user:` de Compose, et le même piège que les adresses MAC en YAML 1.1.
    assert.match(emitYaml({ user: "1000:1000" }), /^user: "1000:1000"$/m);
    assert.match(emitYaml({ mac: "1:2:3:4:5:6" }), /^mac: "1:2:3:4:5:6"$/m);
    // Mais une image taguée n'est pas concernée.
    assert.match(emitYaml({ image: "postgres:16-alpine" }), /^image: postgres:16-alpine$/m);
  });

  it("cite ce qui contient de la syntaxe YAML", () => {
    assert.match(emitYaml({ key: "${TS_CERT_DOMAIN}" }), /^key: "\$\{TS_CERT_DOMAIN\}"$/m);
    assert.match(emitYaml({ key: "a: b" }), /^key: "a: b"$/m);
    assert.match(emitYaml({ key: "" }), /^key: ""$/m);
    assert.match(emitYaml({ key: " padded " }), /^key: " padded "$/m);
    assert.match(emitYaml({ key: "- item" }), /^key: "- item"$/m);
  });

  it("émet les booléens et les nombres sans guillemets", () => {
    assert.equal(emitYaml({ a: true, b: false, c: 42 }).trim(), "a: true\nb: false\nc: 42");
  });
});

describe("structure", () => {
  it("imbrique les tables avec deux espaces", () => {
    const out = emitYaml({ services: { app: { image: "nginx" } } });
    assert.equal(out, "services:\n  app:\n    image: nginx\n");
  });

  it("émet les listes de scalaires", () => {
    const out = emitYaml({ networks: ["internal", "other"] });
    assert.equal(out, "networks:\n  - internal\n  - other\n");
  });

  it("émet les listes de tables avec le tiret sur la première clé", () => {
    const out = emitYaml({ env_file: [{ path: "./.env", required: false }] });
    assert.equal(out, "env_file:\n  - path: ./.env\n    required: false\n");
  });

  it("émet les collections vides en ligne", () => {
    assert.equal(emitYaml({ volumes: {}, networks: [] }), "volumes: {}\nnetworks: []\n");
  });

  it("préfixe l'en-tête en commentaires", () => {
    const out = emitYaml({ name: "dbox" }, ["Généré par DBox", "ne pas éditer"]);
    assert.equal(out, "# Généré par DBox\n# ne pas éditer\n\nname: dbox\n");
  });
});
