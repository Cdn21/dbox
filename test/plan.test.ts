import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { composeFor, DEFAULT_CONTEXT, type Context } from "../src/compose.ts";
import { parseManifest } from "../src/manifest.ts";
import { planAll, planFor, type Plan } from "../src/plan.ts";

const CTX: Context = {
  ...DEFAULT_CONTEXT,
  tailnet: "tail4bb652.ts.net",
  uid: 1000,
  gid: 1000,
  sourcePath: "/home/serve/budget",
};

const MANIFEST = parseManifest(`
name = "budget"

[targets.dev]
mode = "workspace"
command = "npm run dev"
port = 5178

[targets.prod]
mode = "deployed"
port = 8080
`);

const DEVCONTAINER = parseManifest(`
name = "budget"

[targets.dev]
mode = "devcontainer"
command = "npm run dev"
port = 5178
`);

function fileIn(plan: Plan, suffix: string): string {
  const file = plan.files.find((candidate) => candidate.path.endsWith(suffix));
  assert.ok(file, `${suffix} absent du plan`);
  return file.content;
}

describe("invariant du mode privé", () => {
  it("n'émet jamais de ports publiés, quel que soit le mode", () => {
    for (const manifest of [MANIFEST, DEVCONTAINER]) {
      for (const plan of planAll(manifest, CTX)) {
        const compose = fileIn(plan, "docker-compose.yml");
        assert.doesNotMatch(
          compose,
          /^\s*ports:/m,
          `${plan.target} publie des ports — le mode privé est cassé`,
        );
        assert.doesNotMatch(compose, /^\s*expose:/m);
      }
    }
  });

  it("ssh_port ne publie rien non plus : le forward passe par le sidecar, pas Docker", () => {
    const withSsh = parseManifest(`
name = "git"

[targets.prod]
mode = "deployed"
port = 3000
ssh_port = 22
`);
    const compose = fileIn(planFor(withSsh, "prod", CTX), "docker-compose.yml");
    assert.doesNotMatch(compose, /^\s*ports:/m);
    assert.doesNotMatch(compose, /^\s*expose:/m);
  });
});

describe("cible workspace", () => {
  const plan = planFor(MANIFEST, "dev", CTX);

  it("nomme et adresse la machine", () => {
    assert.equal(plan.hostname, "budget-dev");
    assert.equal(plan.url, "https://budget-dev.tail4bb652.ts.net");
    assert.equal(plan.project, "dbox-budget-dev");
    assert.equal(plan.directory, "/opt/dbox/apps/budget/dev");
  });

  it("ne conteneurise pas l'app : la commande tourne sur l'hôte", () => {
    const compose = composeFor(MANIFEST, "dev", CTX);
    const services = compose["services"] as Record<string, unknown>;
    assert.deepEqual(Object.keys(services), ["tailscale"]);
  });

  it("proxifie vers l'hôte, via la passerelle Docker", () => {
    assert.equal(plan.upstream, "http://host.docker.internal:5178");
    assert.match(
      fileIn(plan, "docker-compose.yml"),
      /extra_hosts:\n\s+- host\.docker\.internal:host-gateway/,
    );
  });

  it("n'écrit pas de .env, faute de conteneur d'app", () => {
    assert.equal(
      plan.files.some((file) => file.path.endsWith("/.env")),
      false,
    );
  });
});

describe("cible deployed", () => {
  const plan = planFor(MANIFEST, "prod", CTX);

  it("porte le nom nu", () => {
    assert.equal(plan.hostname, "budget");
    assert.equal(plan.url, "https://budget.tail4bb652.ts.net");
  });

  it("construit l'image depuis les sources et la tague", () => {
    const app = (composeFor(MANIFEST, "prod", CTX)["services"] as Record<string, any>)["app"];
    assert.equal(app["image"], "dbox/budget:dev");
    assert.deepEqual(app["build"], { context: "/home/serve/budget", dockerfile: "Dockerfile" });
    assert.equal(app["restart"], "unless-stopped");
    // Surtout pas d'UID imposé : une image déployée gère son propre utilisateur.
    // Avec `user: 1000:1000`, nginx ne peut ni écouter sur 80 ni écrire son cache.
    assert.equal(app["user"], undefined);
  });

  it("proxifie vers le conteneur d'app", () => {
    assert.equal(plan.upstream, "http://app:8080");
  });

  it("écrit un .env et un ts.env en 0600", () => {
    for (const suffix of ["/.env", "/ts.env"]) {
      const file = plan.files.find((candidate) => candidate.path.endsWith(suffix));
      assert.ok(file, `${suffix} absent`);
      assert.equal(file.mode, 0o600);
    }
  });

  it("tague le nœud, sans quoi il finit par expirer", () => {
    assert.match(fileIn(plan, "docker-compose.yml"), /TS_EXTRA_ARGS: --advertise-tags=tag:dbox/);
  });

  it("n'annonce aucun tag quand il n'y en a pas", () => {
    // Annoncer un tag absent de `tagOwners` fait échouer le démarrage du nœud :
    // mieux vaut ne rien annoncer que d'annoncer à vide.
    const compose = fileIn(planFor(MANIFEST, "prod", { ...CTX, tsTag: null }), "docker-compose.yml");
    assert.doesNotMatch(compose, /TS_EXTRA_ARGS/);
    assert.doesNotMatch(compose, /advertise-tags/);
  });

  it("le tag de la cible prime sur celui de la machine", () => {
    const isole = parseManifest(`
name = "budget"

[targets.prod]
mode = "deployed"
port = 8080
ts_tag = "tag:secret"
`);
    const compose = fileIn(planFor(isole, "prod", CTX), "docker-compose.yml");
    assert.match(compose, /TS_EXTRA_ARGS: --advertise-tags=tag:secret/);
    assert.doesNotMatch(compose, /tag:dbox/);
  });

  it("le tag de la cible s'applique même quand la machine n'en annonce aucun", () => {
    const isole = parseManifest(`
name = "budget"

[targets.prod]
mode = "deployed"
port = 8080
ts_tag = "tag:secret"
`);
    const compose = fileIn(planFor(isole, "prod", { ...CTX, tsTag: null }), "docker-compose.yml");
    assert.match(compose, /TS_EXTRA_ARGS: --advertise-tags=tag:secret/);
  });
});

describe("cible devcontainer", () => {
  it("monte les sources et passe la commande par un shell", () => {
    const app = (composeFor(DEVCONTAINER, "dev", CTX)["services"] as Record<string, any>)["app"];
    assert.deepEqual(app["volumes"], ["/home/serve/budget:/workspace"]);
    assert.deepEqual(app["command"], ["sh", "-lc", "npm run dev"]);
    assert.equal(app["working_dir"], "/workspace");
    // Les fichiers créés appartiennent à l'utilisateur, pas à root.
    assert.equal(app["user"], "1000:1000");
  });
});

describe("redéploiement automatique", () => {
  it("est absent du descripteur par défaut", () => {
    const descriptor = JSON.parse(fileIn(planFor(MANIFEST, "prod", CTX), "dbox.json"));
    assert.equal(descriptor.autoDeploy, false);
  });

  it("se retrouve dans le descripteur quand activé", () => {
    const manifest = parseManifest(`
name = "budget"
[targets.prod]
mode = "deployed"
port = 8080
auto_deploy = true
`);
    const descriptor = JSON.parse(fileIn(planFor(manifest, "prod", CTX), "dbox.json"));
    assert.equal(descriptor.autoDeploy, true);
  });

  it("n'existe pas en mode workspace : rien à reconstruire", () => {
    assert.throws(
      () =>
        parseManifest(`
name = "budget"
[targets.dev]
mode = "workspace"
command = "npm run dev"
port = 5178
auto_deploy = true
`),
      /clé « auto_deploy » inattendue en mode workspace/,
    );
  });
});

describe("image de développement", () => {
  const AVEC_DOCKERFILE = parseManifest(`
name = "budget"
[targets.dev]
mode = "devcontainer"
command = "./run.sh dev"
port = 5173
dockerfile = "Dockerfile.dev"
`);

  it("construit son image quand le projet mêle deux runtimes", () => {
    const app = (composeFor(AVEC_DOCKERFILE, "dev", CTX)["services"] as Record<string, any>)["app"];
    assert.equal(app["image"], "dbox/budget-dev:dev");
    assert.deepEqual(app["build"], { context: "/home/serve/budget", dockerfile: "Dockerfile.dev" });
    assert.equal(planFor(AVEC_DOCKERFILE, "dev", CTX).builds, true);
  });

  it("se contente d'une image toute faite sinon", () => {
    const app = (composeFor(DEVCONTAINER, "dev", CTX)["services"] as Record<string, any>)["app"];
    assert.equal(app["image"], "node:24-bookworm-slim");
    assert.equal(app["build"], undefined);
    assert.equal(planFor(DEVCONTAINER, "dev", CTX).builds, false);
  });

  it("ne construit rien en mode workspace", () => {
    assert.equal(planFor(MANIFEST, "dev", CTX).builds, false);
  });
});

describe("stockage persistant", () => {
  const WITH_DATA = parseManifest(`
name = "budget"
[targets.prod]
mode = "deployed"
port = 5000
data = "/data"
`);

  it("monte un volume nommé, jamais anonyme", () => {
    const compose = composeFor(WITH_DATA, "prod", CTX);
    const app = (compose["services"] as Record<string, any>)["app"];
    assert.deepEqual(app["volumes"], ["data:/data"]);
    // Un volume anonyme disparaîtrait au premier `down -v` : la base avec.
    assert.deepEqual(Object.keys(compose["volumes"] as object), ["ts-state", "data"]);
  });

  it("ne déclare rien quand l'app ne stocke pas", () => {
    const compose = composeFor(MANIFEST, "prod", CTX);
    const app = (compose["services"] as Record<string, any>)["app"];
    assert.equal(app["volumes"], undefined);
    assert.deepEqual(Object.keys(compose["volumes"] as object), ["ts-state"]);
  });

  it("refuse un chemin relatif", () => {
    assert.throws(
      () => parseManifest(`name = "a"\n[targets.prod]\nmode = "deployed"\nport = 80\ndata = "donnees"\n`),
      /chemin absolu dans le conteneur/,
    );
  });
});

describe("serve.json", () => {
  it("garde ${TS_CERT_DOMAIN} littéral — c'est le conteneur qui l'interpole", () => {
    const raw = fileIn(planFor(MANIFEST, "prod", CTX), "serve.json");
    assert.match(raw, /"\$\{TS_CERT_DOMAIN\}:443"/);
    assert.deepEqual(JSON.parse(raw), {
      TCP: { "443": { HTTPS: true } },
      Web: {
        "${TS_CERT_DOMAIN}:443": { Handlers: { "/": { Proxy: "http://app:8080" } } },
      },
    });
  });

  it("forward le 22 en TCP brut quand la cible déclare ssh_port", () => {
    const withSsh = parseManifest(`
name = "git"

[targets.prod]
mode = "deployed"
port = 3000
ssh_port = 22
`);
    const raw = fileIn(planFor(withSsh, "prod", CTX), "serve.json");
    assert.deepEqual(JSON.parse(raw), {
      TCP: { "443": { HTTPS: true }, "22": { TCPForward: "app:22" } },
      Web: {
        "${TS_CERT_DOMAIN}:443": { Handlers: { "/": { Proxy: "http://app:3000" } } },
      },
    });
  });

  it("forward vers la passerelle Docker en mode workspace, comme le proxy HTTP", () => {
    const withSsh = parseManifest(`
name = "git"

[targets.dev]
mode = "workspace"
command = "forgejo"
port = 3000
ssh_port = 2222
`);
    const raw = fileIn(planFor(withSsh, "dev", CTX), "serve.json");
    assert.deepEqual(JSON.parse(raw).TCP["22"], { TCPForward: "host.docker.internal:2222" });
  });
});

describe("plan complet", () => {
  it("liste les fichiers attendus pour chaque cible", () => {
    assert.deepEqual(
      planAll(MANIFEST, CTX).map((plan) => [plan.target, plan.files.map((file) => file.path)]),
      [
        [
          "dev",
          [
            "/opt/dbox/apps/budget/dev/dbox.json",
            "/opt/dbox/apps/budget/dev/docker-compose.yml",
            "/opt/dbox/apps/budget/dev/serve.json",
            "/opt/dbox/apps/budget/dev/ts.env",
          ],
        ],
        [
          "prod",
          [
            "/opt/dbox/apps/budget/prod/dbox.json",
            "/opt/dbox/apps/budget/prod/docker-compose.yml",
            "/opt/dbox/apps/budget/prod/serve.json",
            "/opt/dbox/apps/budget/prod/ts.env",
            "/opt/dbox/apps/budget/prod/.env",
          ],
        ],
      ],
    );
  });

  it("refuse une cible inconnue en le disant", () => {
    assert.throws(() => planFor(MANIFEST, "staging", CTX), /cible « staging » inconnue/);
  });
});
