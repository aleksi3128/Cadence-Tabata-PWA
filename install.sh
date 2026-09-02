#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════
#  Installation guidée de Cadence Tabata sur un CT Proxmox (Debian 13).
#
#  Le dépôt Cadence-Tabata-PWA contient le site DÉJÀ CONSTRUIT : ce conteneur
#  n'a donc qu'à le cloner et le servir. Ni Node, ni Python, ni build, ni
#  fichier de configuration à remplir — nginx et git suffisent.
#
#  TLS : rien ici. Nginx Proxy Manager termine le HTTPS en amont et proxifie
#  vers ce CT en HTTP sur le LAN.
#
#  À lancer en root, DANS le conteneur :
#
#    bash install.sh
#
#  Le script pose ses questions au fur et à mesure et explique chaque étape.
#  Pour une réinstallation muette, tout se passe aussi en options (--help).
#
#  Idempotent : le relancer remet la configuration en état.
# ═══════════════════════════════════════════════════════════════════
set -euo pipefail

REPO="https://github.com/aleksiiiiiii/Cadence-Tabata-PWA.git"
WEBROOT="/var/www/cadence-tabata"
BRANCH="main"
DOMAIN=""
PROXY_FROM=""
INTERVAL="15min"
TOKEN=""
ASSUME_YES=0

for a in "$@"; do
  case "$a" in
    --repo=*)       REPO="${a#*=}" ;;
    --branch=*)     BRANCH="${a#*=}" ;;
    --token=*)      TOKEN="${a#*=}" ;;
    --webroot=*)    WEBROOT="${a#*=}" ;;
    --domain=*)     DOMAIN="${a#*=}" ;;
    --proxy-from=*) PROXY_FROM="${a#*=}" ;;
    --interval=*)   INTERVAL="${a#*=}" ;;
    -y|--yes)       ASSUME_YES=1 ;;
    -h|--help)      sed -n '2,19p' "$0"; exit 0 ;;
    *) echo "✗ Option inconnue : $a" >&2; exit 1 ;;
  esac
done

say()  { printf '\n\033[1m▸ %s\033[0m\n' "$*"; }
ok()   { printf '  ✓ %s\n' "$*"; }
info() { printf '    %s\n' "$*"; }
warn() { printf '  \033[33m⚠  %s\033[0m\n' "$*"; }
die()  { printf '\n\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

# Ce script peut arriver par `curl … | bash` : dans ce cas stdin est le script
# lui-même, et un read y avalerait ses propres lignes. On lit donc le terminal.
TTY=/dev/tty
[ -r "$TTY" ] || TTY=""

ask() {                       # ask <variable> <question> [défaut] [muet]
  local __var="$1" __q="$2" __def="${3:-}" __silent="${4:-}" __ans=""
  if [ "$ASSUME_YES" = 1 ] || [ -z "$TTY" ]; then
    printf -v "$__var" '%s' "$__def"; return
  fi
  if [ -n "$__def" ]; then printf '  %s [%s] : ' "$__q" "$__def"
  else                     printf '  %s : ' "$__q"; fi
  if [ -n "$__silent" ]; then read -r -s __ans < "$TTY"; printf '\n'
  else                        read -r    __ans < "$TTY"; fi
  printf -v "$__var" '%s' "${__ans:-$__def}"
}

confirm() {                   # confirm <question>  → 0 si oui
  [ "$ASSUME_YES" = 1 ] && return 0
  [ -z "$TTY" ] && return 0
  local r=""
  printf '  %s [O/n] ' "$1"
  read -r r < "$TTY"
  case "${r:-o}" in [oOyY]*) return 0 ;; *) return 1 ;; esac
}

# ── Contrôles préalables ───────────────────────────────────────────
[ "$(id -u)" -eq 0 ] || die "À lancer en root (depuis l'hôte Proxmox : pct enter <ID>)"

case "$WEBROOT" in
  ""|/|/bin|/boot|/etc|/home|/lib|/opt|/root|/srv|/usr|/var|/var/www)
    die "--webroot=$WEBROOT est trop proche de la racine : l'installation y écrase des fichiers." ;;
esac

clear 2>/dev/null || true
cat <<'BANNER'
═══════════════════════════════════════════════════════════════════
  Cadence Tabata — installation sur ce conteneur
═══════════════════════════════════════════════════════════════════

  Le dépôt contient le site déjà construit : ce conteneur n'aura
  rien à compiler. Le script va, dans l'ordre :

    1. installer nginx et git ;
    2. cloner le site (~35 Mo) ;
    3. configurer nginx ;
    4. mettre en place une mise à jour automatique.

  Comptez deux minutes. Chaque étape est expliquée avant d'être
  lancée ; rien n'est fait sans que vous puissiez le lire.

BANNER

if [ -r /etc/os-release ]; then
  . /etc/os-release
  [ "${ID:-}" = "debian" ] || warn "Prévu pour Debian 13 — détecté : ${PRETTY_NAME:-inconnu}"
fi

AVAIL_MB=$(df -Pm / | awk 'NR==2{print $4}')
if [ "${AVAIL_MB:-0}" -lt 200 ]; then
  warn "Espace libre : ${AVAIL_MB} Mo. Il en faut ~150 (le clone pèse 35 Mo, plus son historique)."
  confirm "Continuer quand même ?" || die "Interrompu."
else
  ok "espace disque : ${AVAIL_MB} Mo libres"
fi

# ── Questions ──────────────────────────────────────────────────────
say "Configuration"
info "Quatre réponses suffisent. Entrée accepte la valeur entre crochets."
printf '\n'

ask REPO   "Dépôt à cloner" "$REPO"
ask BRANCH "Branche" "$BRANCH"

printf '\n'
info "Si le dépôt est privé, il faut un jeton GitHub en lecture seule."
info "GitHub → Settings → Developer settings → Personal access tokens."
info "Un jeton « fine-grained » avec Contents: Read-only suffit."
info "Laissez vide si le dépôt est public."
ask TOKEN  "Jeton GitHub (invisible à la saisie)" "" silent

printf '\n'
info "Nginx Proxy Manager termine le HTTPS en amont et proxifie vers ce CT."
ask DOMAIN     "Nom de domaine servi (vide = toutes requêtes)" "$DOMAIN"
ask PROXY_FROM "Réseau du proxy, pour retrouver l'IP réelle (ex. 192.168.2.0/24)" "$PROXY_FROM"

printf '\n'
cat <<RECAP
  ──────────────────────────────────────────────────────────
   Dépôt       : ${REPO}  (branche ${BRANCH})
   Jeton       : $([ -n "$TOKEN" ] && echo "fourni" || echo "aucun — dépôt supposé public")
   Site servi  : ${WEBROOT}
   Domaine     : ${DOMAIN:-toutes requêtes}
   Mise à jour : toutes les ${INTERVAL}
  ──────────────────────────────────────────────────────────
RECAP
confirm "On y va ?" || die "Interrompu — rien n'a été modifié."

# ── 1. Paquets ─────────────────────────────────────────────────────
say "1/4 · Paquets"
info "nginx sert le site, git le récupère et le tient à jour."
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq nginx git curl ca-certificates
ok "$(nginx -v 2>&1)"
ok "git $(git --version | awk '{print $3}')"

# ── 2. Clone ───────────────────────────────────────────────────────
say "2/4 · Site"

# Le jeton va dans un fichier lisible du seul root, pas dans l'URL du remote :
# dans l'URL il apparaîtrait en clair dans `git remote -v`, dans les journaux
# et dans la sortie d'erreur de chaque `git pull`.
if [ -n "$TOKEN" ]; then
  HOST="$(printf '%s' "$REPO" | sed -E 's#^https?://([^/]+)/.*#\1#')"
  umask 077
  printf 'https://x-access-token:%s@%s\n' "$TOKEN" "$HOST" > /root/.git-credentials
  git config --system credential.helper 'store --file=/root/.git-credentials'
  umask 022
  ok "jeton enregistré dans /root/.git-credentials (0600)"
fi

if ! curl -fsS --max-time 10 -o /dev/null https://github.com 2>/dev/null; then
  die "github.com est injoignable depuis ce conteneur."
fi

if [ -d "$WEBROOT/.git" ]; then
  info "Site déjà cloné — mise à jour plutôt que clone."
  git -C "$WEBROOT" remote set-url origin "$REPO"
  git -C "$WEBROOT" fetch --quiet origin "$BRANCH"
  git -C "$WEBROOT" reset --quiet --hard "origin/$BRANCH"
else
  rm -rf "$WEBROOT"
  install -d -m 755 "$(dirname "$WEBROOT")"
  # --depth 1 : le CT n'a que faire de l'historique, et le dépôt contient des
  # médias binaires dont les anciennes versions pèseraient pour rien.
  git clone --quiet --depth 1 --branch "$BRANCH" "$REPO" "$WEBROOT" \
    || die "Le clone a échoué. Jeton valide ? Dépôt accessible ?"
fi
chown -R www-data:www-data "$WEBROOT"
ok "$WEBROOT — version $(cat "$WEBROOT/version.txt" 2>/dev/null || echo '?')"
[ -f "$WEBROOT/index.html" ] || die "index.html absent du clone — mauvais dépôt ou mauvaise branche ?"

# ── 3. nginx ───────────────────────────────────────────────────────
say "3/4 · nginx"

REALIP=""
if [ -n "$PROXY_FROM" ]; then
  REALIP="    set_real_ip_from ${PROXY_FROM};
    real_ip_header X-Forwarded-For;
    real_ip_recursive on;
"
fi

cat > /etc/nginx/sites-available/tabata <<NGINXEOF
# GÉNÉRÉ par install.sh — relancer le script pour le régénérer.
# Pas de TLS ici : Nginx Proxy Manager termine le HTTPS en amont.
server {
    listen 80;
    listen [::]:80;
    server_name ${DOMAIN:-_};

    root ${WEBROOT};
    index index.html;
    charset utf-8;

${REALIP}
    access_log /var/log/nginx/tabata.access.log;
    error_log  /var/log/nginx/tabata.error.log;

    # Le site est un dépôt git : .git contient l'URL du dépôt et, si le dépôt
    # est privé, il ne doit surtout pas être servi.
    location ~ /\.git {
        deny all;
        return 404;
    }

    # Un lien de séance partagé (?w=…) est index.html avec une query string :
    # toute navigation retombe sur le document, l'app lit l'URL elle-même.
    location / {
        try_files \$uri \$uri/ /index.html;
    }

    # Le service worker pilote lui-même le cache de l'app. Figé dans le cache
    # HTTP, il empêcherait toute mise à jour d'atteindre le visiteur.
    location = /sw.js {
        add_header Cache-Control "no-cache, no-store, must-revalidate" always;
        add_header Service-Worker-Allowed "/" always;
    }

    location = /index.html {
        add_header Cache-Control "no-cache" always;
    }

    location ~* \.(js|css|json|txt|webmanifest)\$ {
        add_header Cache-Control "no-cache" always;
        add_header X-Content-Type-Options "nosniff" always;
    }

    # .wav est absent des types par défaut de nginx : sans ça les sons du
    # timer partent en application/octet-stream. Ce bloc doit précéder celui
    # des médias : le premier regex qui matche gagne.
    location ~* \.wav\$ {
        default_type audio/wav;
        add_header Cache-Control "public, max-age=31536000, immutable" always;
        access_log off;
    }

    # Médias : le contenu ne change jamais sans changer de nom.
    location ~* \.(wav|mp3|png|jpe?g|gif|svg|webp|ico|woff2?)\$ {
        add_header Cache-Control "public, max-age=31536000, immutable" always;
        access_log off;
    }

    add_header X-Content-Type-Options "nosniff" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;

    gzip on;
    gzip_vary on;
    gzip_min_length 1024;
    gzip_types text/plain text/css application/javascript application/json image/svg+xml;
}
NGINXEOF

ln -sfn /etc/nginx/sites-available/tabata /etc/nginx/sites-enabled/tabata
[ -e /etc/nginx/sites-enabled/default ] && rm -f /etc/nginx/sites-enabled/default && ok "vhost « default » retiré"
nginx -t 2>&1 | sed 's/^/  /'
systemctl enable --now nginx >/dev/null 2>&1
systemctl reload nginx
ok "nginx : $(systemctl is-active nginx) / $(systemctl is-enabled nginx)"

# ── 4. Mise à jour automatique ─────────────────────────────────────
say "4/4 · Mise à jour automatique"

cat > /etc/default/cadence-tabata <<DEFEOF
# Lu par /usr/local/bin/tabata-update
TABATA_WEBROOT=$WEBROOT
TABATA_BRANCH=$BRANCH
DEFEOF

cat > /usr/local/bin/tabata-update <<'UPDEOF'
#!/usr/bin/env bash
# Tire la dernière version du site publié. Écrit par install.sh.
set -euo pipefail
. /etc/default/cadence-tabata

cd "$TABATA_WEBROOT"

BEFORE="$(git rev-parse HEAD)"
if ! git fetch --quiet --depth 1 origin "$TABATA_BRANCH" 2>/dev/null; then
  echo "tabata-update : GitHub injoignable — le site reste sur la version en place"
  exit 0
fi

AFTER="$(git rev-parse "origin/$TABATA_BRANCH")"
if [ "$BEFORE" = "$AFTER" ] && [ "${1:-}" != "--force" ]; then
  exit 0
fi

# reset --hard, pas merge : ce dépôt n'est qu'un miroir, il n'a rien à
# fusionner. Toute modification locale est de toute façon une erreur.
git reset --quiet --hard "origin/$TABATA_BRANCH"

# Les fichiers disparus d'un commit à l'autre sont retirés par git, mais pas
# ceux qu'un ancien build avait laissés hors suivi.
git clean --quiet -fd

chown -R www-data:www-data "$TABATA_WEBROOT"
echo "tabata-update : ${BEFORE:0:7} → ${AFTER:0:7} — version $(cat version.txt 2>/dev/null || echo '?')"
UPDEOF

chmod +x /usr/local/bin/tabata-update
bash -n /usr/local/bin/tabata-update || die "Le script de mise à jour généré est invalide."
ok "/usr/local/bin/tabata-update"

# L'ancien modèle (tirage HTTP depuis le Mac, cf. server-setup.sh) écrivait
# dans le même webroot. Les deux se défairaient mutuellement.
if systemctl list-unit-files 2>/dev/null | grep -q '^tabata-rebuild\.timer'; then
  systemctl disable --now tabata-rebuild.timer >/dev/null 2>&1 || true
  warn "timer « tabata-rebuild » désactivé (un seul modèle à la fois)"
fi

cat > /etc/systemd/system/tabata-update.service <<UNITEOF
[Unit]
Description=Met à jour Cadence Tabata depuis GitHub
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=/usr/local/bin/tabata-update
UNITEOF

cat > /etc/systemd/system/tabata-update.timer <<TIMEREOF
[Unit]
Description=Vérifie les mises à jour de Cadence Tabata

[Timer]
OnBootSec=60s
OnUnitActiveSec=$INTERVAL
Unit=tabata-update.service

[Install]
WantedBy=timers.target
TIMEREOF

systemctl daemon-reload
systemctl enable --now tabata-update.timer >/dev/null 2>&1
ok "timer actif — au démarrage du CT, puis toutes les $INTERVAL"

# ── Résumé ─────────────────────────────────────────────────────────
IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
STATUS="$(curl -sI --max-time 5 http://127.0.0.1/ 2>/dev/null | head -1 | tr -d '\r' || echo '?')"
cat <<SUMEOF

═══════════════════════════════════════════════════════════════════
 Prêt.  Pointe Nginx Proxy Manager vers  http://${IP}:80
═══════════════════════════════════════════════════════════════════

 Réponse locale : ${STATUS:-aucune}
 Version servie : $(cat "$WEBROOT/version.txt" 2>/dev/null || echo '?')
 Dépôt suivi    : ${REPO} (${BRANCH})
 Mise à jour    : au démarrage, puis toutes les ${INTERVAL}

 Déployer       : republier le dépôt — le CT suit tout seul
 Forcer         : tabata-update --force
 Journal        : journalctl -u tabata-update -n 40 --no-pager
 État du timer  : systemctl list-timers tabata-update
SUMEOF
