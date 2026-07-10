# Pluto Backup & Restore — Automated

সব স্ক্রিপ্ট এই ফোল্ডারে; systemd দিয়ে দৈনিক চালানো, checksums+manifest দিয়ে
integrity যাচাই, encrypted download এবং one-command restore/rollback।

## ফাইলগুলো এক নজরে

| File | কাজ |
|---|---|
| `daily-backup.sh` | VPS-এ চলে: slim zip + pg_dump + configs + checksum + manifest + restore-verify + prune |
| `pull-latest.sh` | লোকাল মেশিনে চলে: rsync দিয়ে newest N ফাইল টেনে আনে + লোকাল prune + checksum |
| `verify-manifest.sh` | manifest.json ব্যবহার করে ডাউনলোড ফাইলের SHA256 যাচাই |
| `one-command-restore.sh` | VPS-এ চলে: upload → extract → configs → DB → restart, + `ROLLBACK=1` সাপোর্ট |
| `install-backup-systemd.sh` | systemd service + timer + secret file ইনস্টল |
| `../systemd/pluto-backup.{service,timer}` | দৈনিক ৩:১৫ UTC-তে auto backup |

## ১. VPS-এ ইনস্টল (একবার)

```bash
cd /root/backend-joy/pluto-backend
bash deploy/backup/install-backup-systemd.sh
```

এটি করবে:
- `/opt/pluto/deploy/backup/` এ স্ক্রিপ্টগুলো কপি
- `/etc/pluto-backup.env` (non-secret config) তৈরি
- `/etc/pluto-backup.secret` (mode 0600) এ random passphrase generate
- `pluto-backup.timer` enable — দৈনিক ৩:১৫ UTC চলবে

**⚠ যে passphrase কনসোলে print হবে সেটা password manager-এ সেভ করুন** — না হলে encrypted backup আর decrypt হবে না।

## ২. এখনই একবার চালিয়ে দেখুন

```bash
systemctl start pluto-backup.service
journalctl -u pluto-backup -f
tail -f /var/log/pluto-backup/backup-*.log
ls -lh /var/backups/pluto/{zip,db,config,manifest}/
```

সফল হলে `manifest-<STAMP>.json` এ `"status": "ok"` এবং `restore_verify.entries > 0`।

## ৩. লোকাল মেশিনে newest N ফাইল অটো ডাউনলোড

লোকাল crontab-এ (macOS/Linux):

```cron
0 5 * * *  VPS=root@YOUR_VPS_IP KEEP=7 \
  bash ~/pluto-backend/deploy/backup/pull-latest.sh \
  >> ~/pluto-backups/pull.log 2>&1
```

শুধু newest `KEEP` টা zip / dump / config / manifest নামাবে, বাকিগুলো লোকালেও prune হবে — ডিস্ক bounded থাকবে।

## ৪. ডাউনলোড করা ZIP integrity যাচাই

```bash
cd ~/pluto-backups/manifest
bash ~/pluto-backend/deploy/backup/verify-manifest.sh manifest-20260710T031500Z.json
```

প্রতিটি artifact-এর SHA256 manifest-এর সাথে মিলিয়ে ✔/✘ রিপোর্ট দেবে।

## ৫. এক-কমান্ড VPS Restore

VPS-এ ZIP আপলোড করে:

```bash
# encrypted হলে passphrase env-এ দিন
export BACKUP_PASSPHRASE='<same-passphrase>'

bash /opt/pluto/deploy/backup/one-command-restore.sh \
  /root/restore/pluto-complete-20260710T031500Z.zip.enc \
  /root/restore/pluto-db-20260710T031500Z.dump.enc \
  /root/restore/pluto-config-20260710T031500Z.tar.gz.enc
```

স্ক্রিপ্ট ধাপে ধাপে করে:
1. **pre-restore snapshot** → `/var/backups/pluto/rollback/snap-<STAMP>.*`
2. `.enc` হলে decrypt
3. পুরনো `$PROJECT_DIR` কে `.old-<STAMP>` নামে রেখে zip extract
4. server config tarball → `/` এ extract + `daemon-reload`
5. `pg_restore --list` দিয়ে verify → তারপর restore
6. `systemctl restart pluto-backend`, nginx reload, `/v1/health` polling

### Rollback (যদি restore পরে সমস্যা হয়)

```bash
ROLLBACK=1 bash /opt/pluto/deploy/backup/one-command-restore.sh
```

সর্বশেষ pre-restore snapshot থেকে configs + DB ফিরিয়ে আনে ও সার্ভিস restart করে।

## নিরাপত্তা নোট

- **Passphrase কখনো স্ক্রিপ্টে বা git-এ commit করবেন না।** systemd `EnvironmentFile=/etc/pluto-backup.secret` (mode 0600) থেকে load হয়; ম্যানুয়াল রানের সময় `export BACKUP_PASSPHRASE=...` করুন।
- Encryption: **AES-256-CBC + PBKDF2 (200k iterations) + random salt** (`openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt`)।
- systemd unit-এ `ProtectSystem=full`, `PrivateTmp=yes`, `NoNewPrivileges=yes` — passphrase journal-এ leak হবে না।
- Restore snapshot-গুলো `/var/backups/pluto/rollback/` এ থাকে — চাইলে `find ... -mtime +30 -delete` cron যোগ করুন।

## ট্রাবলশুট

| উপসর্গ | কারণ | সমাধান |
|---|---|---|
| `pg_restore --list rejected the dump` | pg_dump interrupt/disk full | `docker logs pluto-postgres`, disk check |
| `decrypt failed` | ভুল passphrase | `/etc/pluto-backup.secret` চেক |
| `API did not become healthy` | migration/config mismatch | `ROLLBACK=1 bash one-command-restore.sh` |
| checksum mismatch লোকালে | rsync interrupt | `pull-latest.sh` আবার চালান (`--append-verify` resume করবে) |
