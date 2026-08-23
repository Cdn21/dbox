/**
 * La clé SSH dédiée aux clonages de DBox — jamais celle de la personne qui
 * l'installe.
 *
 * Le daemon a déjà un accès complet à Docker sur la machine ; lui donner en
 * plus la clé SSH personnelle de l'utilisateur — valable pour *tous* ses
 * dépôts — élargirait inutilement ce qu'un daemon compromis pourrait
 * atteindre. Une paire dédiée, à autoriser dépôt par dépôt (deploy key),
 * reste sous contrôle : révocable sans toucher à l'identité de la personne.
 */

import { dirname } from "node:path";

export interface KeyPaths {
  private: string;
  public: string;
}

/** La publique est toujours le fichier `.pub` à côté de la privée. */
export function keyPaths(privateKeyFile: string): KeyPaths {
  return { private: privateKeyFile, public: `${privateKeyFile}.pub` };
}

/** Ajouté à `GIT_SSH_COMMAND` : force cette clé, ignore les autres, accepte
 * l'empreinte d'un hôte inconnu au premier contact — un daemon non interactif
 * ne peut pas répondre à une invite « yes/no ». */
export function gitSshCommand(privateKeyFile: string): string {
  return `ssh -i '${privateKeyFile}' -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new`;
}

export interface KeyIo {
  readFile: (path: string) => Promise<string>;
  mkdir: (path: string) => Promise<void>;
  chmod: (path: string, mode: number) => Promise<void>;
  run: (file: string, args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;
}

export async function readPublicKey(paths: KeyPaths, io: Pick<KeyIo, "readFile">): Promise<string | null> {
  return await io.readFile(paths.public).then((s) => s.trim()).catch(() => null);
}

/**
 * La clé dédiée d'une app, à côté de celle de la machine — jamais dans le
 * dépôt cloné lui-même : un `git clean` ou un re-clonage ne doit pas pouvoir
 * l'emporter avec les sources.
 */
export function appKeyFile(machineKeyFile: string, appName: string): string {
  return `${dirname(machineKeyFile)}/app-keys/${appName}`;
}

/**
 * La clé à utiliser pour cloner ou tirer une app donnée : la sienne si elle
 * en a une, sinon celle de la machine. Cherchée avant chaque opération plutôt
 * que mémorisée — d'ordinaire une clé par app se génère après coup, depuis sa
 * carte, une fois l'app déjà ajoutée avec la clé machine. Mais rien n'empêche
 * de la générer avant même le premier ajout (`appKeyFile` ne dépend que du
 * nom, jamais du registre) — utile quand la clé machine est déjà deploy key
 * ailleurs et ne peut pas encore servir à ce nouveau dépôt.
 */
export async function resolveKeyFile(
  machineKeyFile: string | undefined,
  appName: string,
  io: Pick<KeyIo, "readFile">,
): Promise<string | undefined> {
  if (machineKeyFile === undefined) return undefined;
  const dedicated = appKeyFile(machineKeyFile, appName);
  const publicKey = await readPublicKey(keyPaths(dedicated), io);
  return publicKey !== null ? dedicated : machineKeyFile;
}

/**
 * N'écrase jamais une clé existante — même règle que `ts.env` et `.env` :
 * une clé déjà collée dans GitHub ou GitLab ne doit jamais devenir invalide
 * en silence parce qu'on a cliqué le bouton une seconde fois.
 */
export async function ensureKey(
  paths: KeyPaths,
  io: KeyIo,
): Promise<{ created: boolean; publicKey: string }> {
  const existing = await readPublicKey(paths, io);
  if (existing !== null) return { created: false, publicKey: existing };

  await io.mkdir(dirname(paths.private));
  const result = await io.run("ssh-keygen", ["-t", "ed25519", "-N", "", "-C", "dbox", "-f", paths.private]);
  if (result.code !== 0) throw new Error(result.stderr || result.stdout);

  await io.chmod(paths.private, 0o600);
  const publicKey = await readPublicKey(paths, io);
  if (publicKey === null) throw new Error("clé générée, mais illisible juste après");
  return { created: true, publicKey };
}
