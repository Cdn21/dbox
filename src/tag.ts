/**
 * Le tag d'image identifie ce qui a été déployé. Le SHA git quand il existe,
 * un horodatage sinon — pour qu'un dossier sans dépôt reste déployable.
 *
 * Un arbre modifié est marqué `-sale` : deux déploiements depuis le même commit
 * mais des sources différentes ne doivent pas porter le même nom.
 */

import { run } from "./docker.ts";

export async function sourceTag(directory: string, now: () => number = Date.now): Promise<string> {
  const head = await run("git", ["-C", directory, "rev-parse", "--short=12", "HEAD"]).catch(() => null);
  if (head === null || head.code !== 0) {
    return `t${new Date(now()).toISOString().replace(/[-:T]/g, "").slice(0, 14)}`;
  }

  const sha = head.stdout.trim();
  const status = await run("git", ["-C", directory, "status", "--porcelain"]).catch(() => null);
  const dirty = status !== null && status.code === 0 && status.stdout.trim() !== "";
  return dirty ? `${sha}-sale` : sha;
}
