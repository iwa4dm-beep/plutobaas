#!/usr/bin/env sh
# Mint fresh secrets for a new Pluto instance.
# Usage:  ./scripts/gen-secrets.sh > .env
set -e
gen() { openssl rand -hex 32; }
prefix_key() { printf '%s_%s\n' "$1" "$(openssl rand -hex 24)"; }

cat <<EOF
DOMAIN=api.example.com
ACME_EMAIL=admin@example.com
POSTGRES_PASSWORD=$(gen)
JWT_SECRET=$(gen)
ANON_KEY=$(prefix_key pk_anon)
SERVICE_ROLE_KEY=$(prefix_key sk_service)
STORAGE_DRIVER=s3
S3_ENDPOINT=http://minio:9000
S3_ACCESS_KEY=minioadmin
S3_SECRET_KEY=$(gen)
S3_BUCKET=pluto
S3_REGION=us-east-1
SMTP_URL=smtp://user:pass@smtp.example.com:587
EOF
