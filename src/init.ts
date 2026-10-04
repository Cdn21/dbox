/**
 * `dbox init` — écrire le manifeste à la place de l'utilisateur.
 *
 * Ce qui peut être déduit l'est : le nom vient du dossier, le port du `EXPOSE`
 * du Dockerfile. Ce qui ne peut pas l'être n'est pas deviné — DBox n'écrit pas
 * ton Dockerfile, c'est le seul fichier qui décrit vraiment ton app.
 */

export interface Draft {
  name: string;
  port: number;
  data: string | null;
}

/** Un nom de dossier n'est pas un nom de machine : on le rabote au format DNS. */
export function nameFromDirectory(path: string): string {
  const base = path.replace(/\/+$/, "").split("/").pop() ?? "app";
  const slug = base
    .toLowerCase()
    .replace(/[_\s.]+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63)
    .replace(/-+$/, "");
  return slug === "" ? "app" : slug;
}

/**
 * Lit le Dockerfile pour ce qu'il déclare déjà. `EXPOSE` donne le port, `VOLUME`
 * signale un stockage à rendre persistant — autant le proposer plutôt que de
 * laisser l'utilisateur découvrir sa base effacée au deuxième déploiement.
 */
export function readDockerfile(source: string): { port: number | null; data: string | null } {
  let port: number | null = null;
  let data: string | null = null;

  for (const raw of source.split(/\r?\n/)) {
    const line = raw.trim();

    const exposed = /^EXPOSE\s+(\d{1,5})/i.exec(line);
    if (exposed !== null && port === null) {
      const value = Number(exposed[1]);
      if (value >= 1 && value <= 65535) port = value;
    }

    const volume = /^VOLUME\s+(.+)$/i.exec(line);
    if (volume !== null && data === null) {
      const first = volume[1]!
        .replace(/^\[|\]$/g, "")
        .split(",")[0]!
        .trim()
        .replace(/^["']|["']$/g, "");
      if (first.startsWith("/")) data = first;
    }
  }

  return { port, data };
}

const DEFAULT_PORT = 8080;

export function draft(directory: string, dockerfile: string | null): Draft {
  const read = dockerfile === null ? { port: null, data: null } : readDockerfile(dockerfile);
  return {
    name: nameFromDirectory(directory),
    port: read.port ?? DEFAULT_PORT,
    data: read.data,
  };
}

export type NewTargetMode = "deployed" | "workspace" | "devcontainer";

/**
 * « prod » pour ce qui se déploie, « dev » pour ce qui se code en direct —
 * la même convention que partout ailleurs : la cible `prod` porte le nom nu.
 */
export function targetNameFor(mode: NewTargetMode): string {
  return mode === "deployed" ? "prod" : "dev";
}

export interface ScaffoldInput {
  name: string;
  mode: NewTargetMode;
  port: number;
  /** Obligatoire en `workspace`/`devcontainer` — jamais deviné, il n'y a rien
   * à lire pour ça avant que l'app existe. */
  command?: string;
  /** `devcontainer` seulement : l'image de l'environnement, quand celle par
   * défaut (Node) ne convient pas — un projet Python, Go, PHP… Absente : le
   * défaut du manifeste s'applique. */
  image?: string;
  /** `devcontainer` seulement : construire l'image du projet au lieu d'en
   * prendre une toute faite — le cas dès qu'il mêle deux runtimes. **Prime sur
   * `image`** quand les deux sont donnés (voir `appService` dans compose.ts). */
  dockerfile?: string;
}

/**
 * Le squelette du formulaire d'ajout, quand le mode n'est pas `deployed` —
 * celui-là seul peut être deviné depuis un Dockerfile après le clonage.
 */
export function renderScaffold(input: ScaffoldInput): string {
  const target = targetNameFor(input.mode);
  const lines = [`name = "${input.name}"`, "", `[targets.${target}]`, `mode = "${input.mode}"`];

  const echappe = (valeur: string) => valeur.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

  if (input.mode !== "deployed") {
    lines.push(`command = "${echappe(input.command ?? "")}"`);
  }
  lines.push(`port = ${input.port}`);
  // Réservés au devcontainer : le mode `workspace` ne conteneurise rien, et le
  // mode `deployed` construit toujours depuis le Dockerfile du projet.
  if (input.mode === "devcontainer") {
    if (input.image !== undefined && input.image !== "") lines.push(`image = "${echappe(input.image)}"`);
    if (input.dockerfile !== undefined && input.dockerfile !== "") {
      lines.push(`dockerfile = "${echappe(input.dockerfile)}"`);
    }
  }
  lines.push(
    "",
    '# health = "/api/session"   # chemin interrogé après déploiement (défaut « / »)',
    '# ts_tag = "tag:mon-app"    # isole cette cible derrière son propre tag (doit déjà exister dans tagOwners)',
  );

  return `${lines.join("\n")}\n`;
}

export function renderManifest(draft: Draft, guessedPort: boolean): string {
  const lines = [
    `name = "${draft.name}"`,
    "",
    "[targets.prod]",
    'mode = "deployed"',
    guessedPort
      ? `port = ${draft.port}   # deviné : aucun EXPOSE dans le Dockerfile, à vérifier`
      : `port = ${draft.port}`,
  ];

  if (draft.data !== null) {
    lines.push(`data = "${draft.data}"   # volume nommé : survit aux déploiements`);
  }
  lines.push(
    "",
    '# health = "/api/session"   # chemin interrogé après déploiement (défaut « / »)',
    '# ts_tag = "tag:mon-app"    # isole cette cible derrière son propre tag (doit déjà exister dans tagOwners)',
  );

  return lines.join("\n") + "\n";
}
