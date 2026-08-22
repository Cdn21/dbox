/**
 * Vérifie que le tag qui sème les nouvelles apps (`--ts-tag`) existe bien
 * dans `tagOwners` de la policy Tailscale — lecture seule. Sans lui,
 * `dbox add`/`dbox up` échouent à l'inscription du nouveau nœud, avec un
 * message dont la cause n'est pas évidente (voir le diagnostic déjà posé
 * dans `up.ts`, réactif : celui-ci prévient avant, pas après coup).
 *
 * DBox ne réécrit jamais l'ACL lui-même — voir la discussion dans
 * `tailscale.ts`. Cette vérification se contente de lire, et de composer
 * une ligne prête à coller, calquée sur un tag déjà présent dans la
 * policy (le plus souvent `tag:dbox-admin`, qui existe forcément si le
 * daemon tourne).
 */

export const TEMPLATE_TAG = "tag:dbox-admin";

export interface TagCheckDeps {
  tailnet: string;
  tag: string | null;
  reportFile: string;
  readToken: () => Promise<string>;
  writeFile: (path: string, content: string, mode: number) => Promise<void>;
  listTagOwners: (tailnet: string, token: string) => Promise<Record<string, string[]>>;
  now: () => number;
  log: (line: string) => void;
}

function suggestLine(tag: string, owners: Record<string, string[]>): string {
  const template = owners[TEMPLATE_TAG] ?? Object.values(owners)[0] ?? ["autogroup:admin"];
  return `${JSON.stringify(tag)}: ${JSON.stringify(template)},`;
}

export async function checkTagOnce(deps: TagCheckDeps): Promise<void> {
  if (deps.tag === null) {
    deps.log("tag : aucun tag configuré — rien à vérifier");
    return;
  }

  const token = (await deps.readToken()).trim();
  if (token === "") {
    deps.log("tag : token d'accès API Tailscale absent ou vide — vérification impossible");
    return;
  }

  const owners = await deps.listTagOwners(deps.tailnet, token);
  const present = deps.tag in owners;

  await deps.writeFile(
    deps.reportFile,
    JSON.stringify(
      {
        checkedAt: new Date(deps.now()).toISOString(),
        tag: deps.tag,
        present,
        suggestedLine: present ? null : suggestLine(deps.tag, owners),
      },
      null,
      2,
    ) + "\n",
    0o644,
  );

  deps.log(
    present
      ? `tag : ${deps.tag} déjà déclaré dans tagOwners`
      : `tag : ${deps.tag} absent de tagOwners — dbox add échouera pour une nouvelle app tant qu'il n'est pas ajouté`,
  );
}

/** Même contrat que `startRotating`/`startCheckingOrphans` : l'arrêter rend
 * le process testable sans laisser de minuteur actif. */
export function startCheckingTag(intervalMs: number, deps: TagCheckDeps): () => void {
  const timer = setInterval(() => {
    checkTagOnce(deps).catch((error: Error) => deps.log(`tag : ${error.message}`));
  }, intervalMs);
  return () => clearInterval(timer);
}
