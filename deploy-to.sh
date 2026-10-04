#!/usr/bin/env sh
# Déploie *cette* version de DBox sur une machine qui l'a déjà installé.
#
# Le geste que ce script remplace était manuel, répété, et piégé : synchroniser
# `deploy/` en entier écrase le `.env` et le `ts.env` de la machine cible avec
# ceux d'une autre — sa clé d'auth, ses secrets, son nom de nœud. C'est arrivé
# en vrai (14 août 2026 : `serve` renommé d'après la config de pc-cde). D'où la
# règle, ici structurelle plutôt que mémorisée : seuls `src/` et deux fichiers
# nommés traversent, jamais le dossier `deploy/` complet.
#
# Ce qu'il fait :
#   1. refuse un arbre local qui ne compile pas ou dont les tests échouent ;
#   2. vérifie que la machine répond et a déjà DBox posé ;
#   3. remplace `src/` (suppression puis extraction : un fichier supprimé ici
#      disparaît là-bas aussi, ce qu'un simple `tar x` ne ferait pas) ;
#   4. copie `deploy/docker-compose.yml` et `deploy/Dockerfile`, nommément ;
#   5. reconstruit l'image et redémarre le daemon ;
#   6. vérifie qu'il est bien revenu — et le dit franchement sinon.
#
# Une machine en déploiement continu (DBox posé en clone git, mis à jour par
# deploy/maj-auto.sh) est refusée : elle se met à jour seule, depuis `main`.
#
# Ce qu'il ne fait jamais : toucher `deploy/.env` ni `deploy/ts.env` (propres à
# chaque machine), synchroniser `deploy/` en entier, ni installer DBox sur une
# machine qui ne l'a pas — c'est `install.sh`, et c'est un geste séparé.
#
#   ./deploy-to.sh moi@mon-serveur
#   ./deploy-to.sh mon-serveur --remote-dir /srv/dbox/tool

set -eu

REPO_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
# Vide = à déduire du $HOME de la machine distante, une fois connecté. Pas de
# « $HOME/… » littéral ici : il faudrait le laisser développer par le shell
# distant, donc l'envoyer sans quotes — et c'est précisément ce qu'on refuse
# de faire plus bas.
REMOTE_DIR=''
SKIP_TESTS=0
MACHINE=''

usage() {
  echo "usage: $0 <machine ssh> [--remote-dir <chemin>] [--skip-tests]" >&2
  echo >&2
  echo "  --remote-dir   où vit DBox sur la machine (défaut : ~/dbox/tool)" >&2
  echo "  --skip-tests   déployer sans lancer typecheck ni tests — à n'utiliser" >&2
  echo "                 que si tu viens de les lancer toi-même" >&2
}

while [ $# -gt 0 ]; do
  case "$1" in
    --remote-dir)
      [ $# -ge 2 ] || { echo "--remote-dir attend un chemin" >&2; exit 1; }
      REMOTE_DIR=$2
      shift 2
      ;;
    --skip-tests) SKIP_TESTS=1; shift ;;
    -h|--help) usage; exit 0 ;;
    -*) echo "option inconnue « $1 »" >&2; usage; exit 1 ;;
    *)
      [ -z "$MACHINE" ] || { echo "une seule machine à la fois (« $MACHINE » puis « $1 »)" >&2; exit 1; }
      MACHINE=$1
      shift
      ;;
  esac
done

[ -n "$MACHINE" ] || { usage; exit 1; }

echo "DBox → $MACHINE"
echo

# ── 1. l'arbre local ────────────────────────────────────────────────────────
# Déployer du code qui ne compile pas coûte un aller-retour et un daemon mort
# le temps de s'en rendre compte. La vérification est locale, elle est rapide.
if [ "$SKIP_TESTS" -eq 0 ]; then
  if [ -z "${NVM_DIR:-}" ] && [ -d "$HOME/.nvm" ]; then
    NVM_DIR="$HOME/.nvm"
    # shellcheck disable=SC1091
    . "$NVM_DIR/nvm.sh" >/dev/null 2>&1 || true
  fi
  if ! command -v node >/dev/null 2>&1; then
    echo "node est introuvable — relance avec --skip-tests si tu as vérifié toi-même." >&2
    exit 1
  fi

  echo "→ typecheck…"
  (cd "$REPO_DIR" && npm run --silent typecheck)
  echo "→ tests…"
  (cd "$REPO_DIR" && npm run --silent test >/dev/null)
  echo "  tout est vert"
fi

# Un arbre modifié n'est pas une erreur — c'est même le cas courant quand on
# valide une branche sur une vraie machine. Mais il vaut mieux le savoir.
if command -v git >/dev/null 2>&1 && [ -n "$(cd "$REPO_DIR" && git status --porcelain 2>/dev/null)" ]; then
  echo "  ⚠ arbre local modifié : c'est ce travail non commité qui part."
fi
echo

# ── 2. la machine ───────────────────────────────────────────────────────────
echo "→ contrôle de $MACHINE…"
if ! ssh -o ConnectTimeout=10 -o BatchMode=yes "$MACHINE" true 2>/dev/null; then
  echo "injoignable en SSH sans mot de passe (clé absente, ou machine éteinte)." >&2
  exit 1
fi

# Tout ce qui part dans une commande distante est entre apostrophes : le shell
# de là-bas voit alors une chaîne, jamais de la syntaxe. Sans ça, un
# `--remote-dir '/tmp/x; cd /'` ferait exécuter le `cd /`, et le `rm -rf src`
# plus bas s'appliquerait à la racine. Une apostrophe dans le chemin casserait
# ce quotage, donc on refuse tout de suite plutôt que de bricoler un
# échappement — aucun chemin d'installation raisonnable n'en contient.
case "$REMOTE_DIR" in
  *"'"*)
    echo "--remote-dir ne peut pas contenir d'apostrophe" >&2
    exit 1
    ;;
esac

# Le défaut se déduit du $HOME distant, demandé explicitement plutôt que laissé
# à l'interprétation d'une commande non quotée.
if [ -z "$REMOTE_DIR" ]; then
  REMOTE_HOME=$(ssh "$MACHINE" 'printf %s "$HOME"' 2>/dev/null || true)
  if [ -z "$REMOTE_HOME" ]; then
    echo "impossible de lire le \$HOME de $MACHINE — précise --remote-dir." >&2
    exit 1
  fi
  REMOTE_DIR="$REMOTE_HOME/dbox/tool"
fi

# `scp` ne passe pas par un shell distant : le chemin doit être absolu et réel.
# `pwd` le normalise (liens symboliques, « .. »), et confirme qu'il existe.
REMOTE_DIR=$(ssh "$MACHINE" "cd '$REMOTE_DIR' 2>/dev/null && pwd" 2>/dev/null || true)
if [ -z "$REMOTE_DIR" ]; then
  echo "le dossier indiqué n'existe pas sur $MACHINE." >&2
  echo "Ce script met à jour une installation existante ; pour la première," >&2
  echo "copie le dépôt là-bas et lance install.sh, puis dbox setup." >&2
  exit 1
fi

if ! ssh "$MACHINE" "[ -f '$REMOTE_DIR/deploy/docker-compose.yml' ]" 2>/dev/null; then
  echo "DBox n'est pas installé dans $REMOTE_DIR sur $MACHINE." >&2
  echo "Ce script met à jour une installation existante ; pour la première," >&2
  echo "copie le dépôt là-bas et lance install.sh, puis dbox setup." >&2
  exit 1
fi

# Un clone git là-bas, c'est le déploiement continu (deploy/maj-auto.sh) : la
# machine tire elle-même la branche `production`. Y copier `src/` salirait
# l'arbre, que le prochain passage du cron effacerait par un `git reset --hard`
# — on aurait déployé pour cinq minutes. Le geste à faire est de pousser `main`.
if ssh "$MACHINE" "[ -e '$REMOTE_DIR/.git' ]" 2>/dev/null; then
  echo "$REMOTE_DIR est un clone git sur $MACHINE : il se met à jour seul." >&2
  echo "Pousse sur main ; la CI avance production, et la machine la tire" >&2
  echo "(deploy/maj-auto.sh, par cron). Lancement manuel, sur la machine :" >&2
  echo "  $REMOTE_DIR/deploy/maj-auto.sh" >&2
  exit 1
fi

# Le fichier qui contient la clé d'auth et les secrets de *cette* machine : on
# vérifie seulement qu'il est là, on ne le lit pas et on n'y touche pas.
if ! ssh "$MACHINE" "[ -f '$REMOTE_DIR/deploy/.env' ]" 2>/dev/null; then
  echo "  ⚠ pas de deploy/.env sur $MACHINE — le démarrage échouera sur les"
  echo "    variables obligatoires (DBOX_HOME, DBOX_TAILNET)."
fi
echo "  installation trouvée dans $REMOTE_DIR"
echo

# ── 3. les sources ──────────────────────────────────────────────────────────
# `src` est **remplacé**, pas complété : sans ça, un fichier supprimé du dépôt
# survivrait indéfiniment sur la machine. Sans danger pour le daemon en cours,
# qui tourne depuis l'image (deploy/Dockerfile fait `COPY src/`), pas depuis
# ces fichiers-ci.
#
# L'extraction va d'abord dans un dossier à part, et l'ancien `src` n'est
# supprimé qu'une fois qu'elle a réussi. La version naïve — `rm -rf src` puis
# extraire — laissait la machine sans sources si l'archive n'arrivait pas
# entière : le pipeline rend le code du `ssh`, pas celui du `tar` local, donc
# un échec à gauche passait inaperçu (et `pipefail` n'existe pas partout en sh).
echo "→ envoi de src/ …"
tar czf - -C "$REPO_DIR" src \
  | ssh "$MACHINE" "cd '$REMOTE_DIR' \
      && rm -rf .src-entrant \
      && mkdir .src-entrant \
      && tar xzf - -C .src-entrant \
      && rm -rf src \
      && mv .src-entrant/src src \
      && rmdir .src-entrant"

# Nommés un par un, jamais `deploy/` en entier : c'est toute la protection.
echo "→ envoi de deploy/docker-compose.yml et deploy/Dockerfile…"
scp -q "$REPO_DIR/deploy/docker-compose.yml" "$MACHINE:$REMOTE_DIR/deploy/docker-compose.yml"
scp -q "$REPO_DIR/deploy/Dockerfile" "$MACHINE:$REMOTE_DIR/deploy/Dockerfile"
echo

# ── 4. reconstruction et redémarrage ────────────────────────────────────────
# La version est calculée *ici*, pas sur la machine : là-bas, `tool/` n'est
# qu'une copie de fichiers, sans dépôt git à interroger. Même convention que
# le tag d'une app (src/tag.ts) : SHA court, `-sale` si l'arbre est modifié.
VERSION=inconnue
if command -v git >/dev/null 2>&1 && (cd "$REPO_DIR" && git rev-parse HEAD >/dev/null 2>&1); then
  VERSION=$(cd "$REPO_DIR" && git rev-parse --short=12 HEAD)
  if [ -n "$(cd "$REPO_DIR" && git status --porcelain)" ]; then
    VERSION="$VERSION-sale"
  fi
fi

echo "→ reconstruction de l'image (version $VERSION)…"
ssh "$MACHINE" "cd '$REMOTE_DIR/deploy' && DBOX_VERSION='$VERSION' docker compose build daemon" 2>&1 | tail -3

# `authkey-rotator` partage l'image du daemon : sans ce redémarrage-là, il
# continuerait de tourner l'ancienne indéfiniment — un correctif à la rotation,
# aux orphelins ou au tagcheck ne serait jamais déployé, en silence. Le sidecar
# Tailscale, lui, n'est pas touché : le recréer couperait le tableau de bord du
# tailnet sans rien apporter, son image ne vient pas d'ici.
echo "→ redémarrage du daemon et du rotator…"
ssh "$MACHINE" "cd '$REMOTE_DIR/deploy' && docker compose up -d daemon authkey-rotator" 2>&1 | tail -4
echo

# ── 5. est-il vraiment revenu ? ─────────────────────────────────────────────
# Docker rend la main dès que le conteneur démarre, pas quand il est sain :
# sans cette attente, un daemon qui plante au bout de deux secondes passerait
# pour un déploiement réussi.
echo "→ vérification…"
i=0
while [ "$i" -lt 20 ]; do
  etat=$(ssh "$MACHINE" "docker inspect --format '{{.State.Health.Status}}' dbox-daemon-daemon-1 2>/dev/null" 2>/dev/null || echo inconnu)
  case "$etat" in
    healthy)
      echo "  daemon sain."
      # Le rotator n'a pas de contrôle de santé (rien n'écoute dedans, c'est
      # voulu) : on vérifie donc la seule chose qui compte ici — qu'il tourne
      # bien la version qu'on vient de construire, et pas l'ancienne image.
      pose=$(ssh "$MACHINE" "docker exec dbox-daemon-authkey-rotator-1 sh -c 'echo \$DBOX_VERSION'" 2>/dev/null || echo "")
      if [ "$pose" = "$VERSION" ]; then
        echo "  rotator sur la même version."
      else
        echo "  ⚠ rotator sur « ${pose:-aucune} », attendu « $VERSION »." >&2
      fi
      echo
      ssh "$MACHINE" "docker logs --tail 3 dbox-daemon-daemon-1 2>&1" | sed 's/^/  /'
      exit 0
      ;;
    unhealthy)
      break
      ;;
  esac
  i=$((i + 1))
  sleep 2
done

echo "le daemon n'est pas revenu en bonne santé (dernier état : ${etat:-inconnu})." >&2
echo "Ses journaux :" >&2
ssh "$MACHINE" "docker logs --tail 20 dbox-daemon-daemon-1 2>&1" | sed 's/^/  /' >&2
echo >&2
echo "Les apps déployées, elles, tournent dans leurs propres projets Compose :" >&2
echo "elles ne sont pas affectées. Pour revenir en arrière, redéploie la" >&2
echo "version précédente depuis un arbre à jour." >&2
exit 1
