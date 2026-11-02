#!/usr/bin/env bash
set -euo pipefail

# ──────────────────────────────────────────────────────
# IP-Cam-Master Installer (Proxmox Host)
# Usage: curl -fsSL https://raw.githubusercontent.com/meintechblog/ip-cam-master/main/install.sh | bash
#
# This script runs on the Proxmox host and creates a
# Debian 12 VM with the app fully provisioned inside it.
# ──────────────────────────────────────────────────────

# ── Parse flags ───────────────────────────────────────

AUTO_YES=false
for arg in "$@"; do
  case "$arg" in
    --yes|-y) AUTO_YES=true ;;
  esac
done

# ── Constants ─────────────────────────────────────────

VM_NAME="ip-cam-master"
VM_TAG="ip-cam-master"
REPO_URL="https://github.com/meintechblog/ip-cam-master.git"
APP_DIR="/opt/ip-cam-master"
PVE_USER="ipcm@pve"
PVE_TOKEN_NAME="ipcm"
PVE_ROLE="IPCamMaster"
IMG_URL="https://cloud.debian.org/images/cloud/trixie/latest/debian-13-genericcloud-amd64.qcow2"
IMG_CACHE="/var/lib/vz/template/iso/debian-13-genericcloud-amd64.qcow2"
INSTALLER_KEY="/root/.ssh/ipcm_installer"
SERVICE_NAME="ip-cam-master"

# ── Helpers ───────────────────────────────────────────

banner() {
  echo ""
  echo "======================================"
  echo "  IP-Cam-Master Installer"
  echo "======================================"
  echo ""
}

step() {
  echo ">> $1"
}

error_exit() {
  echo ""
  echo "FEHLER: $1" >&2
  exit 1
}

confirm() {
  if [ "$AUTO_YES" = true ]; then
    echo "$1 y (--yes)"
    return 0
  fi
  # read from /dev/tty so it works with curl|bash (stdin is the script)
  if [ -e /dev/tty ]; then
    read -rp "$1 " REPLY < /dev/tty
  else
    read -rp "$1 " REPLY
  fi
  case "${REPLY,,}" in
    y|yes) return 0 ;;
    *) echo "Abgebrochen."; exit 0 ;;
  esac
}

# ── VM Detection ──────────────────────────────────────

detect_existing_vm() {
  pvesh get /cluster/resources --type vm --output-format json 2>/dev/null \
    | jq -r '.[] | select(.type=="qemu" and .tags!=null and (.tags | contains("ip-cam-master"))) | .vmid' \
    | head -1
}

get_vm_ip() {
  local vmid="$1"
  local max=60
  local i=0

  # Get VM's MAC address from config
  local mac
  mac=$(qm config "$vmid" | grep -oP 'virtio=\K[A-Fa-f0-9:]+' | head -1)
  if [ -z "$mac" ]; then
    error_exit "Konnte MAC-Adresse fuer VM $vmid nicht ermitteln."
  fi
  mac=$(echo "$mac" | tr '[:upper:]' '[:lower:]')

  while [ $i -lt $max ]; do
    # Method 1: Try qm guest agent (if running)
    local ip
    ip=$(qm agent "$vmid" network-get-interfaces 2>/dev/null \
      | jq -r '.[] | select(.name != "lo") | .["ip-addresses"][]? | select(.["ip-address-type"] == "ipv4") | .["ip-address"]' \
      | head -1) || true
    if [ -n "$ip" ] && [ "$ip" != "null" ]; then
      echo "$ip"
      return 0
    fi

    # Method 2: ARP table lookup by MAC (IPv4 only — skip fe80:: link-local)
    ip=$(ip neigh show 2>/dev/null | grep -i "$mac" | awk '{print $1}' | grep -v '^fe80' | grep '\.' | head -1) || true
    if [ -n "$ip" ]; then
      echo "$ip"
      return 0
    fi

    # Method 3: arp command fallback
    ip=$(arp -an 2>/dev/null | grep -i "$mac" | grep -oP '\(\K[0-9.]+' | head -1) || true
    if [ -n "$ip" ]; then
      echo "$ip"
      return 0
    fi

    # Ping broadcast to populate ARP table
    if [ $((i % 6)) -eq 5 ]; then
      local subnet
      subnet=$(ip -4 addr show vmbr0 2>/dev/null | grep -oP 'inet \K[0-9.]+' | head -1)
      if [ -n "$subnet" ]; then
        ping -c 1 -b "${subnet%.*}.255" >/dev/null 2>&1 || true
      fi
    fi

    i=$((i + 1))
    sleep 5
  done
  error_exit "Konnte keine IP-Adresse fuer VM $vmid ermitteln (Timeout nach $((max * 5))s). MAC: $mac"
}

wait_for_ssh() {
  local ip="$1"
  local max=30
  local i=0

  while [ $i -lt $max ]; do
    if ssh -o StrictHostKeyChecking=no -o ConnectTimeout=3 -o BatchMode=yes \
         -i "$INSTALLER_KEY" root@"$ip" "echo ok" >/dev/null 2>&1; then
      return 0
    fi
    i=$((i + 1))
    sleep 5
  done
  error_exit "SSH-Zugriff auf $ip nicht moeglich (Timeout nach $((max * 5))s)."
}

# ── Cleanup trap for fresh install ────────────────────

CREATED_VMID=""
cleanup_on_failure() {
  if [ -n "$CREATED_VMID" ]; then
    echo ""
    echo ">> Raeume fehlgeschlagene Installation auf (VM $CREATED_VMID)..."
    qm stop "$CREATED_VMID" 2>/dev/null || true
    qm destroy "$CREATED_VMID" --purge 2>/dev/null || true
  fi
  error_exit "Installation abgebrochen. Pruefe die Ausgabe oben."
}

# ── Fresh Install ─────────────────────────────────────

fresh_install() {
  trap cleanup_on_failure ERR

  # Hardware check: VAAPI required for video transcoding
  if [ ! -e /dev/dri/renderD128 ]; then
    echo ""
    echo "========================================"
    echo "  FEHLER: Keine VAAPI-Hardware gefunden"
    echo "========================================"
    echo ""
    echo "  /dev/dri/renderD128 existiert nicht."
    echo ""
    echo "  IP-Cam-Master benoetigt eine Intel GPU mit VAAPI-Support"
    echo "  fuer die Hardware-Transcodierung (MJPEG → H.264)."
    echo "  Ohne passende GPU funktioniert die Kamera-Pipeline nicht."
    echo ""
    echo "  Unterstuetzte Plattformen:"
    echo "    - Intel Core (6. Generation+) / Xeon E3 v5+"
    echo "    - Intel Atom (Apollo Lake, Gemini Lake, Jasper Lake)"
    echo "    - Intel N-Series (N95, N100, N200, N305)"
    echo ""
    error_exit "Installation abgebrochen. Bitte nutze einen Host mit Intel GPU."
  fi
  step "VAAPI-Hardware erkannt: /dev/dri/renderD128"

  # Security warning (D-07, D-09)
  echo "WARNUNG: Dieses Skript wird:"
  echo "  - Eine VM auf diesem Proxmox-Host erstellen"
  echo "  - Einen API-Token fuer die VM erstellen"
  echo "  - Der VM SSH-Zugriff auf diesen Host geben"
  echo ""
  confirm "Moechtest du fortfahren? (y/N)"

  # Detect storage (Pitfall 1)
  NODE=$(hostname)
  STORAGE=$(pvesh get /nodes/"$NODE"/storage --output-format json \
    | jq -r '[.[] | select(.content | contains("images"))] | .[0].storage')
  if [ -z "$STORAGE" ] || [ "$STORAGE" = "null" ]; then
    error_exit "Kein passender Storage gefunden."
  fi
  step "Verwende Storage: $STORAGE"

  # Download Debian 13 cloud image for VM (cached)
  if [ ! -f "$IMG_CACHE" ]; then
    step "Lade Debian 13 Cloud-Image herunter..."
    wget -q --show-progress "$IMG_URL" -O "$IMG_CACHE"
  else
    step "Debian 13 Cloud-Image bereits vorhanden (Cache)."
  fi

  # Pre-download Debian 13 LXC template for camera containers
  LXC_TEMPLATE="debian-13-standard_13.1-2_amd64.tar.zst"
  if [ ! -f "/var/lib/vz/template/cache/$LXC_TEMPLATE" ]; then
    step "Lade Debian 13 LXC-Template herunter..."
    pveam download local "$LXC_TEMPLATE" || true
  fi

  # Get next VMID
  VMID=$(pvesh get /cluster/nextid)
  CREATED_VMID="$VMID"

  # Create VM (D-10, D-11)
  step "Erstelle VM $VMID ($VM_NAME)..."
  qm create "$VMID" \
    --name "$VM_NAME" \
    --tags "$VM_TAG" \
    --memory 2048 --cores 2 \
    --net0 virtio,bridge=vmbr0 \
    --scsihw virtio-scsi-pci \
    --ostype l26 \
    --agent enabled=1

  # Import disk + cloud-init
  step "Importiere Disk und konfiguriere Cloud-Init..."
  qm set "$VMID" --scsi0 "$STORAGE:0,import-from=$IMG_CACHE"
  qm set "$VMID" --ide2 "$STORAGE:cloudinit"
  qm set "$VMID" --boot order=scsi0
  qm set "$VMID" --serial0 socket --vga serial0
  qm disk resize "$VMID" scsi0 10G

  # Generate installer SSH key if needed
  if [ ! -f "$INSTALLER_KEY" ]; then
    step "Generiere Installer-SSH-Key..."
    mkdir -p /root/.ssh
    ssh-keygen -t ed25519 -f "$INSTALLER_KEY" -N "" -q
  fi

  # Determine network config
  HOST_IP=$(hostname -I | awk '{print $1}')
  GATEWAY=$(ip route | grep default | awk '{print $3}' | head -1)
  SUBNET_PREFIX="${HOST_IP%.*}"
  NAMESERVER=$(grep nameserver /etc/resolv.conf | head -1 | awk '{print $2}')

  # Find a free IP in the same subnet (start from .250 downward)
  VM_IP=""
  for last_octet in $(seq 250 -1 230); do
    candidate="${SUBNET_PREFIX}.${last_octet}"
    if ! ping -c 1 -W 1 "$candidate" >/dev/null 2>&1; then
      VM_IP="$candidate"
      break
    fi
  done
  if [ -z "$VM_IP" ]; then
    error_exit "Keine freie IP-Adresse im Bereich ${SUBNET_PREFIX}.230-250 gefunden."
  fi
  step "VM bekommt statische IP: $VM_IP"

  # Cloud-init config with static IP
  qm set "$VMID" --ciuser root
  qm set "$VMID" --sshkeys "${INSTALLER_KEY}.pub"
  qm set "$VMID" --ipconfig0 "ip=${VM_IP}/24,gw=${GATEWAY}"
  if [ -n "$NAMESERVER" ]; then
    qm set "$VMID" --nameserver "$NAMESERVER"
  fi

  # Clear stale known_hosts entry for this IP (VM was just created, old key is invalid)
  ssh-keygen -f /root/.ssh/known_hosts -R "$VM_IP" 2>/dev/null || true

  # Start VM + wait for SSH
  step "Starte VM..."
  qm start "$VMID"
  step "VM-IP: $VM_IP — warte auf SSH..."
  step "Warte auf SSH-Zugriff..."
  wait_for_ssh "$VM_IP"

  # Provision app inside VM via SSH (D-12, D-17, D-18, D-19, D-20, D-21)
  step "Provisioniere App in der VM..."
  VM_PUBKEY=$(ssh -o StrictHostKeyChecking=no -o BatchMode=yes -i "$INSTALLER_KEY" root@"$VM_IP" bash <<'PROVISION_SCRIPT'
set -euo pipefail
export LC_ALL=C

# Wait for cloud-init to finish (filesystem resize, network config, etc.)
if command -v cloud-init &>/dev/null; then
  cloud-init status --wait 2>/dev/null || true
fi

# Install system dependencies
apt-get update -qq
apt-get install -y -qq curl git ffmpeg qemu-guest-agent 2>&1

# Enable and start guest agent
systemctl enable qemu-guest-agent 2>/dev/null || true
systemctl start qemu-guest-agent 2>/dev/null || true

# Node.js 22 LTS via NodeSource
if ! command -v node &>/dev/null || [ "$(node -v | cut -d. -f1 | tr -d v)" -lt 22 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - 2>&1
  apt-get install -y -qq nodejs 2>&1
fi

# Clone repo
git clone https://github.com/meintechblog/ip-cam-master.git /opt/ip-cam-master
cd /opt/ip-cam-master

# Full npm install (drizzle-kit and vite are devDependencies needed for build and DB push)
npm install

# Create data directory
mkdir -p data

# Generate .env with random DB_ENCRYPTION_KEY (D-19)
DB_ENCRYPTION_KEY=$(openssl rand -hex 32)
cat > .env <<EOF
# Auto-generated by IP-Cam-Master installer
DB_ENCRYPTION_KEY=$DB_ENCRYPTION_KEY
EOF

# Build
npm run build

# DB migration (D-21)
npx drizzle-kit push

# Prune devDependencies after build and DB push
npm prune --omit=dev

# systemd service
cp ip-cam-master.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable ip-cam-master

# Generate VM-to-host SSH key (D-14)
mkdir -p /root/.ssh
ssh-keygen -t ed25519 -f /root/.ssh/ip-cam-master -N "" -q
cat /root/.ssh/ip-cam-master.pub
PROVISION_SCRIPT
  )

  # Add VM's public key to host's authorized_keys (D-15)
  step "Fuege VM-SSH-Key zum Host hinzu..."
  mkdir -p /root/.ssh
  echo "$VM_PUBKEY" >> /root/.ssh/authorized_keys

  # Create API token (D-08)
  step "Erstelle API-Token..."

  # Create user
  pveum user add "$PVE_USER" --comment "IP-Cam-Master service account" 2>/dev/null || true

  # Create role with minimal permissions
  pveum role add "$PVE_ROLE" --privs \
    "VM.Allocate,VM.Audit,VM.Config.Disk,VM.Config.CPU,VM.Config.Memory,VM.Config.Network,VM.Config.Options,VM.PowerMgmt,VM.Console,Datastore.AllocateSpace,Datastore.Audit,SDN.Use" \
    2>/dev/null || pveum role modify "$PVE_ROLE" --privs \
    "VM.Allocate,VM.Audit,VM.Config.Disk,VM.Config.CPU,VM.Config.Memory,VM.Config.Network,VM.Config.Options,VM.PowerMgmt,VM.Console,Datastore.AllocateSpace,Datastore.Audit,SDN.Use"

  # Delete existing token if any
  pveum user token remove "$PVE_USER" "$PVE_TOKEN_NAME" 2>/dev/null || true

  # Create token
  TOKEN_OUTPUT=$(pveum user token add "$PVE_USER" "$PVE_TOKEN_NAME" --privsep 1 --output-format json)
  TOKEN_SECRET=$(echo "$TOKEN_OUTPUT" | jq -r '.value // .data.value // empty')
  if [ -z "$TOKEN_SECRET" ]; then
    error_exit "API-Token konnte nicht erstellt werden."
  fi
  TOKEN_ID="${PVE_USER}!${PVE_TOKEN_NAME}"

  # Set ACLs (token needs / for listing, /nodes for container ops, /storage for disk allocation)
  pveum acl modify / --user "$PVE_USER" --role "$PVE_ROLE"
  pvesh set /access/acl --path / --tokens "$TOKEN_ID" --roles "$PVE_ROLE"
  pvesh set /access/acl --path "/nodes/$NODE" --tokens "$TOKEN_ID" --roles "$PVE_ROLE"
  pvesh set /access/acl --path /storage --tokens "$TOKEN_ID" --roles "$PVE_ROLE"

  # Start service and inject settings via app API (D-08)
  step "Starte App und uebertrage Proxmox-Konfiguration..."
  ssh -o StrictHostKeyChecking=no -o BatchMode=yes -i "$INSTALLER_KEY" root@"$VM_IP" \
    "systemctl start ip-cam-master"

  # Wait for the app to be ready
  step "Warte auf App-Start..."
  for i in $(seq 1 30); do
    if curl -sf "http://${VM_IP}/api/settings" >/dev/null 2>&1; then break; fi
    sleep 2
  done

  HOST_IP=$(hostname -I | awk '{print $1}')

  # Inject settings via the app's API (handles encryption for sensitive keys)
  curl -sf -X PUT "http://${VM_IP}/api/settings" \
    -H "Content-Type: application/json" \
    -d "{
      \"proxmox_host\": \"${HOST_IP}\",
      \"proxmox_token_id\": \"${TOKEN_ID}\",
      \"proxmox_token_secret\": \"${TOKEN_SECRET}\",
      \"proxmox_ssh_host\": \"${HOST_IP}\",
      \"proxmox_ssh_user\": \"root\",
      \"proxmox_ssh_key_path\": \"/root/.ssh/ip-cam-master\"
    }" >/dev/null 2>&1

  # Clear trap on success
  CREATED_VMID=""
  trap - ERR

  # Success message
  echo ""
  echo "======================================"
  echo "  Installation erfolgreich!"
  echo "  IP-Cam-Master: http://${VM_IP}"
  echo "  VM-ID: ${VMID}"
  echo "======================================"
  echo ""
}

# ── Update ────────────────────────────────────────────

update_vm() {
  local vmid="$1"

  step "Ermittle VM-IP..."
  VM_IP=$(get_vm_ip "$vmid")
  step "VM-IP: $VM_IP"

  # Ensure installer key exists
  if [ ! -f "$INSTALLER_KEY" ]; then
    error_exit "Installer-SSH-Key nicht gefunden: $INSTALLER_KEY. Wurde die Installation mit diesem Script durchgefuehrt?"
  fi

  step "Aktualisiere App in VM $vmid..."
  ssh -o StrictHostKeyChecking=no -o BatchMode=yes -i "$INSTALLER_KEY" root@"$VM_IP" bash <<'UPDATE_SCRIPT'
set -euo pipefail

cd /opt/ip-cam-master

# Stop service
systemctl stop ip-cam-master || true

# Pull latest
git pull

# Full npm install (drizzle-kit and vite are devDependencies needed for build and DB push)
npm install

# Build
npm run build

# DB migration (D-21)
npx drizzle-kit push

# Prune devDependencies after build and DB push
npm prune --omit=dev

# Update service file
cp ip-cam-master.service /etc/systemd/system/
systemctl daemon-reload

# Start service
systemctl start ip-cam-master
UPDATE_SCRIPT

  # Check if API token still works (D-06)
  step "Pruefe API-Token..."
  NODE=$(hostname)
  TOKEN_ID="${PVE_USER}!${PVE_TOKEN_NAME}"

  # Try the token via the app's settings API
  if ! curl -sf "http://${VM_IP}/api/settings" >/dev/null 2>&1; then
    step "App antwortet nicht. Warte auf Neustart..."
    for i in $(seq 1 30); do
      if curl -sf "http://${VM_IP}/api/settings" >/dev/null 2>&1; then break; fi
      sleep 2
    done
  fi

  echo ""
  echo "======================================"
  echo "  Update erfolgreich."
  echo "  IP-Cam-Master: http://${VM_IP}"
  echo "  VM-ID: ${vmid}"
  echo "======================================"
  echo ""
}

# ── Remove ────────────────────────────────────────────

remove_vm() {
  local vmid="$1"

  confirm "VM $vmid und alle Daten werden geloescht. Fortfahren? (y/N)"

  step "Stoppe VM $vmid..."
  qm stop "$vmid" 2>/dev/null || true
  sleep 3

  step "Zerstoere VM $vmid..."
  qm destroy "$vmid" --purge

  # Remove API user/token
  step "Entferne API-Token und Benutzer..."
  pveum user token remove "$PVE_USER" "$PVE_TOKEN_NAME" 2>/dev/null || true
  pveum user delete "$PVE_USER" 2>/dev/null || true

  # Remove role
  pveum role delete "$PVE_ROLE" 2>/dev/null || true

  # Clean up installer SSH key
  if [ -f "$INSTALLER_KEY" ]; then
    step "Entferne Installer-SSH-Key..."
    rm -f "$INSTALLER_KEY" "${INSTALLER_KEY}.pub"
  fi

  echo ""
  echo "======================================"
  echo "  Deinstallation erfolgreich."
  echo "  VM $vmid und Konfiguration entfernt."
  echo "======================================"
  echo ""
}

# ── Pre-checks ────────────────────────────────────────

banner

if [ "$(id -u)" -ne 0 ]; then
  error_exit "Dieses Skript muss als root ausgefuehrt werden."
fi

if ! command -v pvesh &>/dev/null; then
  error_exit "Dieses Skript muss auf einem Proxmox-Host ausgefuehrt werden."
fi

# Ensure jq is installed
apt-get install -y -qq jq 2>/dev/null || true

# ── Mode Detection (D-02, D-05) ──────────────────────

EXISTING_VMID=$(detect_existing_vm)
if [ -n "$EXISTING_VMID" ]; then
  echo "Bestehende Installation gefunden (VM $EXISTING_VMID)."
  echo ""
  echo "  [U] Update — Neueste Version installieren"
  echo "  [R] Remove — VM und Konfiguration entfernen"
  echo "  [C] Cancel — Abbrechen"
  echo ""
  if [ "$AUTO_YES" = true ]; then
    CHOICE="u"
    echo "Auswahl [U/R/C]: u (--yes)"
  elif [ -e /dev/tty ]; then
    read -rp "Auswahl [U/R/C]: " CHOICE < /dev/tty
  else
    read -rp "Auswahl [U/R/C]: " CHOICE
  fi
  case "${CHOICE,,}" in
    u) MODE="update" ;;
    r) MODE="remove" ;;
    *) echo "Abgebrochen."; exit 0 ;;
  esac
else
  MODE="install"
fi

# ── Main ──────────────────────────────────────────────

case "$MODE" in
  install) fresh_install ;;
  update)  update_vm "$EXISTING_VMID" ;;
  remove)  remove_vm "$EXISTING_VMID" ;;
esac
