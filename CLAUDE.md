# push-hub

## Deploy & branch policy

**`prod` is fast-forward only.** Promote to prod with `git push origin main:prod`. Never commit directly to `prod`, and never create a merge commit on it — `prod` must always be a strict fast-forward of `main`.

**Deploys go only through the deploy gate.** The deploy job is `tayl0r/vps-deploy`, pinned by full commit SHA. It logs in with the `VPS_*` secrets and can only redeploy this app: the server picks the image from its own compose and the migration from the vps app manifest, so never pass either from the workflow. Bump the pin only after reading its diff, and never add another way of SSHing to the server. A failed deploy says why in the job log's `VPS deploy` error, and on the gate's `deploy-gate:` line when the gate ran. Exit 2 (refused) also pages Taylor as a possible leaked deploy key, so find out why before re-running it.

## Data safety

**Backups keep deleted data for up to 6 months.** This app's database is backed up hourly to the owner's Google Drive, encrypted, and kept for up to 6 months (vps `DEPLOY.md` § Backups). Anything user-facing that promises deletion (a privacy page, a delete-account flow, an email) must say that deleted data also leaves the backups within 6 months, never that no copy is kept.
