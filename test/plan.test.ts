import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { composeFor, DEFAULT_CONTEXT, type Context } from "../src/compose.ts";
import { parseManifest } from "../src/manifest.ts";
import { planAll, planFor, type Plan } from "../src/plan.ts";

const CTX: Context = {
  ...DEFAULT_CONTEXT,
  tailnet: "mon-tailnet.ts.net",
  uid: 1000,
  gid: 1000,
  sourcePath: "/home/serve/budget",
};

const CTX_TRAEFIK: Context = {
  ...CTX,
  traefik: { network: "traefik-net", certResolver: "letsencrypt" },
};

const PUBLIC = parseManifest(`
name = "budget"

[targets.prod]
mode = "deployed"
port = 8080
public_domain = "budget.exemple.fr"
`);

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

  it("reste vrai pour une cible publique : Traefik passe par le réseau, pas par un port", () => {
    const compose = fileIn(planFor(PUBLIC, "prod", CTX_TRAEFIK), "docker-compose.yml");
    assert.doesNotMatch(compose, /^\s*ports:/m);
    assert.doesNotMatch(compose, /^\s*expose:/m);
  });

  it("reste vrai avec des compagnons : une base ne se publie jamais non plus", () => {
    const avecDb = parseManifest(`
name = "budget"

[targets.prod]
mode = "deployed"
port = 8080

[targets.prod.services.db]
image = "postgres:16-alpine"
data = "/var/lib/postgresql/data"
`);
    const compose = fileIn(planFor(avecDb, "prod", CTX), "docker-compose.yml");
    assert.doesNotMatch(compose, /^\s*ports:/m);
    assert.doesNotMatch(compose, /^\s*expose:/m);
  });
});

describe("services compagnons", () => {
  const AVEC_DB = parseManifest(`
name = "budget"

[targets.prod]
mode = "deployed"
port = 8080
data = "/app/data"

[targets.prod.services.db]
image = "postgres:16-alpine"
data = "/var/lib/postgresql/data"

[targets.prod.services.cache]
image = "redis:7-alpine"
`);

  const servicesDe = (m: typeof AVEC_DB, ctx = CTX) =>
    composeFor(m, "prod", ctx)["services"] as Record<string, any>;

  it("ajoute un service par compagnon, à côté de l'app et du sidecar", () => {
    assert.deepEqual(Object.keys(servicesDe(AVEC_DB)), ["app", "db", "cache", "tailscale"]);
  });

  it("monte un volume nommé d'après le compagnon, jamais « data » qui est à l'app", () => {
    const compose = composeFor(AVEC_DB, "prod", CTX);
    assert.deepEqual((compose["services"] as any)["db"]["volumes"], ["db-data:/var/lib/postgresql/data"]);
    assert.deepEqual(Object.keys(compose["volumes"] as object), ["ts-state", "data", "db-data"]);
  });

  it("ne déclare aucun volume pour un compagnon sans état", () => {
    assert.equal(servicesDe(AVEC_DB)["cache"]["volumes"], undefined);
  });

  it("l'app démarre après ses compagnons, sans condition faute de healthcheck", () => {
    assert.deepEqual(servicesDe(AVEC_DB)["app"]["depends_on"], ["db", "cache"]);
  });

  it("le compagnon partage le .env de l'app et reste sur le réseau interne", () => {
    const db = servicesDe(AVEC_DB)["db"];
    assert.deepEqual(db["env_file"], ["./.env"]);
    assert.deepEqual(db["networks"], ["internal"]);
    assert.equal(db["image"], "postgres:16-alpine");
  });

  it("un compagnon n'est jamais exposé, même quand la cible est publique", () => {
    const publique = parseManifest(`
name = "budget"

[targets.prod]
mode = "deployed"
port = 8080
public_domain = "budget.exemple.fr"

[targets.prod.services.db]
image = "postgres:16-alpine"
`);
    const services = servicesDe(publique, CTX_TRAEFIK);
    // L'app est routée…
    assert.ok(services["app"]["labels"].includes("traefik.enable=true"));
    // …le compagnon ne l'est pas, et ne rejoint pas le réseau public.
    assert.equal(services["db"]["labels"], undefined);
    assert.deepEqual(services["db"]["networks"], ["internal"]);
  });

  it("laisse le sidecar strictement inchangé", () => {
    const sans = (composeFor(MANIFEST, "prod", CTX)["services"] as any)["tailscale"];
    assert.deepEqual(servicesDe(AVEC_DB)["tailscale"], sans);
  });

  it("consigne les noms dans dbox.json, et une liste vide sans compagnon", () => {
    assert.deepEqual(JSON.parse(fileIn(planFor(AVEC_DB, "prod", CTX), "dbox.json")).services, ["db", "cache"]);
    assert.deepEqual(JSON.parse(fileIn(planFor(MANIFEST, "prod", CTX), "dbox.json")).services, []);
  });
});

describe("cible publique", () => {
  it("refuse public_domain sur une machine sans réglage traefik", () => {
    assert.throws(() => planFor(PUBLIC, "prod", CTX), /traefik/);
  });

  it("refuse ssh_port et public_domain ensemble", () => {
    const both = parseManifest(`
name = "git"

[targets.prod]
mode = "deployed"
port = 3000
ssh_port = 22
public_domain = "git.exemple.fr"
`);
    assert.throws(() => planFor(both, "prod", CTX_TRAEFIK), /ssh_port/);
  });

  it("joint le réseau du Traefik en plus du réseau interne, jamais à sa place", () => {
    const app = (composeFor(PUBLIC, "prod", CTX_TRAEFIK)["services"] as Record<string, any>)["app"];
    assert.deepEqual(app["networks"], ["internal", "traefik-net"]);
  });

  it("déclare le réseau du Traefik external : sinon Compose en créerait un autre", () => {
    const compose = composeFor(PUBLIC, "prod", CTX_TRAEFIK);
    assert.deepEqual(compose["networks"], {
      internal: { name: "dbox-budget-prod_internal" },
      "traefik-net": { external: true, name: "traefik-net" },
    });
  });

  it("dérive les noms de routeur du projet complet, jamais du seul nom d'app", () => {
    // Deux apps différentes, même nom de cible : leurs routes ne doivent pas
    // pouvoir se marcher dessus.
    const autre = parseManifest(`
name = "autre"

[targets.prod]
mode = "deployed"
port = 8080
public_domain = "autre.exemple.fr"
`);
    const labels = (composeFor(PUBLIC, "prod", CTX_TRAEFIK)["services"] as Record<string, any>)["app"]["labels"];
    const labelsAutre = (composeFor(autre, "prod", CTX_TRAEFIK)["services"] as Record<string, any>)["app"]["labels"];

    assert.deepEqual(labels, [
      "traefik.enable=true",
      "traefik.http.routers.dbox-budget-prod.rule=Host(`budget.exemple.fr`)",
      "traefik.http.routers.dbox-budget-prod.entrypoints=websecure",
      "traefik.http.routers.dbox-budget-prod.tls.certresolver=letsencrypt",
      "traefik.http.services.dbox-budget-prod.loadbalancer.server.port=8080",
      "traefik.docker.network=traefik-net",
    ]);
    assert.ok(labelsAutre.some((l: string) => l.includes("dbox-autre-prod")));
    assert.equal(labelsAutre.some((l: string) => l.includes("dbox-budget-prod")), false);
  });

  it("laisse le sidecar strictement inchangé — l'exposition est additive", () => {
    const prive = (composeFor(MANIFEST, "prod", CTX)["services"] as Record<string, any>)["tailscale"];
    const publique = (composeFor(PUBLIC, "prod", CTX_TRAEFIK)["services"] as Record<string, any>)["tailscale"];
    assert.deepEqual(publique, prive);
  });

  it("ne pose ni labels ni réseau public sur une cible privée", () => {
    const compose = composeFor(MANIFEST, "prod", CTX_TRAEFIK);
    const app = (compose["services"] as Record<string, any>)["app"];
    assert.equal(app["labels"], undefined);
    assert.deepEqual(app["networks"], ["internal"]);
    assert.deepEqual(Object.keys(compose["networks"] as object), ["internal"]);
  });

  it("consigne le domaine dans dbox.json, et null quand il n'y en a pas", () => {
    const publique = JSON.parse(fileIn(planFor(PUBLIC, "prod", CTX_TRAEFIK), "dbox.json"));
    assert.equal(publique.publicDomain, "budget.exemple.fr");

    const privee = JSON.parse(fileIn(planFor(MANIFEST, "prod", CTX), "dbox.json"));
    assert.equal(privee.publicDomain, null);
  });

  it("marche aussi en devcontainer", () => {
    const dev = parseManifest(`
name = "budget"

[targets.dev]
mode = "devcontainer"
command = "npm run dev"
port = 5178
public_domain = "budget-dev.exemple.fr"
`);
    const app = (composeFor(dev, "dev", CTX_TRAEFIK)["services"] as Record<string, any>)["app"];
    assert.ok(app["labels"].includes("traefik.http.services.dbox-budget-dev.loadbalancer.server.port=5178"));
  });
});

describe("cible workspace", () => {
  const plan = planFor(MANIFEST, "dev", CTX);

  it("nomme et adresse la machine", () => {
    assert.equal(plan.hostname, "budget-dev");
    assert.equal(plan.url, "https://budget-dev.mon-tailnet.ts.net");
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

describe("une image construite par DBox ne se télécharge jamais", () => {
  // Sur Docker Hub, l'espace `dbox` appartient à un tiers : une image
  // `dbox/<app>:<tag>` absente en local ne doit jamais être tirée de là.
  const services = (manifest: ReturnType<typeof parseManifest>, cible: string) =>
    composeFor(manifest, cible, CTX)["services"] as Record<string, any>;

  it("en deployed", () => {
    assert.equal(services(MANIFEST, "prod")["app"]["pull_policy"], "never");
  });

  it("en devcontainer construit depuis un Dockerfile", () => {
    const avecDockerfile = parseManifest(`
name = "budget"

[targets.dev]
mode = "devcontainer"
dockerfile = "Dockerfile.dev"
command = "npm run dev"
port = 5178
`);
    assert.equal(services(avecDockerfile, "dev")["app"]["pull_policy"], "never");
  });

  it("mais une image toute faite reste téléchargeable", () => {
    // `node:24-bookworm-slim` n'existe qu'au registre : l'interdire casserait le mode.
    assert.equal(services(DEVCONTAINER, "dev")["app"]["pull_policy"], undefined);
  });
});

describe("cible deployed", () => {
  const plan = planFor(MANIFEST, "prod", CTX);

  it("porte le nom nu", () => {
    assert.equal(plan.hostname, "budget");
    assert.equal(plan.url, "https://budget.mon-tailnet.ts.net");
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

  it("refuse un « : », que Docker lirait comme des options de montage", () => {
    // « /data:ro » produirait un montage en lecture seule au lieu du chemin
    // demandé : un sens changé en silence, vérifié contre le vrai Docker.
    for (const chemin of ["/data:ro", "/a:b:rw"]) {
      assert.throws(
        () => parseManifest(`name = "a"\n[targets.prod]\nmode = "deployed"\nport = 80\ndata = "${chemin}"\n`),
        /ne peut pas contenir/,
      );
    }
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
