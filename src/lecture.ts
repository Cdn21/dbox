/**
 * Lire un fichier d'un projet qu'on ne contrôle pas — prudemment.
 *
 * Le contrôle d'avant-construction (`preflight.ts`) lit quelques fichiers du
 * dossier source avant chaque déploiement. Un `readFile` nu y avait deux
 * défauts : un tube nommé (FIFO) appelé `vite.config.ts` bloquait la lecture
 * pour toujours — et avec elle le déploiement, resté « en cours », qui empêchait
 * aussi les suivants ; et rien ne bornait la taille lue.
 *
 * On ne lit donc qu'un **fichier ordinaire** (un lien symbolique vers un fichier
 * ordinaire compte : une config peut légitimement en être un), et pas au-delà de
 * `TAILLE_MAX`. Tout le reste vaut « absent » : le contrôle se tait plutôt que
 * de bloquer, ce qui est sa règle de toute façon.
 *
 * Le fichier est ouvert UNE fois, en non bloquant, et tout se décide sur ce
 * descripteur. Un `stat` puis un `readFile` séparés laissaient une fenêtre : un
 * tube nommé substitué entre les deux bloquait de nouveau (relevé à la revue du
 * 4 octobre 2026). Ouvrir un tube en lecture non bloquante rend la main tout de
 * suite, et le `stat` du descripteur dit alors ce qu'on a vraiment ouvert. La
 * taille n'est pas crue non plus : un fichier de /proc annonce 0 octet, et
 * c'est la lecture elle-même qui s'arrête à `TAILLE_MAX`.
 */

import { constants } from "node:fs";
import { open } from "node:fs/promises";

/** Une config Vite ou un `build.gradle` réels tiennent en quelques kilo-octets. */
export const TAILLE_MAX = 1024 * 1024;

export async function lireSiFichierOrdinaire(chemin: string): Promise<string | null> {
  let fichier;
  try {
    fichier = await open(chemin, constants.O_RDONLY | constants.O_NONBLOCK);
  } catch {
    return null;
  }
  try {
    if (!(await fichier.stat()).isFile()) return null;
    // Un octet de plus que la limite : s'il est lu, le fichier la dépasse.
    const tampon = Buffer.alloc(TAILLE_MAX + 1);
    let lus = 0;
    while (lus < tampon.length) {
      const { bytesRead } = await fichier.read(tampon, lus, tampon.length - lus, lus);
      if (bytesRead === 0) break;
      lus += bytesRead;
    }
    return lus > TAILLE_MAX ? null : tampon.subarray(0, lus).toString("utf8");
  } catch {
    return null;
  } finally {
    await fichier.close();
  }
}
