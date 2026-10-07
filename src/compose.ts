/**
 * Une cible → un objet Compose.
 *
 * Invariant de sécurité du mode privé : **aucune clé `ports:` n'est jamais
 * émise**. L'app n'est joignable que par le sidecar Tailscale, à travers le
 * réseau du projet. Un test garde cet invariant.
 */

import { hostnameFor, type Backend, type CompanionService, type Manifest, type Target } from "./manifest.ts";
import type { YamlMap } from "./yaml.ts";

export interface Context {
  /** Où vivent les fichiers générés sur la machine cible. */
  root: string;
  /** Domaine du tailnet, pour l'URL affichée (« mon-tailnet.ts.net »). */
  tailnet: string;
  uid: number;
  gid: number;
  /**
   * Tag ACL porté par les nœuds créés. `null` pour ne rien annoncer.
   *
   * Un nœud tagué n'expire pas ; un nœud sans tag finit par tomber du tailnet.
   * Mais annoncer un tag que la policy ne déclare pas fait **échouer** le
   * démarrage — d'où la possibilité de s'en passer tant que `tagOwners` n'est
   * pas en place.
   */
  tsTag: string | null;
  /** Tag d'image pour le mode `deployed` : le SHA git, ou « dev ». */
  imageTag: string;
  tailscaleImage: string;
  /** Dossier des sources sur la machine cible. */
  sourcePath: string;
  /**
   * Réglages du Traefik déjà en service sur cette machine, pour les cibles qui
   * posent `public_domain`. `null` : mode public indisponible ici — une cible
   * qui le demanderait est refusée, jamais routée vers un Traefik deviné.
   */
  traefik: TraefikConfig | null;
  /** Backend d'exposition par défaut de la machine — une cible peut le
   * redéfinir (`target.backend`), comme `tsTag`. */
  backend: Backend;
  /** Réglages headscale de la machine — `null` tant qu'aucune cible ne les
   * utilise (et alors `backend = "headscale"` est un refus, pas un défaut deviné). */
  headscale: HeadscaleConfig | null;
  /** Image du service Caddy en backend headscale — miroir de `tailscaleImage`. */
  caddyImage: string;
}

/**
 * Ce qu'il faut pour parler à un Headscale : l'URL du serveur de coordination
 * (`--login-server` du sidecar), et le dossier hôte du certificat wildcard du
 * tailnet (`<tailnet>.crt`/`<tailnet>.key`), obtenu une fois, à la main, par
 * DNS-01 — jamais par DBox, `tailscale cert` n'a pas d'équivalent contre
 * Headscale (voir `caddyService`).
 */
export interface HeadscaleConfig {
  loginServer: string;
  certDir: string;
}

/**
 * Ce qu'il faut savoir du Traefik de la machine pour lui confier une cible.
 *
 * DBox ne fournit ni n'installe ce Traefik, et ne modifie jamais sa
 * configuration : il pose seulement, sur ses propres conteneurs, les labels que
 * le provider Docker de Traefik découvre de lui-même. Un seul processus pouvant
 * tenir le 80/443 d'une machine, c'est forcément celui qui y tourne déjà.
 */
export interface TraefikConfig {
  /** Réseau Docker externe que ce Traefik écoute, déjà créé — jamais par DBox. */
  network: string;
  /** Resolver ACME déclaré dans sa config statique (`certificatesResolvers`). */
  certResolver: string;
}

export const DEFAULT_CONTEXT: Omit<Context, "sourcePath" | "tailnet" | "uid" | "gid"> = {
  root: "/opt/dbox/apps",
  tsTag: "tag:dbox",
  imageTag: "dev",
  tailscaleImage: "tailscale/tailscale:stable",
  traefik: null,
  backend: "tailscale",
  headscale: null,
  caddyImage: "caddy:2",
};

/**
 * Résout le backend d'une cible (redéfinition locale, sinon le défaut de la
 * machine), et refuse tout de suite ce qui ne pourrait jamais fonctionner —
 * avant d'écrire quoi que ce soit, pas après. Même esprit que le refus de
 * `public_domain` sans Traefik.
 */
export function backendFor(target: Target, ctx: Context, targetName: string): Backend {
  const backend = target.backend ?? ctx.backend;
  if (backend === "headscale" && ctx.headscale === null) {
    throw new Error(
      `cible « ${targetName} » : backend = "headscale" mais aucun réglage headscale n'est configuré sur ` +
        `cette machine — pose headscale_login_server et headscale_cert_dir (config.toml ou ` +
        `--headscale-login-server / --headscale-cert-dir)`,
    );
  }
  if (backend === "headscale" && target.sshPort !== null) {
    throw new Error(
      `cible « ${targetName} » : ssh_port n'est pas pris en charge avec backend = "headscale" pour l'instant ` +
        `(caddy:2 n'a pas d'équivalent à TCPForward) — retire ssh_port ou repasse en backend = "tailscale"`,
    );
  }
  return backend;
}

/**
 * Une image que DBox construit ne se télécharge jamais. Sans ça, Compose tente
 * d'abord un `pull` de `dbox/<app>:<tag>` quand l'image manque en local (après
 * un `docker image prune`, typiquement) — et sur Docker Hub, l'espace `dbox`
 * appartient à un tiers : qu'il publie ce nom et ce tag, et son image tourne à
 * la place de l'app, avec son `.env` et ses données. Vérifié le 4 octobre 2026.
 * Avec `never`, une image absente se reconstruit, ou fait échouer `--no-build`.
 */
const PULL_JAMAIS = "never";

export function projectName(app: string, target: string): string {
  return `dbox-${app}-${target}`;
}

/** L'adresse que le sidecar proxifie. En `workspace`, l'app tourne sur l'hôte. */
export function upstreamFor(target: Target): string {
  const host = target.mode === "workspace" ? "host.docker.internal" : "app";
  return `http://${host}:${target.port}`;
}

/** `null` : pas de port SSH déclaré, le sidecar ne forward rien en TCP brut.
 * Pas de schéma `http://` ici — `TCPForward` attend `hôte:port` tel quel. */
export function sshUpstreamFor(target: Target): string | null {
  if (target.sshPort === null) return null;
  const host = target.mode === "workspace" ? "host.docker.internal" : "app";
  return `${host}:${target.sshPort}`;
}

/**
 * Résout si cette cible est aussi exposée publiquement, et refuse tout de suite
 * ce qui ne pourrait de toute façon jamais fonctionner — avant la moindre
 * écriture. Point de refus **unique** : appelé par `composeFor` comme par
 * `planFor`, donc impossible à contourner par un autre chemin d'appel.
 *
 * Rien à hériter d'un défaut de machine, contrairement à `tsTag` : une cible
 * n'est publique que si son propre manifeste le dit.
 */
export function publicDomainFor(target: Target, ctx: Context, targetName: string): string | null {
  // Le mode workspace ne porte pas le champ (voir `Published` dans manifest.ts).
  const domain = target.mode === "workspace" ? null : target.publicDomain;
  if (domain === null) return null;

  if (ctx.traefik === null) {
    throw new Error(
      `cible « ${targetName} » : public_domain = "${domain}" mais aucun réglage traefik n'est configuré sur ` +
        `cette machine — pose traefik_network et traefik_cert_resolver (config.toml ou --traefik-network / ` +
        `--traefik-cert-resolver)`,
    );
  }
  if (target.sshPort !== null) {
    throw new Error(
      `cible « ${targetName} » : ssh_port n'est pas pris en charge avec public_domain pour l'instant ` +
        `(Traefik route le TCP par SNI, ce que le forward brut du sidecar ne fait pas) — retire l'un des deux`,
    );
  }
  return domain;
}

export function composeFor(manifest: Manifest, targetName: string, ctx: Context): YamlMap {
  const target = manifest.targets[targetName];
  if (target === undefined) throw new Error(`cible « ${targetName} » inconnue`);

  const backend = backendFor(target, ctx, targetName);
  const project = projectName(manifest.name, targetName);
  const hostname = hostnameFor(manifest.name, targetName);
  const network = `${project}_internal`;
  const user = `${ctx.uid}:${ctx.gid}`;

  const publicDomain = publicDomainFor(target, ctx, targetName);

  // Le mode workspace ne porte pas de compagnons (voir `Companioned`).
  const compagnons = target.mode === "workspace" ? {} : target.services;
  const noms = Object.keys(compagnons);

  const services: YamlMap = {};
  const app = appService(manifest.name, target, ctx, user, project, publicDomain, noms);
  if (app !== undefined) services["app"] = app;
  for (const [nom, compagnon] of Object.entries(compagnons)) {
    services[nom] = companionService(nom, compagnon);
  }
  // Le sidecar ne change jamais quand la cible devient publique : l'exposition
  // est additive, l'accès privé par le tailnet reste là même si le public casse.
  services["tailscale"] = tailscaleService(hostname, target, ctx, app !== undefined, backend);
  // Backend headscale : un Caddy voisin termine le TLS à la place de
  // `tailscale serve` (pas de `tailscale cert` contre Headscale).
  if (backend === "headscale") services["caddy"] = caddyService(ctx);

  const volumes: YamlMap = { "ts-state": {} };
  // Volume **nommé** et non anonyme : un volume anonyme disparaît au premier
  // `down -v` ou `--renew-anon-volumes`, ce qui emporterait la base de l'app.
  if (target.mode !== "workspace" && target.data !== null) volumes["data"] = {};
  // Un volume par compagnon qui stocke, nommé d'après lui — jamais `data`, qui
  // appartient à l'app, ni `ts-state`, qui appartient au sidecar.
  for (const [nom, compagnon] of Object.entries(compagnons)) {
    if (compagnon.data !== null) volumes[`${nom}-data`] = {};
  }

  const networks: YamlMap = { internal: { name: network } };
  if (publicDomain !== null) {
    // `external: true` est indispensable : sans lui, Compose créerait un
    // réseau à lui, préfixé par le nom du projet — que le vrai Traefik
    // n'écoute jamais. L'app serait sur le tailnet, invisible du public.
    networks[ctx.traefik!.network] = { external: true, name: ctx.traefik!.network };
  }

  return { name: project, services, networks, volumes };
}

function appService(
  app: string,
  target: Target,
  ctx: Context,
  user: string,
  project: string,
  publicDomain: string | null,
  compagnons: string[],
): YamlMap | undefined {
  // En mode `workspace`, la commande tourne sur l'hôte : rien à conteneuriser.
  if (target.mode === "workspace") return undefined;

  if (target.mode === "deployed") {
    // Pas de `user:` ici, volontairement : une image déployée gère son propre
    // utilisateur. Lui imposer l'UID de l'hôte casse les images officielles —
    // nginx ne peut plus ni écouter sur 80 ni écrire son cache. C'est au
    // Dockerfile de décider, il appartient à l'app.
    const service: YamlMap = {
      image: `dbox/${app}:${ctx.imageTag}`,
      build: { context: ctx.sourcePath, dockerfile: target.dockerfile },
      pull_policy: PULL_JAMAIS,
      env_file: ["./.env"],
      restart: "unless-stopped",
      networks: ["internal"],
    };
    if (target.data !== null) service["volumes"] = [`data:${target.data}`];
    dependre(service, compagnons);
    publish(service, ctx, project, publicDomain, target.port);
    return service;
  }

  const service: YamlMap = {
    image: target.dockerfile === null ? target.image : `dbox/${app}-dev:${ctx.imageTag}`,
    // Forme exec avec un shell explicite : `npm run dev` comme une commande
    // composée s'exécutent pareil.
    command: ["sh", "-lc", target.command],
    working_dir: "/workspace",
    // Ici l'UID compte : les sources sont montées depuis l'hôte, et sans ça les
    // fichiers créés dans le conteneur arrivent en root dans ton dépôt.
    user,
    volumes:
      target.data === null
        ? [`${ctx.sourcePath}:/workspace`]
        : [`${ctx.sourcePath}:/workspace`, `data:${target.data}`],
    env_file: ["./.env"],
    restart: "unless-stopped",
    networks: ["internal"],
  };

  if (target.dockerfile !== null) {
    service["build"] = { context: ctx.sourcePath, dockerfile: target.dockerfile };
    service["pull_policy"] = PULL_JAMAIS;
  }
  dependre(service, compagnons);
  publish(service, ctx, project, publicDomain, target.port);
  return service;
}

/**
 * Un service compagnon : une image toute faite sur le réseau interne, rien de
 * plus. **Jamais de `ports`, jamais de labels Traefik, jamais le réseau
 * public** — seul le service `app` est exposé, ici comme ailleurs
 * (invariant 1). Il partage le `.env` de l'app : c'est ce que fait un compose
 * écrit à la main, le fichier est déjà en 0600, et une image ignore les
 * variables qu'elle ne connaît pas.
 */
function companionService(nom: string, service: CompanionService): YamlMap {
  const rendu: YamlMap = {
    image: service.image,
    env_file: ["./.env"],
    restart: "unless-stopped",
    networks: ["internal"],
  };
  // Nommé d'après le service : deux compagnons qui stockent ne se marchent
  // jamais dessus, et aucun ne peut réclamer `data`, qui est à l'app.
  if (service.data !== null) rendu["volumes"] = [`${nom}-data:${service.data}`];
  return rendu;
}

/**
 * L'app démarre après ses compagnons. Sans `condition` : aucun healthcheck
 * n'étant disponible sur une image toute faite, Docker ne peut garantir que
 * « lancé », pas « prêt ». C'est donc à l'app de réessayer sa connexion — ce
 * qu'elle devrait faire de toute façon, un redémarrage de base la lui
 * imposerait aussi.
 */
function dependre(service: YamlMap, compagnons: string[]): void {
  if (compagnons.length > 0) service["depends_on"] = [...compagnons];
}

/**
 * Branche le conteneur d'app sur le Traefik de la machine — **sans jamais
 * publier de port** : Traefik l'atteint par le réseau Docker partagé, comme le
 * sidecar le fait déjà par le réseau interne. L'invariant du mode privé tient
 * donc aussi pour une cible publique.
 *
 * Le nom de routeur dérive du projet complet (`dbox-<app>-<cible>`), jamais du
 * seul nom d'app : deux apps DBox différentes ne doivent pas pouvoir écraser
 * la route l'une de l'autre.
 */
function publish(
  service: YamlMap,
  ctx: Context,
  project: string,
  publicDomain: string | null,
  port: number,
): void {
  if (publicDomain === null) return;
  const { network, certResolver } = ctx.traefik!;

  service["networks"] = [...(service["networks"] as string[]), network];
  service["labels"] = [
    // Le Traefik de référence tourne en `exposedByDefault: false` : sans ce
    // label, rejoindre son réseau ne suffit pas à être routé. C'est voulu.
    "traefik.enable=true",
    `traefik.http.routers.${project}.rule=Host(\`${publicDomain}\`)`,
    `traefik.http.routers.${project}.entrypoints=websecure`,
    `traefik.http.routers.${project}.tls.certresolver=${certResolver}`,
    `traefik.http.services.${project}.loadbalancer.server.port=${port}`,
    // Obligatoire dès qu'un conteneur est sur plus d'un réseau : sinon Traefik
    // peut tenter de joindre l'app par le réseau interne de DBox, qu'il ne voit
    // pas — panne silencieuse, et pénible à diagnostiquer.
    `traefik.docker.network=${network}`,
  ];
}

function tailscaleService(
  hostname: string,
  target: Target,
  ctx: Context,
  hasApp: boolean,
  backend: Backend,
): YamlMap {
  const environment: YamlMap = {
    TS_HOSTNAME: hostname,
    TS_STATE_DIR: "/var/lib/tailscale",
  };
  const extraArgs: string[] = [];

  if (backend === "headscale") {
    // Pas userspace ici : Caddy (network_mode: service:tailscale, voir
    // caddyService) doit pouvoir se lier à la vraie interface tailscale0 pour
    // obtenir la vraie IP du tailnet — impossible en mode userspace.
    environment["TS_USERSPACE"] = "false";
    // ctx.headscale non-null garanti par backendFor().
    extraArgs.push(`--login-server=${ctx.headscale!.loginServer}`);
  } else {
    // Mode userspace : ni NET_ADMIN, ni /dev/net/tun.
    environment["TS_USERSPACE"] = "true";
    environment["TS_SERVE_CONFIG"] = "/config/serve.json";
  }

  // La cible peut porter son propre tag, pour s'isoler des autres apps de la
  // machine derrière une policy distincte — sinon celui de la machine.
  const tag = target.tsTag ?? ctx.tsTag;
  if (tag !== null) {
    extraArgs.push(`--advertise-tags=${tag}`);
  }
  if (extraArgs.length > 0) {
    environment["TS_EXTRA_ARGS"] = extraArgs.join(" ");
  }

  const volumes = ["ts-state:/var/lib/tailscale"];
  if (backend === "tailscale") {
    volumes.push("./serve.json:/config/serve.json:ro");
  }

  const service: YamlMap = {
    image: ctx.tailscaleImage,
    hostname,
    env_file: ["./ts.env"],
    environment,
    volumes,
    restart: "unless-stopped",
    networks: ["internal"],
  };

  if (backend === "headscale") {
    // Interface réseau réelle (pas userspace) : demande ces deux droits.
    service["cap_add"] = ["NET_ADMIN", "NET_RAW"];
    service["devices"] = ["/dev/net/tun"];
  }
  if (target.mode === "workspace") {
    service["extra_hosts"] = ["host.docker.internal:host-gateway"];
  }
  if (hasApp) {
    service["depends_on"] = ["app"];
  }

  return service;
}

/**
 * Remplace TS_SERVE_CONFIG + ${TS_CERT_DOMAIN} pour le backend headscale :
 * partage le netns de `tailscale` (donc sa vraie IP tailnet) et termine le TLS
 * avec le certificat wildcard de la machine, au lieu de `tailscale cert` —
 * absent de Headscale. `ctx.headscale` est garanti non-null ici, `backendFor()`
 * a déjà refusé sinon.
 */
function caddyService(ctx: Context): YamlMap {
  return {
    image: ctx.caddyImage,
    network_mode: "service:tailscale",
    depends_on: ["tailscale"],
    volumes: ["./Caddyfile:/etc/caddy/Caddyfile:ro", `${ctx.headscale!.certDir}:/certs:ro`],
    restart: "unless-stopped",
    // Pas de `networks:` ici : Compose refuse network_mode et networks
    // ensemble sur le même service.
  };
}
