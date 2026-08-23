/**
 * Les tâches longues — un redéploiement dure des minutes, une requête HTTP non.
 *
 * Registre en mémoire, volontairement : si le daemon redémarre, les tâches en
 * cours sont perdues, et c'est le bon comportement. La vérité sur ce qui est
 * déployé vit dans `state.json`, pas ici. Ce registre ne sert qu'à suivre une
 * action pendant qu'elle se déroule.
 */

export type JobStatus = "en cours" | "réussi" | "échoué";

export interface Job {
  id: string;
  label: string;
  status: JobStatus;
  lines: string[];
  startedAt: number;
  endedAt: number | null;
}

const MAX_LINES = 500;
const KEEP = 20;

export class Jobs {
  #jobs = new Map<string, Job>();
  #next = 1;
  #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  start(label: string): Job {
    const job: Job = {
      id: String(this.#next++),
      label,
      status: "en cours",
      lines: [],
      startedAt: this.#now(),
      endedAt: null,
    };
    this.#jobs.set(job.id, job);
    this.#prune();
    return job;
  }

  append(job: Job, line: string): void {
    job.lines.push(line);
    // Un `docker build` bavard ne doit pas faire enfler la mémoire sans fin.
    if (job.lines.length > MAX_LINES) job.lines.splice(0, job.lines.length - MAX_LINES);
  }

  finish(job: Job, ok: boolean): void {
    job.status = ok ? "réussi" : "échoué";
    job.endedAt = this.#now();
  }

  get(id: string): Job | null {
    return this.#jobs.get(id) ?? null;
  }

  /** La tâche en cours pour cette cible, s'il y en a une. */
  runningFor(label: string): Job | null {
    for (const job of this.#jobs.values()) {
      if (job.label === label && job.status === "en cours") return job;
    }
    return null;
  }

  list(): Job[] {
    return [...this.#jobs.values()].sort((a, b) => b.startedAt - a.startedAt);
  }

  /** Ne garde que les dernières : on ne consulte jamais l'avant-avant-dernière. */
  #prune(): void {
    const finished = this.list().filter((job) => job.status !== "en cours");
    for (const job of finished.slice(KEEP)) this.#jobs.delete(job.id);
  }
}

export type TrackResult = { started: true; job: Job } | { started: false; running: Job };

/**
 * Démarre une tâche suivie sans attendre qu'elle finisse : le travail tourne
 * en tâche de fond, son avancement s'accumule dans le journal de la tâche.
 * Partagé par tout ce qui dure — redéploiement manuel, ajout d'une app,
 * sondage automatique — pour que deux déclencheurs de la même cible ne se
 * marchent jamais dessus.
 */
export function track(
  jobs: Jobs,
  label: string,
  work: (log: (line: string) => void) => Promise<{ ok: boolean }>,
): TrackResult {
  const running = jobs.runningFor(label);
  if (running !== null) return { started: false, running };

  const job = jobs.start(label);
  void work((line) => jobs.append(job, line))
    .then((result) => jobs.finish(job, result.ok))
    .catch((error: Error) => {
      jobs.append(job, error.message);
      jobs.finish(job, false);
    });
  return { started: true, job };
}
