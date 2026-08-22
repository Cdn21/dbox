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
import { planFor, type Plan, type PlannedFile } from "./plan.ts";
import type { WriteOutcome } from "./writer.ts";

export interface State {
  tag: string;
  previousTag: string | null;
  deployedAt: string;
}

export interface UpDeps {
  compose: Compose;
  probe: Probe;
  writeFiles: (files: PlannedFile[]) => Promise<WriteOutcome[]>;
  seedAuthKey: (outcomes: WriteOutcome[], keyFile: string | undefined) => Promise<string | null>;
  readState: (directory: string) => Promise<State | null>;
  writeState: (directory: string, state: State) => Promise<void>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  log: (line: string) => void;
}

export interface UpOptions {
  manifest: Manifest;
  target: string;
  ctx: Context;
  /** Fichier de clé d'auth, semé dans un `ts.env` nouvellement créé. */
  authkeyFile?: string;
  /** Identifiant de cette version — le SHA git, en général. */
  tag: string;
  healthTimeoutMs?: number;
  healthIntervalMs?: number;
}

export type Failure = "construction" | "démarrage" | "santé";

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

  const outcomes = await deps.writeFiles(plan.files);
  for (const outcome of outcomes) {
    if (!outcome.written) deps.log(`  préservé  ${outcome.path}`);
  }
  const seeded = await deps.seedAuthKey(outcomes, options.authkeyFile);
  if (seeded !== null) deps.log(`  clé posée ${seeded}`);

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

  deps.log(`  vérification de ${plan.healthUrl}…`);
  const health = await waitUntilHealthy(plan.healthUrl, {
    probe: deps.probe,
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
  const restored = planFor(options.manifest, options.target, {
    ...options.ctx,
    imageTag: previous.tag,
  });
  const compose = restored.files.find((file) => file.path.endsWith("docker-compose.yml"));
  if (compose === undefined) return null;

  await deps.writeFiles([compose]);
  const back = await deps.compose(restored.directory, ["up", "-d"]);
  if (back.code !== 0) {
    deps.log("  le retour arrière a échoué lui aussi — intervention manuelle nécessaire");
    return null;
  }
  return previous.tag;
}

function lastLines(output: string, count = 12): string {
  return output.trimEnd().split("\n").slice(-count).join("\n");
}
