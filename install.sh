#!/usr/bin/env sh
# Installe la commande `dbox` sur cette machine.
#
# Le seul vrai prérequis est Docker : `dbox` devient un lanceur qui exécute
# la CLI dans le même conteneur que le daemon (Node 24, git, Docker CLI —
# déjà construits une fois). Rien d'autre à installer sur l'hôte, et
# notamment jamais de Node à la mauvaise version qui traîne dans le PATH.
#
# Ce que ce script fait :
#   1. vérifie que Docker répond ;
#   2. construit l'image (deploy/Dockerfile) ;
#   3. pose un lanceur `dbox` dans ~/.local/bin.
#
# Ce qu'il ne fait jamais : modifier un fichier de démarrage de shell, ni
# déployer le daemon lui-même (deploy/docker-compose.yml reste un geste
# délibéré, à la main — c'est lui qui obtient l'accès au socket Docker).

set -eu

REPO_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
# DBOX_IMAGE : une image publiée (ex. ghcr.io/cdn21/dbox:1.1.0), téléchargée au
# lieu d'être construite. Absente : construite ici, sous un nom local.
IMAGE=${DBOX_IMAGE:-dbox-daemon:local}
BIN_DIR="$HOME/.local/bin"

echo "DBox — installation sur $(hostname)"
echo

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker est introuvable. DBox n'installe pas Docker à ta place —" >&2
  echo "c'est une décision trop spécifique à ta distribution pour l'automatiser" >&2
  echo "sans risque. Voir https://docs.docker.com/engine/install/" >&2
  exit 1
fi

if ! docker info >/dev/null 2>&1; then
  echo "Docker est installé mais injoignable (démon arrêté, ou droits" >&2
  echo "insuffisants sur /var/run/docker.sock)." >&2
  exit 1
fi

if [ -n "${DBOX_IMAGE:-}" ]; then
  echo "→ téléchargement de l'image ($IMAGE)…"
  docker pull -q "$IMAGE" >/dev/null
else
  echo "→ construction de l'image ($IMAGE)…"
  docker build -q -f "$REPO_DIR/deploy/Dockerfile" -t "$IMAGE" "$REPO_DIR" >/dev/null
fi

mkdir -p "$BIN_DIR"
cat > "$BIN_DIR/dbox" <<LAUNCHER
#!/usr/bin/env sh
# Généré par install.sh — relance-le pour reconstruire après une mise à jour.
#
# La CLI tourne dans le conteneur, mais elle agit sur l'hôte : les mêmes
# montages que le daemon (deploy/docker-compose.yml), en miroir.

if [ "\${1:-}" = "serve" ]; then
  echo "dbox serve ne se lance pas par ce lanceur : sans son sidecar Tailscale" >&2
  echo "ni port publié, il tournerait mais resterait injoignable — il semblerait" >&2
  echo "juste marcher. Le daemon se déploie à part :" >&2
  echo "  cd $REPO_DIR/deploy && docker compose up -d" >&2
  exit 1
fi

# Le CLI Docker (BuildKit) veut écrire son état dans \$HOME/.docker au premier
# \`build\`. \$HOME lui-même n'est pas monté — seuls les sous-dossiers ci-dessous
# le sont — donc \$HOME/.docker y serait un point de montage vide, possédé par
# root : DOCKER_CONFIG le redirige vers un endroit réellement monté.
exec docker run --rm -i \\
  --user "\$(id -u):\$(id -g)" \\
  --group-add "\$(getent group docker | cut -d: -f3)" \\
  -e HOME="\$HOME" \\
  -e DOCKER_CONFIG="\$HOME/dbox/.dockercli" \\
  -v /var/run/docker.sock:/var/run/docker.sock \\
  -v "\$HOME/.ssh:\$HOME/.ssh:ro" \\
  -v "\$HOME/.config/dbox:\$HOME/.config/dbox" \\
  -v "\$HOME/dbox:\$HOME/dbox" \\
  -v "\$PWD:\$PWD" \\
  -w "\$PWD" \\
  $IMAGE "\$@"
LAUNCHER
chmod +x "$BIN_DIR/dbox"

echo "→ lanceur posé : $BIN_DIR/dbox"
echo

case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *)
    echo "⚠ $BIN_DIR n'est pas dans ton PATH. Ajoute, dans ton ~/.bashrc ou ~/.zshrc :"
    echo "    export PATH=\"$BIN_DIR:\$PATH\""
    echo
    ;;
esac

echo "(le daemon web, lui, se déploie à part : voir deploy/docker-compose.yml)"
echo

CONFIG="${XDG_CONFIG_HOME:-$HOME/.config}/dbox/config.toml"
if [ -f "$CONFIG" ]; then
  echo "Configuration déjà en place : $CONFIG"
elif [ -t 0 ]; then
  printf "Configurer cette machine maintenant (dbox setup) ? [O/n] "
  read -r reponse
  case "$reponse" in
    [nN]*) echo "Plus tard : dbox setup" ;;
    *) "$BIN_DIR/dbox" setup ;;
  esac
else
  echo "Prochaine étape : dbox setup"
fi
