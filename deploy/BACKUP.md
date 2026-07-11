# World Saves — Backup & Restore

`deploy/backup` is a small POSIX `sh` tool that archives and restores the
Loomfall server's world saves. No dependencies beyond `tar`, `gzip`, and a
POSIX shell.

## Where saves live

The server persists **one JSON file per world**:

```
<repo>/saves/<id>.json
```

`<repo>/saves` is the default (`SAVES_DIR = server/../saves` in
`server/index.js`). Each file holds a world's metadata and its full edit log
(`{ id, name, seed, createdAt, edits }`). Deleting a world's JSON deletes that
world; the entire game state is contained in this directory.

If the server is later run with a `WORLD_DIR` environment variable, the backup
tool honors it automatically — `WORLD_DIR` overrides the default saves path for
both `backup` and `restore`. (The server does not read `WORLD_DIR` yet; the tool
is ready for when the builder wires it.)

## Is it safe to back up a running server?

Yes, for routine backups. The server writes each world with an **atomic
tmp-file + rename** (`server/index.js`), so a reader — including `tar` — never
observes a half-written JSON file. Writes are also debounced, and copying during
a debounced write is fine precisely *because* the final write is atomic.

For a strictly consistent point-in-time snapshot across all worlds, briefly
**pause writes** — stop the server, or take a filesystem/volume snapshot (LVM,
ZFS, or your cloud provider's disk snapshot) and back up from that.

## Usage

```
deploy/backup backup  [--dir <saves>] [--out <backupdir>] [--timestamp <ts>]
deploy/backup restore <archive> [--dir <saves>] [--force]
deploy/backup list    [--backupdir <backupdir>]
deploy/backup --help
```

### backup

Tars + gzips the saves directory into a timestamped archive, verifies it
(`gzip -t` and `tar -tzf`), and prints the archive path to **stdout**.

```sh
# Back up the default <repo>/saves into <repo>/backups
deploy/backup backup

# Explicit dirs
deploy/backup backup --dir /srv/loomfall/saves --out /var/backups/loomfall

# Capture the printed path for scripting
ARCHIVE=$(deploy/backup backup)
echo "created $ARCHIVE"
```

Archives are named `saves-YYYYmmdd-HHMMSS.tar.gz` (UTC). Override the stamp with
`--timestamp` if you want to align it with an external job id.

Default backup directory is `<repo>/backups` (override with `--out` or the
`BACKUP_DIR` env var).

### restore

Safely restores an archive over the saves directory:

1. Validates the archive (`gzip -t`, `tar -tzf`).
2. If the target saves dir is **non-empty**, it first backs up the current
   state to `<saves>.pre-restore-<ts>.tar.gz`. If that pre-backup fails, restore
   **aborts** rather than clobbering live data (use `--force` to override).
3. Extracts into a staging dir, then swaps the contents into place.

```sh
deploy/backup restore /var/backups/loomfall/saves-20260711-030000.tar.gz
deploy/backup restore ./saves-20260711-030000.tar.gz --dir /srv/loomfall/saves
```

Recommended procedure:

```sh
# 1. Stop the server (so it isn't writing during the swap)
#    e.g. systemctl stop loomfall   OR   docker compose down
# 2. Restore
deploy/backup restore /var/backups/loomfall/saves-20260711-030000.tar.gz
# 3. Start the server again
#    systemctl start loomfall   OR   docker compose up -d
```

The pre-restore backup is your undo: if a restore was wrong, restore *that*
file instead.

### list

Lists archives in the backup directory, newest first:

```sh
deploy/backup list
deploy/backup list --backupdir /var/backups/loomfall
```

## Cron example (daily at 03:00)

```cron
# m h dom mon dow  command
0 3 * * *  /home/user/MinecraftV2/deploy/backup backup >> /var/log/loomfall-backup.log 2>&1
```

Prune old archives (keep ~14 days) with a companion line:

```cron
30 3 * * *  find /home/user/MinecraftV2/backups -name 'saves-*.tar.gz' -mtime +14 -delete
```

If you set a custom saves location, export it for cron:

```cron
0 3 * * *  WORLD_DIR=/srv/loomfall/saves BACKUP_DIR=/var/backups/loomfall /home/user/MinecraftV2/deploy/backup backup
```

## Off-box copies

A backup on the same disk as the server is not a backup. Ship archives
off-box after each run.

**rsync** (to another host):

```sh
rsync -av --delete /home/user/MinecraftV2/backups/ backup-host:/data/loomfall-backups/
```

**scp** (single archive):

```sh
ARCHIVE=$(deploy/backup backup)
scp "$ARCHIVE" backup-host:/data/loomfall-backups/
```

**S3 / object storage** (AWS CLI):

```sh
ARCHIVE=$(deploy/backup backup)
aws s3 cp "$ARCHIVE" s3://my-bucket/loomfall/ --storage-class STANDARD_IA
# or mirror the whole backup dir
aws s3 sync /home/user/MinecraftV2/backups/ s3://my-bucket/loomfall/
```

Combine with cron to get automated, rotated, off-box backups. Test restores
periodically — an untested backup is only a hypothesis.
