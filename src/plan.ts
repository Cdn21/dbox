/**
 * Manifeste + contexte → la liste des fichiers à écrire.
 *
 * Transformation pure : rien n'est touché sur le disque, rien n'est appelé.
 * C'est `cli.ts --write` qui décide, plus tard, de matérialiser un plan.
 */

import { backendFor, composeFor, projectName, publicDomainFor, sshUpstreamFor, upstreamFor, type Context } from "./compose.ts";
import { hostnameFor, type Backend, type Manifest, type Mode } from "./manifest.ts";
import { caddyfileFor, serveConfigFor } from "./tsserve.ts";
import { emitYaml } from "./yaml.ts";

export interface PlannedFile {
  path: string;
  content: string;
  /** Permissions POSIX, quand elles importent (secrets en 0600). */
  mode?: number;
  /**
   * Ne pas écraser si le fichier existe déjà : le contenu généré n'est qu'une
   * amorce que l'utilisateur remplit (clé d'auth, variables d'environnement).
   * Sans ça, chaque déploiement effacerait les secrets.
   */
  preserveIfExists?: boolean;
}

/**
 * Carte d'identité d'une cible, écrite à côté des fichiers générés.
 *
 * C'est ce qui rend le dossier auto-descriptif, et donc le système de fichiers
 * utilisable comme registre : pas de base à synchroniser, rien qui puisse
 * mentir sur ce qui est réellement déployé.
 */
export interface Descriptor {
  app: string;
  target: string;
  mode: Mode;
  hostname: string;
  url: string;
  healthUrl: string;
  project: string;
  /** Dossier des sources, pour retrouver le dbox.toml d'origine. */
  source: string;
  /** Le sondeur du daemon ne considère que les cibles marquées ainsi. */
  autoDeploy: boolean;
  /** Noms des services compagnons de cette cible — le registre reste
   * auto-descriptif : `ls` et le tableau de bord peuvent dire ce qui tourne
   * réellement, pas seulement l'app. */
  services: string[];
  /** Domaine public de cette cible, `null` si elle est strictement privée.
   * Écrit ici pour que le registre reste auto-descriptif — et c'est ce que lit
   * `up()` pour refuser deux cibles qui revendiqueraient le même domaine. */
  publicDomain: string | null;
  /** Backend d'exposition effectivement résolu pour cette cible. */
  backend: Backend;
}

export interface Plan {
  app: string;
  target: string;
  mode: Mode;
  /** Y a-t-il une image à construire avant de démarrer ? */
  builds: boolean;
  project: string;
  hostname: string;
  url: string;
  /** L'URL réellement interrogée pour décider qu'un déploiement a réussi. */
  healthUrl: string;
  upstream: string;
  directory: string;
  files: PlannedFile[];
  /** Domaine public résolu — `null` : cible strictement privée. */
  publicDomain: string | null;
  /** Backend d'exposition résolu — quelle clé d'auth semer, entre autres. */
  backend: Backend;
  /** Noms des services compagnons — `up` s'en sert pour signaler celui qui ne
   * démarre pas, que le contrôle de santé de l'app ne verrait jamais. */
  services: string[];
}

const GENERATED_BY = "Généré par DBox — ne pas éditer à la main.";

export function planFor(manifest: Manifest, targetName: string, ctx: Context): Plan {
  const target = manifest.targets[targetName];
  if (target === undefined) {
    throw new Error(`cible « ${targetName} » inconnue — connues : ${Object.keys(manifest.targets).join(", ")}`);
  }

  const backend = backendFor(target, ctx, targetName);
  const publicDomain = publicDomainFor(target, ctx, targetName);
  const hostname = hostnameFor(manifest.name, targetName);
  const directory = `${ctx.root}/${manifest.name}/${targetName}`;
  const upstream = upstreamFor(target);
  const sshUpstream = sshUpstreamFor(target);
  const url = `https://${hostname}.${ctx.tailnet}`;

  const descriptor: Descriptor = {
    app: manifest.name,
    target: targetName,
    mode: target.mode,
    hostname,
    url,
    healthUrl: `${url}${target.health}`,
    project: projectName(manifest.name, targetName),
    source: ctx.sourcePath,
    autoDeploy: target.mode !== "workspace" && target.autoDeploy,
    services: target.mode === "workspace" ? [] : Object.keys(target.services),
    publicDomain,
    backend,
  };

  const files: PlannedFile[] = [
    {
      path: `${directory}/dbox.json`,
      content: JSON.stringify(descriptor, null, 2) + "\n",
    },
    {
      path: `${directory}/docker-compose.yml`,
      content: emitYaml(composeFor(manifest, targetName, ctx), [
        GENERATED_BY,
        `${manifest.name} · cible ${targetName} · ${url}`,
      ]),
    },
    backend === "tailscale"
      ? {
          path: `${directory}/serve.json`,
          content: JSON.stringify(serveConfigFor(upstream, sshUpstream), null, 2) + "\n",
        }
      : {
          path: `${directory}/Caddyfile`,
          content: caddyfileFor(hostname, ctx.tailnet, upstream),
        },
    {
      path: `${directory}/ts.env`,
      mode: 0o600,
      preserveIfExists: true,
      content: [
        "# Clé d'authentification Tailscale, réutilisable et taguée.",
        "# À renseigner avant le premier démarrage ; ensuite l'état vit dans le",
        "# volume ts-state et la clé n'est plus relue.",
        "TS_AUTHKEY=",
        "",
      ].join("\n"),
    },
  ];

  // Le mode workspace n'a pas de conteneur d'app, donc pas de fichier d'env.
  if (target.mode !== "workspace") {
    files.push({
      path: `${directory}/.env`,
      mode: 0o600,
      preserveIfExists: true,
      content: `# Variables d'environnement de ${manifest.name} · cible ${targetName}.\n`,
    });
  }

  return {
    app: descriptor.app,
    target: descriptor.target,
    mode: descriptor.mode,
    builds: target.mode === "deployed" || (target.mode === "devcontainer" && target.dockerfile !== null),
    project: descriptor.project,
    hostname: descriptor.hostname,
    url: descriptor.url,
    healthUrl: descriptor.healthUrl,
    upstream,
    directory,
    files,
    publicDomain,
    services: descriptor.services,
    backend,
  };
}

export function planAll(manifest: Manifest, ctx: Context): Plan[] {
  return Object.keys(manifest.targets).map((target) => planFor(manifest, target, ctx));
}
