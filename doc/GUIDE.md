# Guide utilisateur

Ce guide part du principe que tu ne connais pas encore DBox et répond à
quatre questions dans l'ordre : à quoi ça sert, comment l'installer, quand
utiliser quoi, et comment s'en servir au quotidien.

- Pour l'installation pas à pas, réseau privé Tailscale compris : **[`INSTALL.md`](INSTALL.md)**.
- Pour comprendre *comment* DBox pense — modèle, invariants, arbitrages,
  ce qui se génère exactement : **[`REFERENCE.md`](REFERENCE.md)**.

Ce document-ci ne répète pas ce que les deux autres couvrent déjà ; il relie
les choses entre elles et donne des scénarios concrets.

---

## À quoi ça sert

Tu as du code qui tourne chez toi (un serveur, un portable, un Raspberry Pi
— peu importe), et tu veux y accéder depuis ton téléphone, ou depuis
n'importe où, sans :

- ouvrir de port sur ta box internet,
- gérer un nom de domaine et un certificat,
- écrire un `docker-compose.yml` à la main à chaque nouvelle app,
- te souvenir de quel port va avec quelle app.

DBox fait deux choses, et rien de plus : **il génère le Compose** à partir
d'un fichier que tu écris (`dbox.toml`), et **il pose un nœud Tailscale
dédié** devant chaque app, qui devient son adresse HTTPS stable
(`https://<nom>.<tailnet>.ts.net`). Rien n'est caché dans un format
propriétaire — tu peux lire chaque fichier généré, ou arrêter d'utiliser
DBox demain sans que rien ne s'arrête de tourner.

**Pour qui c'est fait** : quelqu'un qui a déjà un `Dockerfile` (ou une
commande de dev), qui est à l'aise avec un terminal, et qui veut un
résultat en une commande plutôt qu'en une après-midi. Pas pour qui cherche
un PaaS public avec facturation à l'usage, du multi-tenant, ou une
détection automatique de stack (buildpacks) — DBox part du principe que le
`Dockerfile` est déjà écrit, il ne le devine jamais.

**Ce que ça remplace concrètement** : la série de gestes qu'on refait à la
main à chaque app — `docker-compose.yml`, labels de reverse proxy, port
libre, entrée DNS, certificat, unit systemd pour que ça revienne au
redémarrage. Aucun de ces gestes n'a de rapport avec le fait de coder ;
DBox les absorbe.

---

## Installation express

Le détail complet (y compris configurer Tailscale depuis zéro) est dans
[`INSTALL.md`](INSTALL.md). En résumé, sur une machine Linux avec Docker :

```bash
git clone <url-du-dépôt> dbox && cd dbox
./install.sh      # vérifie Docker, construit l'image, pose `dbox` dans ~/.local/bin
dbox setup        # configure cette machine : tailnet, cible par défaut, racine, tag
```

`dbox setup` t'indique où coller la clé d'authentification Tailscale, plutôt
que de te la demander directement — elle ne transite donc jamais par une
commande ni un formulaire qui pourrait la journaliser. DBox la lit ensuite
lui-même depuis ce fichier pour l'écrire dans le `ts.env` de chaque nouvelle
cible ; elle n'est en revanche jamais affichée en retour, y compris par
`dbox plan`.

Le tableau de bord web (optionnel, voir plus bas) est un geste séparé et
volontairement manuel : `cd deploy && docker compose up -d`, après avoir
renseigné `deploy/.env`.

---

## Quel mode pour quel besoin

Un projet peut avoir plusieurs cibles à la fois (`dev`, `prod`, ou
n'importe quel nom que tu choisis — voir plus bas), chacune avec sa propre
adresse. Le choix du mode se fait par cible, dans `dbox.toml`.

| Tu veux…                                                          | Mode           |
| ------------------------------------------------------------------ | -------------- |
| Mettre en ligne une version figée, qui tourne même poste éteint    | `deployed`      |
| Coder en direct, rechargement à chaud, exactement comme en local   | `workspace`     |
| Coder en direct, mais dans un environnement isolé et reproductible | `devcontainer`  |

### `deployed` — la version qui tourne pour de vrai

```toml
[targets.prod]
mode = "deployed"
port = 8080
health = "/healthz"   # interrogé après déploiement, défaut "/"
data = "/data"         # chemin dans le conteneur monté sur un volume nommé — persiste
```

DBox construit l'image depuis ton `Dockerfile`, la tague avec le SHA git
des sources, démarre, vérifie que l'URL finale répond, et revient à la
version précédente si ça échoue. C'est la seule forme figée — elle survit
à l'extinction du poste qui a servi à construire l'image.

### `workspace` — ta commande, en direct sur ta machine

```toml
[targets.dev]
mode = "workspace"
command = "npm run dev"
port = 5173
```

Rien n'est conteneurisé : DBox pose juste un nœud Tailscale devant ta
commande qui tourne déjà sur ton poste. Rechargement instantané, aucune
isolation — le bon choix quand ta machine de dev suffit.

### `devcontainer` — la même boucle, isolée

```toml
[targets.dev]
mode = "devcontainer"
command = "npm run dev"
port = 5173
dockerfile = "Dockerfile.dev"   # optionnel — une image toute faite suffit souvent
```

Tes sources sont montées dans un conteneur (pas copiées), la commande y
tourne, le rechargement reste instantané. Utile dès que le projet mêle
deux runtimes, ou quand tu veux la parité avec la prod sans polluer ton
poste. Piège classique : installer une dépendance se fait *dans* le
conteneur, jamais sur l'hôte — voir « Pièges connus » de `REFERENCE.md`.

---

## Cas d'usage

### 1. Mettre en ligne une app existante, en une commande

Un dossier avec un `Dockerfile`, rien d'autre :

```bash
dbox up ~/chemin/vers/ton-app
```

Sans `dbox.toml`, DBox en écrit un lui-même (nom déduit du dossier, port
depuis `EXPOSE`), puis construit, démarre, vérifie. Le code est déjà sur
GitHub/GitLab/Forgejo ? Une seule commande clone et déploie :

```bash
dbox add git@ton-hote:toi/ton-app.git
```

### 2. Développer avec rechargement à chaud, exposé sur le tailnet

Utile pour montrer un travail en cours à quelqu'un, ou tester depuis un
téléphone sans tunnel bricolé :

```toml
[targets.dev]
mode = "workspace"
command = "npm run dev"
port = 5173
```

`dbox up ~/mon-projet --target dev` → `https://mon-projet-dev.tontailnet.ts.net`,
rechargement instantané à chaque sauvegarde. Vite en particulier demande
deux réglages (`server.allowedHosts`, `server.hmr`) — détaillés dans les
« Pièges connus » de `REFERENCE.md`.

### 3. Une app qui se redéploie toute seule à chaque push

```toml
[targets.prod]
mode = "deployed"
port = 8080
auto_deploy = true
```

Le daemon sonde le dépôt à intervalle réglable (`--poll-interval`, 300 s
par défaut) et ne redéploie que si un commit est vraiment arrivé —
jamais par webhook, pour ne jamais avoir à exposer de point d'entrée
depuis internet. Le délai se règle, l'instantané n'est pas le but.

### 4. Un service qui parle SSH en plus du HTTPS

Une forge git auto-hébergée (Forgejo, Gitea) a besoin d'un accès
`git@ton-instance:...` en plus de son interface web. Un champ dédié
force ce port précis à travers le même sidecar, sans jamais ouvrir de
port sur l'hôte :

```toml
[targets.prod]
mode = "deployed"
port = 3000
ssh_port = 22
```

Le sidecar Tailscale termine toujours le HTTPS sur 443 *et* relaie le
port 22 en TCP brut vers le conteneur — les deux protocoles, un seul
nœud, toujours sans port publié.

### 5. Piloter depuis le téléphone, sans terminal

Le tableau de bord (`dbox serve`, déployé à part — voir plus bas) donne
accès à tout ce qui précède sans ligne de commande : ajouter une app
depuis une URL git ou un dossier local déjà présent sur la machine,
redéployer, arrêter, éditer les variables d'environnement ou le
manifeste, lire les journaux, supprimer.

---

## Comment l'utiliser au quotidien

### En ligne de commande

```
dbox add <url>       # clone un dépôt, écrit son manifeste au besoin, et déploie
dbox init            # écrit dbox.toml d'après le dossier et son Dockerfile
dbox plan            # affiche les fichiers qui seraient générés, sans rien toucher
dbox up <dossier>     # construit, déploie, vérifie
dbox rm <app>        # arrête et supprime une cible — source et volumes intacts
dbox ls              # ce qui tourne, où, depuis quand, avec quelle URL
dbox serve           # le daemon web
dbox rotate-authkey  # régénère la clé Tailscale si l'échéance approche
```

`--target <nom>` se précise sur `up`/`rm` quand une app a plusieurs
cibles ; sans lui, DBox retombe sur la cible par défaut de cette machine
(`~/.config/dbox/config.toml`).

### Depuis le tableau de bord

Optionnel, et un geste de déploiement séparé et délibéré
(`deploy/docker-compose.yml`) — il donne au daemon un accès complet à
Docker sur la machine, mieux vaut le lire avant de le lancer.

Une fois en place (`https://dbox.tontailnet.ts.net`) :

- **Ajouter** : un formulaire propose un dépôt git, ou un dossier déjà
  présent sur la machine si `--workspaces-root` est configuré. Le mode
  (`deployed`/`workspace`/`devcontainer`) se choisit là ; port et
  commande n'apparaissent que si le mode en a besoin.
- **Chaque carte** : Redéployer, Démarrer/Arrêter, Variables (le `.env`,
  valeurs masquées par défaut), Manifeste (port, santé, commande,
  redéploiement automatique — pas le Dockerfile ni le volume, trop
  structurants pour un formulaire), Journaux, Supprimer.
- **Réglages** (`/settings`) : générer/consulter la clé SSH dédiée aux
  clonages, gérer la liste des autres machines DBox connues, et deux
  rapports en lecture seule — nœuds Tailscale abandonnés, présence du
  tag dans la policy — écrits par une tâche séparée, jamais par le
  daemon lui-même.

### Plusieurs machines

Chaque machine DBox est indépendante — `target` dans sa configuration
décide quelle cible du manifeste *elle* déploie (rien n'oblige à
n'avoir que « dev » et « prod » : n'importe quel nom de cible valide
fonctionne, du moment qu'il existe dans le `dbox.toml` de l'app). Un
sélecteur dans l'en-tête du tableau de bord permet de naviguer entre
les machines connues, mais elles ne s'appellent jamais entre elles —
pas de registre partagé, pas de source de vérité centrale.

---

## Aller plus loin

- **`REFERENCE.md`** — le modèle complet, le manifeste en détail, les
  invariants de sécurité, ce que génère exactement DBox, et les pièges
  connus (HMR, UID, dépendances natives).
- **`INSTALL.md`** — configurer Tailscale depuis zéro, dépanner un
  premier déploiement qui ne répond pas.
