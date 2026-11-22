# The Timescape Site

Player-facing web journal for **The Timescape** TTRPG campaign, built with [Quartz v5](https://quartz.jzhao.xyz/) and synced from the separate Obsidian vault repository.

## Local Development

Set `TIMESCAPE_VAULT` (or pass the path directly) to sync `z_player_facing/` and referenced `z_Assets/` files into `content/` (which is gitignored):

```bash
export TIMESCAPE_VAULT=/path/to/timescape-vault
npm run sync:vault
# or: npm run sync:vault -- /path/to/timescape-vault
```

Build and preview locally:

```bash
npm run install-plugins
npm run preview        # syncs vault and runs quartz build --serve
npm run build          # builds public/ and rewrites map asset paths for GitHub Pages
```

If `z_player_facing/index.md` does not exist in the vault, `scripts/sync-vault.mjs` falls back to `overrides/index.md`.

## Testing & Verification

```bash
npm run test:scripts   # unit tests for vault sync, map path rewriting, and static checks
npm run check:site     # verifies public/ HTML, internal links, media, and map configs
npm run test:e2e       # Playwright smoke tests against the built site in public/
npm run check          # TypeScript check and Prettier formatting check
```

## GitHub Actions Deployment Setup

The [deploy workflow](.github/workflows/deploy.yml) checks out the vault repository directly during CI builds instead of storing synced Markdown or map images in this repository. Configure the following in **Settings -> Secrets and variables -> Actions**:

- **Variable `VAULT_REPO`** (required): `<owner>/<vault-repo>` of the Obsidian vault repository.
- **Secret `VAULT_TOKEN`** (required if the vault repo is private): a fine-grained PAT with read-only `Contents: Read` permission on `VAULT_REPO`.

To automatically redeploy whenever the vault repository is pushed, add a workflow in the vault repository that triggers a `repository_dispatch` event:

```yaml
name: Trigger Timescape site deploy
on:
  push:
    branches: [main]
jobs:
  trigger:
    runs-on: ubuntu-latest
    steps:
      - run: |
          curl -fsSL -X POST \
            -H "Accept: application/vnd.github+json" \
            -H "Authorization: Bearer ${{ secrets.SITE_DISPATCH_TOKEN }}" \
            https://api.github.com/repos/walkerofthewoods/timescape-site/dispatches \
            -d '{"event_type":"vault-updated"}'
```
