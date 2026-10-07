import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { hostnameFor, ManifestError, parseManifest, serializeManifest } from "../src/manifest.ts";

const VALID = `
name = "budget"

[targets.dev]
mode = "workspace"
command = "npm run dev"
port = 5178

[targets.prod]
mode = "deployed"
port = 8080
`;

function refuses(source: string, fragment: string): ManifestError {
  let error: unknown;
  try {
    parseManifest(source);
  } catch (thrown) {
    error = thrown;
  }
  assert.ok(error instanceof ManifestError, `aucune ManifestError levée pour ${JSON.stringify(source)}`);
  assert.match(error.message, new RegExp(fragment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  return error;
}

describe("manifeste valide", () => {
  it("lit les deux cibles", () => {
    const manifest = parseManifest(VALID);
    assert.equal(manifest.name, "budget");
    assert.deepEqual(manifest.targets["dev"], {
      mode: "workspace",
      command: "npm run dev",
      port: 5178,
      health: "/",
      tsTag: null,
      sshPort: null,
      backend: null,
    });
    assert.deepEqual(manifest.targets["prod"], {
      mode: "deployed",
      port: 8080,
      dockerfile: "Dockerfile",
      health: "/",
      data: null,
      autoDeploy: false,
      tsTag: null,
      sshPort: null,
      backend: null,
      publicDomain: null,
      services: {},
    });
  });

  it("applique l'image par défaut d'un devcontainer", () => {
    const manifest = parseManifest(
      `name = "a"\n[targets.dev]\nmode = "devcontainer"\ncommand = "npm run dev"\nport = 3000\n`,
    );
    assert.deepEqual(manifest.targets["dev"], {
      mode: "devcontainer",
      command: "npm run dev",
      port: 3000,
      // Même libc que l'hôte Ubuntu : les modules natifs ne cassent pas.
      image: "node:24-bookworm-slim",
      dockerfile: null,
      health: "/",
      data: null,
      autoDeploy: false,
      tsTag: null,
      sshPort: null,
      backend: null,
      publicDomain: null,
      services: {},
    });
  });
});

describe("nom de machine", () => {
  it("laisse « prod » nu et suffixe les autres", () => {
    assert.equal(hostnameFor("budget", "prod"), "budget");
    assert.equal(hostnameFor("budget", "dev"), "budget-dev");
  });

  it("refuse un souligné et propose la correction", () => {
    const error = refuses(
      `name = "mon_projet_perso"\n[targets.prod]\nmode = "deployed"\nport = 80\n`,
      "souligné",
    );
    assert.match(error.message, /mon-projet-perso/);
    assert.equal(error.line, 1);
  });

  it("refuse une majuscule", () => {
    refuses(`name = "Budget"\n[targets.prod]\nmode = "deployed"\nport = 80\n`, "majuscule");
  });

  it("valide la longueur du nom composé, pas seulement du nom", () => {
    const name = "a".repeat(60); // 60 valide seul, 64 une fois suffixé par « -dev »
    refuses(
      `name = "${name}"\n[targets.dev]\nmode = "workspace"\ncommand = "x"\nport = 80\n`,
      "maximum 63",
    );
  });

  it("ne peut pas produire deux fois le même nom dans un même manifeste", () => {
    // Propriété de la convention, pas une validation : « prod » donne le nom nu,
    // les autres cibles sont suffixées par un nom distinct par construction.
    const manifest = parseManifest(VALID);
    const hostnames = Object.keys(manifest.targets).map((target) =>
      hostnameFor(manifest.name, target),
    );
    assert.deepEqual(hostnames, ["budget-dev", "budget"]);
    assert.equal(new Set(hostnames).size, hostnames.length);
  });
});

describe("sérialisation", () => {
  it("fait l'aller-retour, mode par mode", () => {
    for (const source of [
      VALID,
      `name = "budget"\n[targets.dev]\nmode = "devcontainer"\ncommand = "npm run dev"\nport = 3000\nimage = "python:3.12"\ndockerfile = "Dockerfile.dev"\ndata = "/data"\nauto_deploy = true\nhealth = "/healthz"\n`,
      `name = "budget"\n[targets.prod]\nmode = "deployed"\nport = 8080\ndockerfile = "docker/Dockerfile"\ndata = "/var/lib/app"\nauto_deploy = true\nssh_port = 22\n`,
    ]) {
      const manifest = parseManifest(source);
      assert.deepEqual(parseManifest(serializeManifest(manifest)), manifest);
    }
  });

  it("n'écrit que ce qui diffère du défaut", () => {
    const manifest = parseManifest(VALID);
    const toml = serializeManifest(manifest);
    // « prod » n'a rien de plus que mode+port : health, data, auto_deploy à
    // leur défaut ne doivent pas polluer un fichier qu'on relit soi-même.
    assert.doesNotMatch(toml, /health/);
    assert.doesNotMatch(toml, /data/);
    assert.doesNotMatch(toml, /auto_deploy/);
    assert.doesNotMatch(toml, /dockerfile/);
    assert.doesNotMatch(toml, /ts_tag/);
    assert.doesNotMatch(toml, /ssh_port/);
    assert.doesNotMatch(toml, /public_domain/);
  });

  it("échappe ce qui casserait une chaîne TOML", () => {
    const manifest = parseManifest(
      `name = "budget"\n[targets.dev]\nmode = "workspace"\ncommand = "echo \\"salut\\""\nport = 80\n`,
    );
    assert.equal(manifest.targets["dev"]!.mode === "workspace" ? true : false, true);
    const roundTripped = parseManifest(serializeManifest(manifest));
    assert.deepEqual(roundTripped, manifest);
  });
});

describe("cibles refusées", () => {
  it("refuse un mode inconnu", () => {
    refuses(`name = "a"\n[targets.dev]\nmode = "vm"\nport = 80\n`, "mode « vm » inconnu");
  });

  it("refuse un port hors bornes", () => {
    refuses(
      `name = "a"\n[targets.dev]\nmode = "workspace"\ncommand = "x"\nport = 70000\n`,
      "port « 70000 » invalide",
    );
  });

  it("exige une commande en mode workspace", () => {
    refuses(`name = "a"\n[targets.dev]\nmode = "workspace"\nport = 80\n`, "command » est obligatoire");
  });

  it("refuse une commande en mode deployed, et dit où elle existe", () => {
    const error = refuses(
      `name = "a"\n[targets.prod]\nmode = "deployed"\ncommand = "x"\nport = 80\n`,
      "clé « command » inattendue en mode deployed",
    );
    assert.match(error.message, /workspace ou devcontainer/);
  });

  it("refuse une clé inconnue plutôt que de l'ignorer", () => {
    refuses(
      `name = "a"\n[targets.dev]\nmode = "workspace"\ncommand = "x"\nport = 80\nreplicas = 3\n`,
      "clé « replicas » inattendue",
    );
  });

  it("refuse un manifeste sans cible", () => {
    refuses(`name = "a"\n`, "aucune cible");
  });

  it("refuse une clé inconnue à la racine", () => {
    refuses(`name = "a"\nversion = 2\n[targets.prod]\nmode = "deployed"\nport = 80\n`, "clé inconnue");
  });
});

describe("tag ACL par cible", () => {
  it("hérite du tag de la machine par défaut : absent du manifeste", () => {
    const manifest = parseManifest(VALID);
    assert.equal(manifest.targets["prod"]!.tsTag, null);
  });

  it("lit un tag valide, dans les trois modes", () => {
    for (const source of [
      `name = "a"\n[targets.prod]\nmode = "deployed"\nport = 80\nts_tag = "tag:secret"\n`,
      `name = "a"\n[targets.dev]\nmode = "workspace"\ncommand = "x"\nport = 80\nts_tag = "tag:secret"\n`,
      `name = "a"\n[targets.dev]\nmode = "devcontainer"\ncommand = "x"\nport = 80\nts_tag = "tag:secret"\n`,
    ]) {
      const manifest = parseManifest(source);
      const target = manifest.targets[Object.keys(manifest.targets)[0]!]!;
      assert.equal(target.tsTag, "tag:secret");
    }
  });

  it("refuse un tag mal formé, et rappelle le prérequis tagOwners", () => {
    const error = refuses(
      `name = "a"\n[targets.prod]\nmode = "deployed"\nport = 80\nts_tag = "secret"\n`,
      "doit ressembler à « tag:mon-tag »",
    );
    assert.match(error.message, /tagOwners/);
  });

  it("refuse un tag avec majuscule ou souligné, comme un nom de machine", () => {
    refuses(`name = "a"\n[targets.prod]\nmode = "deployed"\nport = 80\nts_tag = "tag:Secret"\n`, "ts_tag");
    refuses(`name = "a"\n[targets.prod]\nmode = "deployed"\nport = 80\nts_tag = "tag:mon_app"\n`, "ts_tag");
  });

  it("fait l'aller-retour à la sérialisation", () => {
    const manifest = parseManifest(
      `name = "a"\n[targets.prod]\nmode = "deployed"\nport = 80\nts_tag = "tag:secret"\n`,
    );
    const toml = serializeManifest(manifest);
    assert.match(toml, /ts_tag = "tag:secret"/);
    assert.deepEqual(parseManifest(toml), manifest);
  });
});

describe("forward SSH par cible", () => {
  it("absent du manifeste par défaut", () => {
    const manifest = parseManifest(VALID);
    assert.equal(manifest.targets["prod"]!.sshPort, null);
  });

  it("lit un port SSH valide, dans les trois modes", () => {
    for (const source of [
      `name = "a"\n[targets.prod]\nmode = "deployed"\nport = 80\nssh_port = 22\n`,
      `name = "a"\n[targets.dev]\nmode = "workspace"\ncommand = "x"\nport = 80\nssh_port = 22\n`,
      `name = "a"\n[targets.dev]\nmode = "devcontainer"\ncommand = "x"\nport = 80\nssh_port = 22\n`,
    ]) {
      const manifest = parseManifest(source);
      const target = manifest.targets[Object.keys(manifest.targets)[0]!]!;
      assert.equal(target.sshPort, 22);
    }
  });

  it("refuse un port hors bornes", () => {
    refuses(
      `name = "a"\n[targets.prod]\nmode = "deployed"\nport = 80\nssh_port = 70000\n`,
      "« ssh_port » invalide",
    );
  });

  it("fait l'aller-retour à la sérialisation", () => {
    const manifest = parseManifest(`name = "a"\n[targets.prod]\nmode = "deployed"\nport = 80\nssh_port = 22\n`);
    const toml = serializeManifest(manifest);
    assert.match(toml, /ssh_port = 22/);
    assert.deepEqual(parseManifest(toml), manifest);
  });
});

describe("services compagnons", () => {
  const AVEC_DB = `
name = "budget"

[targets.prod]
mode = "deployed"
port = 8080

[targets.prod.services.db]
image = "postgres:16-alpine"
data = "/var/lib/postgresql/data"
`;

  const compagnons = (source: string) => {
    const cible = parseManifest(source).targets["prod"]!;
    return cible.mode === "workspace" ? {} : cible.services;
  };

  it("absents par défaut : un objet vide, jamais null", () => {
    assert.deepEqual(compagnons(VALID), {});
  });

  it("lit image et data", () => {
    assert.deepEqual(compagnons(AVEC_DB), {
      db: { image: "postgres:16-alpine", data: "/var/lib/postgresql/data" },
    });
  });

  it("data est optionnel : un cache n'a rien à garder", () => {
    const s = compagnons(`name = "a"\n[targets.prod]\nmode = "deployed"\nport = 80\n[targets.prod.services.cache]\nimage = "redis:7-alpine"\n`);
    assert.deepEqual(s, { cache: { image: "redis:7-alpine", data: null } });
  });

  it("marche aussi en devcontainer", () => {
    const m = parseManifest(`name = "a"\n[targets.dev]\nmode = "devcontainer"\ncommand = "x"\nport = 80\n[targets.dev.services.db]\nimage = "postgres:16"\n`);
    const cible = m.targets["dev"]!;
    assert.deepEqual(Object.keys(cible.mode === "workspace" ? {} : cible.services), ["db"]);
  });

  it("refusés en workspace : injoignables depuis un processus de l'hôte", () => {
    refuses(
      `name = "a"\n[targets.dev]\nmode = "workspace"\ncommand = "x"\nport = 80\n[targets.dev.services.db]\nimage = "postgres:16"\n`,
      "clé « services » inattendue en mode workspace",
    );
  });

  it("exige une image — il n'y a rien à deviner", () => {
    refuses(
      `name = "a"\n[targets.prod]\nmode = "deployed"\nport = 80\n[targets.prod.services.db]\ndata = "/data"\n`,
      "est obligatoire",
    );
  });

  it("refuse un nom qui entrerait en collision avec un service généré", () => {
    for (const nom of ["app", "tailscale", "caddy"]) {
      refuses(
        `name = "a"\n[targets.prod]\nmode = "deployed"\nport = 80\n[targets.prod.services.${nom}]\nimage = "x"\n`,
        "est réservé",
      );
    }
  });

  it("refuse un nom qui ne serait pas joignable comme hôte", () => {
    refuses(
      `name = "a"\n[targets.prod]\nmode = "deployed"\nport = 80\n[targets.prod.services.MaBase]\nimage = "x"\n`,
      "n'est pas un nom de service valide",
    );
  });

  it("refuse une clé inconnue plutôt que de l'ignorer", () => {
    // Sans ça, un `command` ou un `ports` écrit ici disparaîtrait en silence.
    refuses(
      `name = "a"\n[targets.prod]\nmode = "deployed"\nport = 80\n[targets.prod.services.db]\nimage = "x"\ncommand = "postgres"\n`,
      "clé « command » inattendue dans un service",
    );
  });

  it("refuse un « : » dans data, comme pour l'app", () => {
    refuses(
      `name = "a"\n[targets.prod]\nmode = "deployed"\nport = 80\n[targets.prod.services.db]\nimage = "x"\ndata = "/data:ro"\n`,
      "ne peut pas contenir",
    );
  });

  it("refuse un data relatif, comme pour l'app", () => {
    refuses(
      `name = "a"\n[targets.prod]\nmode = "deployed"\nport = 80\n[targets.prod.services.db]\nimage = "x"\ndata = "donnees"\n`,
      "chemin absolu dans le conteneur",
    );
  });

  it("fait l'aller-retour à la sérialisation, avec deux compagnons", () => {
    const manifest = parseManifest(
      `${AVEC_DB}\n[targets.prod.services.cache]\nimage = "redis:7-alpine"\n`,
    );
    const toml = serializeManifest(manifest);
    assert.match(toml, /\[targets\.prod\.services\.db\]/);
    assert.match(toml, /\[targets\.prod\.services\.cache\]/);
    assert.deepEqual(parseManifest(toml), manifest);
  });

  it("n'écrit rien quand il n'y en a pas", () => {
    assert.doesNotMatch(serializeManifest(parseManifest(VALID)), /services/);
  });
});

describe("domaine public par cible", () => {
  it("absent du manifeste par défaut", () => {
    const manifest = parseManifest(VALID);
    const prod = manifest.targets["prod"]!;
    assert.equal(prod.mode === "deployed" ? prod.publicDomain : "absent", null);
  });

  it("lit un domaine valide, en deployed et en devcontainer", () => {
    for (const source of [
      `name = "a"\n[targets.prod]\nmode = "deployed"\nport = 80\npublic_domain = "budget.exemple.fr"\n`,
      `name = "a"\n[targets.dev]\nmode = "devcontainer"\ncommand = "x"\nport = 80\npublic_domain = "budget.exemple.fr"\n`,
    ]) {
      const manifest = parseManifest(source);
      const target = manifest.targets[Object.keys(manifest.targets)[0]!]!;
      assert.equal(target.mode === "workspace" ? null : target.publicDomain, "budget.exemple.fr");
    }
  });

  it("refuse public_domain en mode workspace : rien à router sans conteneur", () => {
    refuses(
      `name = "a"\n[targets.dev]\nmode = "workspace"\ncommand = "x"\nport = 80\npublic_domain = "x.exemple.fr"\n`,
      "clé « public_domain » inattendue en mode workspace",
    );
  });

  it("refuse ce qui n'est pas un domaine — URL, chemin, nom sans point", () => {
    for (const valeur of ['"https://budget.exemple.fr"', '"budget.exemple.fr/app"', '"budget"', "8080"]) {
      refuses(
        `name = "a"\n[targets.prod]\nmode = "deployed"\nport = 80\npublic_domain = ${valeur}\n`,
        "« public_domain » doit être un nom de domaine",
      );
    }
  });

  it("fait l'aller-retour à la sérialisation", () => {
    const manifest = parseManifest(
      `name = "a"\n[targets.prod]\nmode = "deployed"\nport = 80\npublic_domain = "budget.exemple.fr"\n`,
    );
    const toml = serializeManifest(manifest);
    assert.match(toml, /public_domain = "budget\.exemple\.fr"/);
    assert.deepEqual(parseManifest(toml), manifest);
  });
});
