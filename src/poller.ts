/**
 * Sondage périodique des cibles marquées `auto_deploy`.
 *
 * Jamais de webhook : ça demanderait un point d'entrée joignable depuis
 * internet, la première brèche dans l'invariant central de DBox — aucun port
 * ouvert, invisible d'internet. Un `git fetch` périodique reste entièrement
 * privé, au prix d'un délai de quelques minutes plutôt que l'instantané.
 */

import type { Jobs } from "./jobs.ts";
import { track } from "./jobs.ts";
import type { Entry } from "./registry.ts";
import type { UpResult } from "./up.ts";
import type { UpstreamCheck } from "./sources.ts";

export interface PollDeps {
  scan: () => Promise<Entry[]>;
  // Prend l'entrée entière, pas seulement la source : résoudre la clé à
  // utiliser (dédiée à l'app, ou celle de la machine) a besoin de son nom.
  checkUpstream: (entry: Entry) => Promise<UpstreamCheck>;
  redeploy: (entry: Entry, log: (line: string) => void) => Promise<UpResult>;
  jobs: Jobs;
  log: (line: string) => void;
}

export async function pollOnce(deps: PollDeps): Promise<void> {
  const entries = await deps.scan();

  for (const entry of entries) {
    if (!entry.descriptor.autoDeploy) continue;

    const label = `${entry.descriptor.app}/${entry.descriptor.target}`;
    // Un redéploiement (manuel ou déjà lancé par un cycle précédent) est en
    // cours : ne pas faire courir un `git fetch` en même temps que son `pull`.
    if (deps.jobs.runningFor(label) !== null) continue;

    const check = await deps.checkUpstream(entry);
    if (!check.ok) {
      deps.log(`sondage ${label} : ${check.detail}`);
      continue;
    }
    if (!check.changed) continue;

    deps.log(`sondage ${label} : nouveau commit en amont`);
    const result = track(deps.jobs, label, (log) => deps.redeploy(entry, log));
    if (result.started) deps.log(`sondage ${label} : redéploiement lancé (tâche ${result.job.id})`);
  }
}

/** Démarre le sondage ; l'arrêter rend le daemon testable sans laisser de minuteur actif. */
export function startPolling(intervalMs: number, deps: PollDeps): () => void {
  const timer = setInterval(() => {
    pollOnce(deps).catch((error: Error) => deps.log(`sondage : ${error.message}`));
  }, intervalMs);
  return () => clearInterval(timer);
}
