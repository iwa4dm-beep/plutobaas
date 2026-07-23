#!/usr/bin/env bash
# detect-envs.sh — Auto-detect which .env file each Pluto service is using.
# Walks systemd units, docker compose files, and running processes and prints
# the resolved .env path plus which service consumes it.
#
# Usage: sudo bash detect-envs.sh
set -uo pipefail

hr(){ printf '\n\033[1;36m── %s ──\033[0m\n' "$1"; }
row(){ printf '  %-30s → %s\n' "$1" "$2"; }

hr "1. systemd units with EnvironmentFile="
if command -v systemctl >/dev/null; then
  for u in $(systemctl list-unit-files --type=service --no-legend 2>/dev/null | awk '{print $1}' | grep -Ei 'pluto|sandbox|dashboard|app|api'); do
    envs=$(systemctl show "$u" -p EnvironmentFiles --value 2>/dev/null | tr ' ' '\n' | sed 's|^-||' | grep -v '^$' || true)
    active=$(systemctl is-active "$u" 2>/dev/null || echo inactive)
    if [[ -n "$envs" ]]; then
      while IFS= read -r e; do
        row "$u [$active]" "$e $( [[ -f "$e" ]] && echo "" || echo "(MISSING)")"
      done <<< "$envs"
    else
      row "$u [$active]" "(no EnvironmentFile)"
    fi
  done
fi

hr "2. docker compose stacks + resolved --env-file"
for cf in $(find /root /opt /srv -maxdepth 5 -name 'docker-compose*.yml' 2>/dev/null); do
  dir=$(dirname "$cf")
  envf=""
  [[ -f "$dir/.env" ]] && envf="$dir/.env"
  # Look for --env-file in nearby shell scripts
  hint=$(grep -RhoE -- '--env-file[= ][^ ]+' "$dir" 2>/dev/null | head -1 | awk '{print $NF}' | tr -d '=' || true)
  [[ -n "$hint" && -f "$hint" ]] && envf="$hint"
  row "$cf" "${envf:-(no .env found)}"
done

hr "3. running node/bun processes and their cwd .env"
for pid in $(pgrep -f 'node|bun' 2>/dev/null); do
  cwd=$(readlink -f "/proc/$pid/cwd" 2>/dev/null || echo "?")
  cmd=$(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null | cut -c1-80)
  [[ "$cwd" = "?" ]] && continue
  envf=""
  [[ -f "$cwd/.env" ]] && envf="$cwd/.env"
  row "pid=$pid $cmd" "${envf:-(no .env in cwd $cwd)}"
done | sort -u

hr "4. every .env discovered on disk"
find /root /opt /srv /var/www -maxdepth 6 -name '.env' -not -path '*/node_modules/*' 2>/dev/null | while read -r f; do
  size=$(wc -c < "$f" 2>/dev/null || echo 0)
  keys=$(grep -cE '^[A-Z][A-Z0-9_]*=' "$f" 2>/dev/null || echo 0)
  row "$f" "${size}B, ${keys} keys"
done

echo
echo "Tip: edit the .env for the service you care about, then:"
echo "  systemctl restart <unit>              # systemd services"
echo "  docker compose --env-file <path> up -d # docker stacks"
