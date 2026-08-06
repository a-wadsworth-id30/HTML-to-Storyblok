# HTML-to-Storyblok

`html-to-storyblok` is a safety-first CLI for integrating supplied HTML templates into existing Storyblok-powered repositories.

It performs deterministic discovery, additive-only planning, dependency-aware duplication candidate inference, policy validation, evidence logging, isolated file generation, Storyblok Management API operations, Storyblok Content API draft checks, Storyblok asset folder and asset import, GitHub/GitLab review branch preparation, draft pull-request and merge-request creation, Netlify deploy-preview polling, optional Netlify CLI log snapshots, local validation, local rollback, and confirmed remote Storyblok rollback for integration-owned draft resources.

## Requirements

- Node.js 20 or newer
- npm
- Git
- A supplied static template made up of HTML, CSS, JavaScript, and assets
- A target Storyblok-powered repository to inspect

Optional integrations:

- Storyblok Management API credentials for component, asset, and draft story creation
- Storyblok Content API credentials for draft preview verification
- Netlify API access for deploy-preview lookup and verification
- GitHub API credentials for draft pull-request automation
- GitLab API credentials for draft merge-request automation

Do not put secrets in the repository. Use environment variables only, and never commit `.env` files.

## Setup

Clone the project and install the local CLI:

```sh
npm link
```

Check the project:

```sh
npm run check
npm test
```

After `npm link`, the command is available as:

```sh
html-to-storyblok
```

You can also run it without linking:

```sh
node bin/html-to-storyblok.js --help
```

## Interactive CLI

Run the command without arguments to launch the guided terminal experience:

```sh
html-to-storyblok
```

The home screen provides task-oriented actions so first-time users do not need to remember the lower-level command names:

```text
────────────────────────────────────────────

HTML -> Storyblok
Safety-first template integration

Project
✓ Repository detected

What would you like to do?

❯ Create New Integration
  Continue Existing Integration
  Validate Integration
  Review Storyblok
  Review Repository
  Review Template
  Generate Report
  Settings
  Exit
```

Navigation supports arrow keys, `Enter`, `Esc`, `q`, `Tab`, and `Ctrl+C`. The wizard keeps all generated resources isolated by integration ID and uses the same planner, validator, generator, Storyblok, asset, and rollback services as the scriptable commands.

The create flow guides you through choosing a template from `templates/`, choosing a nearby repository, reviewing repository/Storyblok/template summaries, confirming the integration ID, previewing the derived prefix and namespace, validating the plan, running a dry run, optionally applying the real integration, and writing `.tmp/html-to-storyblok/report.md`.

If `.tmp/html-to-storyblok/integration-manifest.json` already exists, the CLI offers to resume the previous integration or start a new one.

For CI/CD or scripted usage, pass `--no-interactive` and use the command reference below. The no-command `--no-interactive` path prints help instead of launching a prompt.

## Dashboard, Settings, Doctor, and Reports

View a human-readable project dashboard:

```sh
html-to-storyblok dashboard
```

Configure local defaults:

```sh
html-to-storyblok settings
html-to-storyblok settings --show
html-to-storyblok settings --set templates_folder=templates
html-to-storyblok settings --set default_repository=../client-site
html-to-storyblok settings --set color_mode=never
```

Settings are stored in `~/.html-to-storyblok/config.json`. Secrets are never stored in the config file; keep API tokens in environment variables.

Run environment and project readiness checks:

```sh
html-to-storyblok doctor
```

The doctor checks Node.js, npm, Git, Storyblok credentials, Netlify credentials, GitHub/GitLab credentials, required folders, and repository health, then prints actionable fixes for warnings or failures.

Open the interactive report viewer:

```sh
html-to-storyblok view-report
html-to-storyblok report --view
```

The report viewer exposes summary, validation, evidence, generated files, warnings, and failures without requiring users to inspect JSON manually.

## Where to put templates

Place supplied templates in a dedicated input folder:

```text
templates/<template-name>/
```

Example:

```text
templates/acme-homepage/
  index.html
  about.html
  css/
  js/
  images/
  fonts/
```

Keep the template source unchanged so discovery can compare the original files with generated integration output later.

If you want to preview a raw static template in the browser before running inspection, start a simple server from the project root:

```sh
python3 -m http.server 8080
```

Then open:

```text
http://127.0.0.1:8080/templates/acme-homepage/
```

## Working directory

The CLI writes local evidence and generated artifacts to:

```text
.tmp/html-to-storyblok/
```

This directory is ignored by Git. It is used for:

- template inventories
- repository inspections
- Storyblok access checks
- Storyblok Content API checks
- Netlify inspections
- Netlify deploy-preview verification
- integration manifests
- plan validation output
- local validation output
- rollback previews
- evidence logs
- markdown reports

Do not commit `.tmp/` output.

## Basic workflow

### 1. Inspect the supplied template

```sh
html-to-storyblok inspect-template --template templates/acme-homepage
```

This produces:

```text
.tmp/html-to-storyblok/template-inventory.json
.tmp/html-to-storyblok/evidence.jsonl
```

The template inspection looks for:

- pages
- shared sections
- scripts and interactions
- CSS and breakpoints
- assets
- fonts
- third-party URLs
- accessibility concerns
- unsafe or environment-specific code

### 2. Inspect the target repository

Point the CLI at the existing client repository:

```sh
html-to-storyblok inspect-repository --repo ../client-site
```

This produces:

```text
.tmp/html-to-storyblok/repository-inspection.json
```

The repository inspection checks for:

- framework evidence
- package manager
- Storyblok dependencies
- Storyblok rendering patterns
- component discovery conventions
- TypeScript usage
- styling system
- Netlify files
- build contract clues

### 3. Check Storyblok access

```sh
html-to-storyblok inspect-storyblok
```

This command only reports available environment-variable names and whether Storyblok access appears available. It never prints secret values.

Example environment-variable names that may be detected:

```text
STORYBLOK_MANAGEMENT_TOKEN
STORYBLOK_SPACE_ID
STORYBLOK_PREVIEW_TOKEN
```

To query the remote Storyblok space, add `--remote`:

```sh
html-to-storyblok inspect-storyblok --remote
```

Remote Storyblok inspection and mutations require:

```text
STORYBLOK_MANAGEMENT_TOKEN
STORYBLOK_SPACE_ID
```

Optional:

```text
STORYBLOK_REGION
```

Supported region values are `eu`, `us`, `ca`, `ap`, and `cn`.

To verify that a draft story can be read through the Storyblok Content API:

```sh
html-to-storyblok inspect-storyblok-content \
  --slug integration-preview/acme-homepage-v1 \
  --version draft
```

Content API checks require one of:

```text
STORYBLOK_PREVIEW_TOKEN
STORYBLOK_PUBLIC_TOKEN
STORYBLOK_DELIVERY_TOKEN
```

### 4. Inspect Netlify configuration

```sh
html-to-storyblok inspect-netlify --repo ../client-site
```

This reads repository configuration such as `netlify.toml`.

To query Netlify deploy previews through the API:

```sh
html-to-storyblok netlify-preview --site-id <site-id> --branch <branch>
```

To verify the preview state and build contract:

```sh
html-to-storyblok netlify-preview \
  --site-id <site-id> \
  --branch <branch> \
  --verify \
  --wait \
  --expected-build-command "npm run build" \
  --expected-publish-directory dist
```

`--wait` polls the deploy preview until it reaches a terminal state or the timeout expires. Use `--timeout-ms` and `--interval-ms` to tune polling. Verification records the deploy log page URL and any deploy error message, but it does not print raw deploy logs or expose Netlify log access metadata.

To include a redacted log snapshot through the Netlify CLI:

```sh
html-to-storyblok netlify-preview \
  --site-id <site-id> \
  --branch <branch> \
  --verify \
  --include-logs \
  --logs-source deploy \
  --logs-since 1h
```

`--include-logs` requires `netlify-cli` on the machine running the command. Logs are captured as JSON Lines when available, capped in the report, and redacted for common token, password, authorization, and API key patterns.

Netlify API lookup requires:

```text
NETLIFY_AUTH_TOKEN
```

You may also set:

```text
NETLIFY_SITE_ID
```

### 5. Check live API readiness

```sh
html-to-storyblok check-access
```

This checks whether the variable names needed for Storyblok Management API, Storyblok Content API, Netlify, GitHub, and GitLab live calls are available. It does not print secret values.

### 6. Create an additive-only integration plan

Provide an integration ID in lowercase kebab-case.

The Storyblok prefix is derived from the integration ID:

```text
<integration-id> acme-homepage-v1
<storyblok-prefix> hts_acme_homepage_v1_
```

You may pass `--storyblok-prefix` explicitly, but it must exactly match the derived value. This prevents collisions when multiple templates are imported into the same site.

Example:

```sh
html-to-storyblok plan \
  --integration-id acme-homepage-v1 \
  --template templates/acme-homepage \
  --framework astro
```

To infer likely frontend and Storyblok component duplication candidates during planning, also pass a repository path:

```sh
html-to-storyblok plan \
  --integration-id acme-homepage-v1 \
  --template templates/acme-homepage \
  --repo ../client-site \
  --framework astro \
  --infer-duplicates
```

If you have already inspected Storyblok remotely, pass that artifact to infer safe Storyblok component duplicates from the existing block library:

```sh
html-to-storyblok plan \
  --integration-id acme-homepage-v1 \
  --template templates/acme-homepage \
  --repo ../client-site \
  --storyblok-inspection .tmp/html-to-storyblok/storyblok-access.json \
  --infer-duplicates
```

This produces:

```text
.tmp/html-to-storyblok/integration-manifest.json
.tmp/html-to-storyblok/plan-validation.json
```

The default repository namespace is:

```text
src/integrations/<integration-id>/
```

You can override it:

```sh
html-to-storyblok plan \
  --integration-id acme-homepage-v1 \
  --repository-namespace src/integrations/acme-homepage-v1
```

### 7. Validate a plan

```sh
html-to-storyblok validate-plan --manifest .tmp/html-to-storyblok/integration-manifest.json
```

Validation fails if the manifest attempts to:

- modify existing repository files
- create repository files outside the integration namespace
- reuse existing frontend components at runtime
- reuse existing Storyblok components at runtime
- modify existing Storyblok stories
- modify existing Storyblok assets
- use unsafe draft story slugs
- use duplicate file paths, component names, story slugs, or asset names
- allow unnamespaced nested Storyblok components
- use a Storyblok prefix that is not derived from the integration ID
- change dependencies
- change deployment configuration
- use unnamespaced Storyblok technical names

After generation or apply, validate the local integration output:

```sh
html-to-storyblok validate \
  --manifest .tmp/html-to-storyblok/integration-manifest.json \
  --repo ../client-site
```

Local validation checks generated files, planned assets, forbidden runtime coupling, CSS scoping, and Git worktree changes outside the integration namespace.

### 8. Generate a report

```sh
html-to-storyblok report
```

This summarizes commands run, failures, artifacts, latest validation state, latest Netlify state, and safety confirmations from the evidence log.

To view the same evidence as terminal sections and write a markdown report:

```sh
html-to-storyblok report --view
```

## Applying a manifest

All mutating commands validate the manifest immediately before execution.

Use `--dry-run` first:

```sh
html-to-storyblok apply \
  --manifest .tmp/html-to-storyblok/integration-manifest.json \
  --repo ../client-site \
  --template templates/acme-homepage \
  --framework auto \
  --dry-run
```

Run without `--dry-run` only after reviewing the dry-run output:

```sh
html-to-storyblok apply \
  --manifest .tmp/html-to-storyblok/integration-manifest.json \
  --repo ../client-site \
  --template templates/acme-homepage \
  --framework auto
```

`apply` performs these additive operations in order:

- duplicate approved frontend and Storyblok components into the integration namespace
- convert supplied template HTML/CSS/assets into isolated framework files
- validate the generated local integration before remote mutations
- create new Storyblok components
- create or reuse matching integration-owned Storyblok asset folders
- upload new Storyblok assets listed in the manifest
- create new draft Storyblok stories

It does not modify existing registries, routes, Storyblok components, Storyblok stories, assets, dependencies, or Netlify configuration.

## Individual operation commands

Generate isolated framework files from a supplied template:

```sh
html-to-storyblok generate \
  --manifest .tmp/html-to-storyblok/integration-manifest.json \
  --repo ../client-site \
  --template templates/acme-homepage \
  --framework auto \
  --dry-run
```

Supported framework output modes are:

- `auto`
- `astro`
- `react`
- `next`
- `vue`
- `nuxt`
- `static`

Duplicate approved frontend, repository asset, and Storyblok component sources:

```sh
html-to-storyblok duplicate \
  --manifest .tmp/html-to-storyblok/integration-manifest.json \
  --repo ../client-site \
  --dry-run
```

Duplication entries can be authored manually or inferred before review. To infer candidates for an existing manifest:

```sh
html-to-storyblok infer-duplicates \
  --manifest .tmp/html-to-storyblok/integration-manifest.json \
  --repo ../client-site \
  --storyblok-inspection .tmp/html-to-storyblok/storyblok-access.json
```

Add `--write-manifest` to persist the inferred entries back into the manifest after reviewing the output. Frontend inference walks a bounded local import graph, duplicates safe local source dependencies into `components/dependencies/`, duplicates safe local style dependencies into `styles/dependencies/`, rewrites import specifiers between copied files, and namespaces duplicated CSS with the integration root. Skipped candidates are reported with blockers such as unresolved imports, unsupported files, unsafe paths, oversized graphs, or style asset URLs that need an explicit asset-copy plan.

Manual example:

```json
{
  "repository": {
    "components_to_duplicate": [
      {
        "source_path": "src/components/Button.js",
        "target_path": "src/integrations/acme-homepage-v1/components/HtsButton.js",
        "export_name": "Button",
        "new_export_name": "HtsButton"
      }
    ],
    "assets_to_create": [
      {
        "source_path": "public/logo.svg",
        "target_path": "src/integrations/acme-homepage-v1/assets/logo.svg"
      }
    ]
  },
  "storyblok": {
    "components_to_duplicate": [
      {
        "source_technical_name": "hero",
        "technical_name": "hts_acme_homepage_v1_hero"
      }
    ]
  }
}
```

Targets must be inside the integration namespace. The source is copied and rewritten; no runtime import relationship to the source is retained.

Create Storyblok components:

```sh
html-to-storyblok storyblok-components \
  --manifest .tmp/html-to-storyblok/integration-manifest.json \
  --dry-run
```

Real Storyblok component creation is idempotent: if a namespaced component already exists and matches the manifest, the CLI reports it as `already_exists`; if it differs, the CLI stops and reports drift.

Create Storyblok asset folders listed in `storyblok.asset_folders_to_create`:

```sh
html-to-storyblok storyblok-asset-folders \
  --manifest .tmp/html-to-storyblok/integration-manifest.json \
  --dry-run
```

Real asset folder creation is additive. Matching folders under the same parent are reused; existing folders are never renamed or updated.

Upload Storyblok assets listed in `storyblok.assets_to_create`:

```sh
html-to-storyblok upload-assets \
  --manifest .tmp/html-to-storyblok/integration-manifest.json \
  --dry-run
```

Create draft stories:

```sh
html-to-storyblok create-draft-story \
  --manifest .tmp/html-to-storyblok/integration-manifest.json \
  --dry-run
```

Draft story creation uses `publish: false`. Existing matching draft stories are treated as idempotent; published or differing stories are treated as blockers.

Open a GitHub draft pull request:

```sh
html-to-storyblok open-pr \
  --repo ../client-site \
  --title "Integrate Acme homepage template" \
  --base main \
  --dry-run
```

Opening a pull request requires:

```text
GITHUB_TOKEN
```

or:

```text
GH_TOKEN
```

To prepare the review branch before opening the PR, pass the manifest and explicit Git flags:

```sh
html-to-storyblok open-pr \
  --repo ../client-site \
  --manifest .tmp/html-to-storyblok/integration-manifest.json \
  --title "Integrate Acme homepage template" \
  --base main \
  --prepare-branch \
  --commit \
  --push
```

The Git workflow stages only manifest-owned integration paths. It refuses to commit if the working tree contains changes outside the integration namespace.

Open a GitLab draft merge request:

```sh
html-to-storyblok open-mr \
  --repo ../client-site \
  --title "Integrate Acme homepage template" \
  --target-branch main \
  --dry-run
```

Opening a merge request requires:

```text
GITLAB_TOKEN
```

or:

```text
GITLAB_PRIVATE_TOKEN
```

For self-managed GitLab, also set:

```text
GITLAB_BASE_URL
```

GitLab supports the same branch preparation flags:

```sh
html-to-storyblok open-mr \
  --repo ../client-site \
  --manifest .tmp/html-to-storyblok/integration-manifest.json \
  --title "Integrate Acme homepage template" \
  --target-branch main \
  --prepare-branch \
  --commit \
  --push
```

Generate a rollback preview:

```sh
html-to-storyblok rollback-preview \
  --manifest .tmp/html-to-storyblok/integration-manifest.json \
  --repo ../client-site
```

Run confirmed local rollback:

```sh
html-to-storyblok rollback \
  --manifest .tmp/html-to-storyblok/integration-manifest.json \
  --repo ../client-site \
  --confirm-integration-id acme-homepage-v1
```

Rollback removes only manifest-listed local files and assets inside the integration namespace by default.

To also delete integration-owned Storyblok draft resources, use explicit remote confirmation:

```sh
html-to-storyblok rollback \
  --manifest .tmp/html-to-storyblok/integration-manifest.json \
  --repo ../client-site \
  --confirm-integration-id acme-homepage-v1 \
  --remote \
  --confirm-remote-delete
```

Remote rollback deletes only manifest-owned namespaced components, unpublished draft stories with namespaced root components, exact namespaced assets, and matching namespaced asset folders. Published stories, unnamespaced resources, and unverified asset matches are refused or skipped.

## Command reference

```sh
html-to-storyblok
html-to-storyblok dashboard
html-to-storyblok settings [--show] [--set key=value]
html-to-storyblok doctor
html-to-storyblok view-report
html-to-storyblok inspect-template --template <path>
html-to-storyblok inspect-repository --repo <path>
html-to-storyblok inspect-storyblok
html-to-storyblok inspect-storyblok-content --slug <slug> [--version draft|published]
html-to-storyblok inspect-netlify --repo <path>
html-to-storyblok check-access
html-to-storyblok netlify-preview --site-id <site-id> [--branch <branch>] [--verify] [--wait] [--include-logs]
html-to-storyblok plan --integration-id <id> [--storyblok-prefix <derived_prefix>] [--template <path>] [--repo <path> --infer-duplicates] [--framework auto|astro|react|next|vue|nuxt|static]
html-to-storyblok infer-duplicates --manifest <path> --repo <path> [--storyblok-inspection <path>] [--write-manifest]
html-to-storyblok validate-plan --manifest <path>
html-to-storyblok diff --manifest <path> --repo <path>
html-to-storyblok validate --manifest <path> --repo <path>
html-to-storyblok build --repo <path> [--script build] [--dry-run]
html-to-storyblok generate --manifest <path> --repo <path> [--template <path>] [--framework auto|astro|react|next|vue|nuxt|static] [--dry-run]
html-to-storyblok duplicate --manifest <path> --repo <path> [--dry-run]
html-to-storyblok storyblok-components --manifest <path> [--dry-run]
html-to-storyblok storyblok-asset-folders --manifest <path> [--dry-run]
html-to-storyblok upload-assets --manifest <path> [--dry-run]
html-to-storyblok create-draft-story --manifest <path> [--dry-run]
html-to-storyblok apply --manifest <path> --repo <path> [--template <path>] [--framework auto|astro|react|next|vue|nuxt|static] [--dry-run]
html-to-storyblok open-pr --repo <path> --title <title> [--base main] [--manifest <path> --prepare-branch --commit --push] [--dry-run]
html-to-storyblok open-mr --repo <path> --title <title> [--target-branch main] [--manifest <path> --prepare-branch --commit --push] [--dry-run]
html-to-storyblok rollback-preview --manifest <path> [--repo <path>]
html-to-storyblok rollback --manifest <path> --repo <path> --confirm-integration-id <id> [--remote --confirm-remote-delete] [--dry-run]
html-to-storyblok report [--view]
```

Mutating commands support `--dry-run` and require the relevant credentials before real execution.

## Policy

The default policy is `additive-only-isolated`.

Automatic operations may only:

- read existing resources
- snapshot existing resources
- duplicate existing resources into a new namespace
- create new resources

The CLI rejects plans that modify existing repository files, reuse existing frontend or Storyblok components at runtime, modify existing stories or assets, change dependencies, or change deployment configuration.

## Example end-to-end dry run

```sh
mkdir -p templates/acme-homepage

html-to-storyblok inspect-template --template templates/acme-homepage
html-to-storyblok inspect-repository --repo ../client-site
html-to-storyblok inspect-storyblok
html-to-storyblok inspect-netlify --repo ../client-site
html-to-storyblok check-access

html-to-storyblok plan \
  --integration-id acme-homepage-v1 \
  --template templates/acme-homepage \
  --framework auto

html-to-storyblok validate-plan \
  --manifest .tmp/html-to-storyblok/integration-manifest.json

html-to-storyblok apply \
  --manifest .tmp/html-to-storyblok/integration-manifest.json \
  --repo ../client-site \
  --template templates/acme-homepage \
  --framework auto \
  --dry-run

html-to-storyblok validate \
  --manifest .tmp/html-to-storyblok/integration-manifest.json \
  --repo ../client-site

html-to-storyblok report
```

## Production capability status

Implemented:

- Interactive wizard, dashboard, settings, doctor checks, report viewer, and scriptable commands.
- Template conversion for static HTML, CSS, local assets, JSX/Vue-safe attributes, ID reference rewrites, and local JavaScript isolation.
- CSS namespacing and JavaScript isolation inside the integration root.
- Additive-only manifests with derived Storyblok prefixes and isolated repository namespaces.
- Opt-in frontend and Storyblok duplication candidate inference with dependency graph copying, style dependency namespacing, import rewrites, skipped-candidate diagnostics, manifest validation, and duplicated-output validation.
- Richer Storyblok component schema generation for navigation, feature grids, galleries, testimonials, stats, pricing, steps/timelines, FAQ/accordion content, team/profile grids, CTA groups, forms, nested form fields, draft story generation, asset folder creation, asset upload, and idempotent collision handling.
- Storyblok Content API draft story checks without exposing tokens.
- Netlify deploy-preview lookup, build contract verification, deploy-state polling, deploy log page references, and optional redacted Netlify CLI log snapshots.
- Local validation and diffing for generated files, duplicated component files, dependency copies, and assets, plus rollback previews, confirmed local rollback for integration-owned files, and confirmed remote Storyblok rollback for integration-owned draft resources.
- GitHub draft pull-request and GitLab draft merge-request creation through their APIs, with optional branch preparation, scoped staging, commit, and push orchestration.

## Remaining limitations

- Duplication inference is conservative and opt-in. It now handles local code and style dependency graphs, but still skips unresolved, unsupported, unsafe, oversized, or asset-rewrite-dependent graphs and requires manifest review before apply.
- Schema generation covers common editorial patterns and several bespoke landing-page patterns, but custom business-specific editorial models may still require manual refinement through a new namespaced version.
- Netlify raw deploy logs are not exposed through the Netlify REST verification path. Use `--include-logs` with `netlify-cli` installed, or use the Netlify UI for full deploy output.
- Live Storyblok, Netlify, GitHub, and GitLab calls require credentials in the environment; use `html-to-storyblok check-access` to verify readiness.
- No command modifies existing registries, routes, dependencies, Storyblok resources, or Netlify configuration.

## Validation

```sh
npm run check
npm test
```
