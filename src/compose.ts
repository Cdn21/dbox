/**
 * Une cible → un objet Compose.
 *
 * Invariant de sécurité du mode privé : **aucune clé `ports:` n'est jamais
 * émise**. L'app n'est joignable que par le sidecar Tailscale, à travers le
 * réseau du projet. Un test garde cet invariant.
 */

import { hostnameFor, type Manifest, type Target } from "./manifest.ts";
import type { YamlMap } from "./yaml.ts";

export interface Context {
  /** Où vivent les fichiers générés sur la machine cible. */
  root: string;
  /** Domaine du tailnet, pour l'URL affichée (« tail4bb652.ts.net »). */
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
}

export const DEFAULT_CONTEXT: Omit<Context, "sourcePath" | "tailnet" | "uid" | "gid"> = {
  root: "/opt/dbox/apps",
  tsTag: "tag:dbox",
  imageTag: "dev",
  tailscaleImage: "tailscale/tailscale:stable",
};

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

export function composeFor(manifest: Manifest, targetName: string, ctx: Context): YamlMap {
  const target = manifest.targets[targetName];
  if (target === undefined) throw new Error(`cible « ${targetName} » inconnue`);

  const project = projectName(manifest.name, targetName);
  const hostname = hostnameFor(manifest.name, targetName);
  const network = `${project}_internal`;
  const user = `${ctx.uid}:${ctx.gid}`;

  const services: YamlMap = {};
  const app = appService(manifest.name, target, ctx, user);
  if (app !== undefined) services["app"] = app;
  services["tailscale"] = tailscaleService(hostname, target, ctx, app !== undefined);

  const volumes: YamlMap = { "ts-state": {} };
  // Volume **nommé** et non anonyme : un volume anonyme disparaît au premier
  // `down -v` ou `--renew-anon-volumes`, ce qui emporterait la base de l'app.
  if (target.mode !== "workspace" && target.data !== null) volumes["data"] = {};

  return {
    name: project,
    services,
    networks: { internal: { name: network } },
    volumes,
  };
}

function appService(
  app: string,
  target: Target,
  ctx: Context,
  user: string,
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
      env_file: ["./.env"],
      restart: "unless-stopped",
      networks: ["internal"],
    };
    if (target.data !== null) service["volumes"] = [`data:${target.data}`];
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
  }
  return service;
}

function tailscaleService(
  hostname: string,
  target: Target,
  ctx: Context,
  hasApp: boolean,
): YamlMap {
  const environment: YamlMap = {
    TS_HOSTNAME: hostname,
    TS_STATE_DIR: "/var/lib/tailscale",
    // Mode userspace : ni NET_ADMIN, ni /dev/net/tun.
    TS_USERSPACE: "true",
    TS_SERVE_CONFIG: "/config/serve.json",
  };
  // La cible peut porter son propre tag, pour s'isoler des autres apps de la
  // machine derrière une policy distincte — sinon celui de la machine.
  const tag = target.tsTag ?? ctx.tsTag;
  if (tag !== null) {
    environment["TS_EXTRA_ARGS"] = `--advertise-tags=${tag}`;
  }

  const service: YamlMap = {
    image: ctx.tailscaleImage,
    hostname,
    env_file: ["./ts.env"],
    environment,
    volumes: ["ts-state:/var/lib/tailscale", "./serve.json:/config/serve.json:ro"],
    restart: "unless-stopped",
    networks: ["internal"],
  };

  if (target.mode === "workspace") {
    service["extra_hosts"] = ["host.docker.internal:host-gateway"];
  }
  if (hasApp) {
    service["depends_on"] = ["app"];
  }

  return service;
}
