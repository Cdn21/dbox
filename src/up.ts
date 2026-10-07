/**
 * `dbox up` : écrire, construire, démarrer, vérifier — et revenir en arrière si
 * la vérification échoue.
 *
 * Toutes les dépendances qui touchent le monde extérieur sont injectées : la
 * séquence entière se teste sans Docker, sans réseau et sans disque.
 *
 * Deux propriétés voulues :
 *  - un échec de **construction** ne change rien : l'ancienne version tourne
 *    toujours, on n'a même pas appelé `up` ;
 *  - un échec de **santé** ramène l'image précédente, quand il y en a une.
 */

import type { Context } from "./compose.ts";
import type { Compose } from "./docker.ts";
import { waitUntilHealthy, type Probe, type WaitResult } from "./health.ts";
import type { Manifest } from "./manifest.ts";
import { planFor, type Descriptor, type Plan, type PlannedFile } from "./plan.ts";
import { CHEMINS_SONDES, preflight } from "./preflight.ts";
import type { WriteOutcome } from "./writer.ts";

export interface State {
  tag: string;
  previousTag: string | null;
  deployedAt: string;
}

export interface UpDeps {
  compose: Compose;
  probe: Probe;
  /** La sonde d'une cible Headscale, bâtie à partir du nom de projet : le DNS
   * public ne résout pas `<nom>.<tailnet>` vers l'overlay, il faut épingler
   * l'IP du nœud (voir `headscaleProbe` dans docker.ts). Absente = on retombe
   * sur `probe` (DNS public), qui échouera et déclenchera un retour arrière. */
  headscaleProbe?: (project: string) => Probe;
  writeFiles: (files: PlannedFile[]) => Promise<WriteOutcome[]>;
  seedAuthKey: (outcomes: WriteOutcome[], keyFile: string | undefined) => Promise<string | null>;
  readState: (directory: string) => Promise<State | null>;
  writeState: (directory: string, state: State) => Promise<void>;
  /** Les cibles déjà déployées sur cette machine — sert **uniquement** à
   * refuser un `public_domain` en double, jamais à autre chose. Injectée comme
   * le reste : la vérification a besoin du disque, `planFor` doit rester pur. */
  listDescriptors: () => Promise<Descriptor[]>;
  /** Lit un fichier du projet pour le contrôle d'avant-construction. `null`
   * si absent — jamais une exception : l'absence est l'information utile, et
   * la plupart des chemins sondés n'existent pas. */
  readSource: (path: string) => Promise<string | null>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  log: (line: string) => void;
}

export interface UpOptions {
  manifest: Manifest;
  target: string;
  ctx: Context;
  /** Fichier de clé d'auth Tailscale, semé dans un `ts.env` nouvellement créé
   * quand la cible résout au backend "tailscale". */
  authkeyFile?: string;
  /** Même rôle, pour le backend "headscale" : une clé préauth Headscale n'a
   * rien à voir avec une clé Tailscale — jamais le même fichier, jamais
   * interchangeables. */
  headscaleAuthkeyFile?: string;
  /** Identifiant de cette version — le SHA git, en général. */
  tag: string;
  healthTimeoutMs?: number;
  healthIntervalMs?: number;
}

export type Failure = "construction" | "démarrage" | "santé" | "domaine";

export interface UpResult {
  ok: boolean;
  plan: Plan;
  tag: string;
  failure: Failure | null;
  detail: string | null;
  health: WaitResult | null;
  rolledBackTo: string | null;
}

const DEFAULT_TIMEOUT_MS = 180_000;
const DEFAULT_INTERVAL_MS = 3_000;

export async function up(options: UpOptions, deps: UpDeps): Promise<UpResult> {
  const { manifest, target, tag } = options;
  const ctx = { ...options.ctx, imageTag: tag };
  const plan = planFor(manifest, target, ctx);
  const previous = await deps.readState(plan.directory);

  const result: UpResult = {
    ok: false,
    plan,
    tag,
    failure: null,
    detail: null,
    health: null,
    rolledBackTo: null,
  };

  deps.log(`${manifest.name} · ${target} · ${tag}`);

  // Avant toute écriture : deux cibles au même domaine et Traefik en router une
  // au hasard, en silence. Le refus doit donc arriver ici, pas après coup.
  // L'exclusion de la cible elle-même laisse passer un redéploiement.
  if (plan.publicDomain !== null) {
    const conflict = (await deps.listDescriptors()).find(
      (d) => d.publicDomain === plan.publicDomain && (d.app !== manifest.name || d.target !== target),
    );
    if (conflict !== undefined) {
      result.failure = "domaine";
      result.detail =
        `« ${plan.publicDomain} » est déjà utilisé par ${conflict.app} · ${conflict.target} — ` +
        `Traefik ne peut router un domaine que vers une seule cible`;
      deps.log(`  refusé : ${result.detail}`);
      return result;
    }
  }

  // Ce qui va casser, dit avant de construire — jamais un refus : ces contrôles
  // sont des heuristiques (voir `preflight.ts`). Placé ici pour que le message
  // arrive avant les deux minutes de construction, pas après.
  const cible = manifest.targets[target];
  if (cible !== undefined) {
    const lus = await Promise.all(
      CHEMINS_SONDES.map(async (chemin) => [chemin, await deps.readSource(`${ctx.sourcePath}/${chemin}`)] as const),
    );
    const fichiers = new Map(lus.filter((paire): paire is [string, string] => paire[1] !== null));
    for (const avis of preflight(plan, cible, fichiers)) deps.log(`  ⚠ ${avis.message}`);
  }

  const outcomes = await deps.writeFiles(plan.files);
  for (const outcome of outcomes) {
    if (!outcome.written) deps.log(`  préservé  ${outcome.path}`);
  }
  const keyFile = plan.backend === "headscale" ? options.headscaleAuthkeyFile : options.authkeyFile;
  const seeded = await deps.seedAuthKey(outcomes, keyFile);
  if (seeded !== null) deps.log(`  clé posée ${seeded}`);

  // Un compagnon lit ses réglages dans le même `.env` que l'app, et ce fichier
  // vient d'être créé vide : `postgres` sans POSTGRES_PASSWORD redémarre en
  // boucle pendant que l'app répond 200 et que le déploiement se dit réussi.
  // Vécu au premier déploiement réel. Dit ici plutôt que constaté après coup —
  // et pas par un `docker compose ps` juste après le démarrage, essayé puis
  // écarté : à cet instant le conteneur affiche encore « running », il ne
  // plante qu'une seconde plus tard.
  const envNeuf = outcomes.some((outcome) => outcome.written && outcome.path.endsWith("/.env"));
  if (envNeuf && plan.services.length > 0) {
    deps.log(
      `  ⚠ ${plan.services.join(", ")} : leurs variables se posent dans ${plan.directory}/.env, ` +
        `qui vient d'être créé vide — une image comme postgres refuse de démarrer sans les siennes`,
    );
  }

  if (plan.builds) {
    deps.log("  construction…");
    const built = await deps.compose(plan.directory, ["build"]);
    if (built.code !== 0) {
      // Rien n'a été démarré : la version en place continue de tourner.
      result.failure = "construction";
      result.detail = lastLines(built.stderr || built.stdout);
      return result;
    }
  }

  deps.log("  démarrage…");
  const started = await deps.compose(plan.directory, ["up", "-d", "--remove-orphans"]);
  if (started.code !== 0) {
    result.failure = "démarrage";
    result.detail = lastLines(started.stderr || started.stdout);
    result.rolledBackTo = await rollback(options, deps, previous, plan);
    return result;
  }

  // Une cible Headscale ne se sonde pas par le DNS public (il pointe vers une
  // IP publique, pas vers l'overlay) : on épingle l'IP du nœud. Sans la sonde
  // dédiée, on retombe sur le DNS public — qui échouera, et ramènera la version
  // précédente plutôt que de laisser passer un déploiement non vérifié.
  const probe =
    plan.backend === "headscale" && deps.headscaleProbe !== undefined
      ? deps.headscaleProbe(plan.project)
      : deps.probe;
  if (plan.backend === "headscale") {
    deps.log(`  vérification de ${plan.healthUrl} (via l'IP overlay Headscale du nœud)…`);
  } else {
    deps.log(`  vérification de ${plan.healthUrl}…`);
  }
  const health = await waitUntilHealthy(plan.healthUrl, {
    probe,
    timeoutMs: options.healthTimeoutMs ?? DEFAULT_TIMEOUT_MS,
    intervalMs: options.healthIntervalMs ?? DEFAULT_INTERVAL_MS,
    sleep: deps.sleep,
    now: deps.now,
  });
  result.health = health;

  if (!health.ok) {
    result.failure = "santé";
    result.detail =
      health.status === null
        ? `aucune réponse après ${Math.round(health.elapsedMs / 1000)} s`
        : `dernier statut ${health.status} après ${Math.round(health.elapsedMs / 1000)} s`;

    // Une absence totale de réponse sur une cible qui vient de se voir poser
    // un tag distinct sent le sidecar qui n'a jamais réussi à s'enregistrer —
    // le cas le plus probable étant un tag absent de `tagOwners`. DBox ne
    // peut pas le vérifier (il ne lit jamais la policy du tailnet), mais peut
    // au moins pointer vers la bonne piste plutôt qu'un timeout muet.
    const targetDef = manifest.targets[target];
    if (health.status === null && targetDef?.tsTag != null) {
      const hint =
        `aucune réponse et « ${targetDef.tsTag} » est posé sur cette cible — vérifie qu'il existe ` +
        `dans tagOwners de la policy du tailnet, et qu'un grants autorise tag:dbox-admin à le joindre ` +
        `(sans ça, le sidecar ne s'enregistre jamais et la santé ne peut pas passer)`;
      result.detail = `${result.detail} — ${hint}`;
      deps.log(`  ${hint}`);
    }

    result.rolledBackTo = await rollback(options, deps, previous, plan);
    return result;
  }

  await deps.writeState(plan.directory, {
    tag,
    previousTag: previous?.tag ?? null,
    deployedAt: new Date(deps.now()).toISOString(),
  });

  result.ok = true;
  deps.log(`  en ligne · ${plan.url}`);
  return result;
}

/**
 * Ne concerne que le mode `deployed` : c'est le seul où « la version d'avant »
 * existe sous forme d'image taguée. Ailleurs, la pile est laissée en l'état
 * plutôt que coupée — arrêter un environnement de développement qui tournait
 * serait pire que le déploiement raté.
 */
async function rollback(
  options: UpOptions,
  deps: UpDeps,
  previous: State | null,
  plan: Plan,
): Promise<string | null> {
  if (plan.mode !== "deployed") return null;

  if (previous === null) {
    // Laissée en marche exprès : sans version précédente il n'y a rien à
    // restaurer, et couper priverait des journaux qui expliquent l'échec.
    deps.log("  aucune version précédente : la pile est laissée en marche, à inspecter");
    return null;
  }

  deps.log(`  retour à ${previous.tag}…`);

  // Un compagnon qui stocke rend cette promesse partielle, et mieux vaut le
  // dire que de laisser croire à un retour complet : revenir à l'image d'avant
  // ne défait pas une migration déjà appliquée à la base.
  const cible = options.manifest.targets[options.target];
  const avecEtat =
    cible !== undefined &&
    cible.mode !== "workspace" &&
    Object.values(cible.services).some((service) => service.data !== null);
  if (avecEtat) {
    deps.log("  ⚠ le retour arrière ramène l'image, jamais les données d'un service compagnon");
  }
  const restored = planFor(options.manifest, options.target, {
    ...options.ctx,
    imageTag: previous.tag,
  });
  const compose = restored.files.find((file) => file.path.endsWith("docker-compose.yml"));
  if (compose === undefined) return null;

  await deps.writeFiles([compose]);
  // `--no-build` : si l'image précédente a disparu (un `prune`), Compose la
  // reconstruirait depuis les sources ACTUELLES — celles qui viennent d'échouer
  // — et la taguerait comme l'ancienne. Mieux vaut un échec franc.
  const back = await deps.compose(restored.directory, ["up", "-d", "--no-build"]);
  if (back.code !== 0) {
    deps.log(`  le retour arrière a échoué lui aussi (l'image ${previous.tag} existe-t-elle encore ?) — intervention manuelle nécessaire`);
    return null;
  }
  return previous.tag;
}

function lastLines(output: string, count = 12): string {
  return output.trimEnd().split("\n").slice(-count).join("\n");
}
