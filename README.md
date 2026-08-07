# HTML-to-Storyblok

`html-to-storyblok` is a safety-first CLI for integrating supplied HTML templates into existing Storyblok-powered repositories.

It performs deterministic discovery, additive-only planning, dependency-aware duplication candidate inference, policy validation, evidence logging, isolated file generation, Storyblok Management API operations, Storyblok component folder creation, internal tag creation, component preset creation, Storyblok Management API audit/reconcile/verification checks, Storyblok Content API draft checks, Storyblok asset folder and asset import, GitHub/GitLab review branch preparation, draft pull-request and merge-request creation, Netlify deploy-preview polling, optional Netlify CLI log snapshots, local validation, local rollback, and confirmed remote Storyblok rollback for integration-owned draft resources.

## Requirements

- Node.js 20 or newer
- npm
- Git
- A supplied static template made up of HTML, CSS, JavaScript, and assets
- A target Storyblok-powered repository to inspect when running the full repository integration workflow

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

Interactive startup displays the compact ID30 ASCII banner in `ascii-art.txt`, converted from `id30-logo.svg`, followed by the ID30 developer credit and proprietary-use legal notice. Non-interactive help output also includes the same branding and legal notice.

The home screen provides task-oriented actions so first-time users do not need to remember the lower-level command names:

```text
────────────────────────────────────────────

HTML -> Storyblok
Safety-first template integration

Project
✓ Repository detected

What would you like to do?

❯ Create New Integration
  Test Storyblok Only
  Continue Existing Integration
  Validate Integration
  Review Storyblok
  Review Repository
  Review Template
  Test Credentials
  Generate Report
  Import History
  Live Sandbox Test
  Settings
  Exit
```

Navigation supports arrow keys, `Enter`, `Esc`, `q`, `Tab`, and `Ctrl+C`. The wizard keeps all generated resources isolated by integration ID and uses the same planner, validator, generator, Storyblok, asset, and rollback services as the scriptable commands.

The create flow guides you through choosing a template from `templates/`, choosing a nearby repository, reviewing repository/Storyblok/template summaries, confirming the integration ID, previewing the derived prefix and namespace, validating the plan, running a dry run, optionally applying the real integration, and writing `.tmp/html-to-storyblok/report.md`.

Dry runs now include a human-readable apply preview diff covering repository files, assets, Storyblok component folders, internal tags, components, presets, asset folders, draft stories, and generated Storyblok link resolution. Long-running progress output includes percentages and elapsed time.

Real repository apply runs available host `lint`, `typecheck`, and `build` scripts before writing generated files, then runs local output validation and the same host checks again before any Storyblok remote mutation. Missing scripts are reported as skipped, failing scripts stop the apply. Use `--host-checks lint,typecheck,build` to customize the script list, or `--skip-host-checks` only when you have already run equivalent checks.

After a completed interactive action, the CLI shows a success checkpoint with the latest plan/local validation status, then stays open on a `Next` menu. From there you can return to the main menu, run a validation check, view the latest report, or exit intentionally.

If an interactive action fails, the wizard stays open and shows a recovery menu. From there you can retry the failed action, validate the current state, view the latest report, show a rollback preview, return to the main menu, or exit intentionally.

When you only want to test the Storyblok side before a client repository is available, choose `Test Storyblok Only` from the home screen, or choose `Skip Repository - Storyblok only test` when the create flow asks for a repository. This path still inspects the template, derives the same namespaced component schema, validates the additive-only plan, dry-runs all Storyblok operations, and can optionally run the real Storyblok apply. It does not generate repository files, inspect a repository, change routes, or require `--repo`.

If `.tmp/html-to-storyblok/integration-manifest.json` already exists, the CLI offers to resume the previous integration or start a new one. The resume screen shows the integration ID, latest status, completed apply steps, validation state, failed step if any, and the recommended next action. From the continue workflow you can also review or edit generated Storyblok links, review or edit generated schema field types and labels, run one Storyblok apply step at a time, preview apply changes, and show rollback targets before applying.

`Import History` scans recent evidence and report artifacts so you can see the latest integration ID, validation status, completed steps, and generated reports without opening JSON files. `Live Sandbox Test` guides a disposable Storyblok-only test against a namespaced integration ID, validates the drafts when a Content API token is available, and can roll back generated remote resources.

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
html-to-storyblok settings --profile client-site --set default_repository=../client-site
html-to-storyblok settings --profile client-site
```

Settings are stored in `~/.html-to-storyblok/config.json`. Secrets are never stored in the config file. Named profiles can store non-secret defaults for a project, including repository path, templates folder, Storyblok region, Storyblok space ID, preferred framework, output folder, color mode, and verbose logging. `html-to-storyblok settings --profile <name>` activates a profile, and `--profile <name> --set key=value` creates or updates profile-specific defaults.

Create a local environment scaffold for credentials:

```sh
html-to-storyblok env --init
```

This writes `.env.local` in the current project and refuses to overwrite an existing file unless `--force` is passed. `.env.local`, `.env`, and other `.env.*` files are ignored by git. The command writes placeholders only; fill real credentials locally in your editor or shell. To print the scaffold without writing a file:

```sh
html-to-storyblok env --print
```

Generate shell completions:

```sh
html-to-storyblok completion --shell zsh
html-to-storyblok completion --shell bash
html-to-storyblok completion --shell fish
```

Credential handling:

- Interactive mode asks for missing Storyblok credentials when inspection or real apply needs them.
- `Test Credentials` in the home screen checks Management API readiness, manifest preflight, and Content API draft validation when the relevant credentials are available.
- Tokens entered in the wizard are kept in memory for that CLI run only.
- The Preview API token prompt is optional; press `Enter` to skip it when you only need Management API component, asset, and draft-story testing.
- Local credentials should live in `.env.local` or shell environment variables, not in `settings`.
- Scriptable commands read credentials from shell environment variables and local `.env` / `.env.local` files.
- Shell environment variables override `.env` values.
- `.env` values are loaded from the current working directory and, when `--repo` or a selected repository is available, the target repository.
- Reports and evidence record variable names only, never secret values.

Run environment and project readiness checks:

```sh
html-to-storyblok doctor
```

The doctor checks Node.js, npm, Git, optional Netlify CLI availability for log snapshots, Storyblok credentials, Netlify credentials, GitHub/GitLab credentials, required folders, and repository health, then prints actionable fixes for warnings or failures.

Open the interactive report viewer:

```sh
html-to-storyblok view-report
html-to-storyblok report --view
html-to-storyblok report --html
```

The report viewer exposes summary, validation, evidence, generated files, warnings, failures, Storyblok drilldowns, activity timelines, report search, and optional standalone HTML report export without requiring users to inspect JSON manually.

The report viewer also includes Storyblok, assets, links, and rollback-target sections so you can inspect created/reused resources, unresolved generated story links, and cleanup scope without opening JSON artifacts directly.

## Where to put templates

Place supplied templates in a dedicated input folder:

```text
templates/<template-name>/
```

Example:

```text
templates/acme-campaign/
  index.html
  about.html
  services.html
  gallery.html
  contact.html
  styles.css
  behaviour.js
  schema-overrides.json
  assets/
```

Additional bundled fixture:

```text
templates/launchpad-saas/
  index.html
  about.html
  services.html
  gallery.html
  contact.html
  styles.css
  behaviour.js
  schema-overrides.json
  assets/
```

Keep the template source unchanged so discovery can compare the original files with generated integration output later.

This repository includes `templates/acme-campaign/` as a smoke-test fixture. It contains a realistic five-route static template for home, about, services, gallery, and contact pages using this project as the example subject matter. It includes local assets, local CSS, local JavaScript, repeated image references, form fields, explicit `data-hts-field` hints, and additive schema overrides. It also includes external form and analytics references so inspection/reporting can surface the expected review warnings.

This repository also includes `templates/launchpad-saas/` as a second smoke-test fixture. It models a SaaS launch-operations product and uses the same five-route shape with different content, assets, metrics, pricing cards, workflow cards, form fields, explicit `data-hts-field` hints, and schema overrides. Use it when you need to validate a second import on the same Storyblok space or demo site with a different integration ID, namespace, components, assets, and draft story folder.

If you want to preview a raw static template in the browser before running inspection, start a simple server from the project root:

```sh
python3 -m http.server 8080
```

Then open:

```text
http://127.0.0.1:8080/templates/acme-campaign/
http://127.0.0.1:8080/templates/launchpad-saas/
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
- repository preflight output
- rollback previews
- per-step apply artifacts for completed local and Storyblok operations
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

Before using a real client repository, use the local demo-site matrix in `demo-sites/` to exercise the repository integration path safely:

```text
demo-sites/static
demo-sites/astro
demo-sites/next
demo-sites/nuxt
demo-sites/vue
demo-sites/react
```

These demo sites are intentionally dependency-light. They look like their target framework, expose a local `npm run build` check, and are used by automated tests to verify framework detection, isolated route-preview generation, route-relative asset references, Git worktree safety, and that generated files stay inside `src/integrations/<integration-id>` while existing app files remain unchanged.

To compile the generated route proposal handoff inside the real demo framework compilers, use the generated integration matrix:

```sh
npm run test:demo-sites-generated
```

This temporarily wires a generated route proposal into each demo site, runs the real Astro, Next, Nuxt, Vue, and React framework builds, then restores the demo files. It is opt-in because it installs and runs full framework dependency trees.

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

Remote inspection reads are capped by default so large spaces do not cause slow full-space scans. It summarizes space details, component folders, components, stories, asset folders, assets, internal tags, and component presets. Use `--full` when you intentionally want to list every supported core remote resource:

```sh
html-to-storyblok inspect-storyblok --remote --full
```

For a deeper read-only Management API audit, include `--audit` or use `storyblok-audit`:

```sh
html-to-storyblok inspect-storyblok --remote --audit
html-to-storyblok storyblok-audit --full
```

Audit mode also attempts optional Management API reads for workflows, workflow stages, releases, webhook endpoints, datasources, datasource entries, collaborators, space roles, activities, tasks, tags, branches, and approvals. Optional collections that are unavailable for the current token, region, plan, or space are reported as unavailable instead of failing the whole audit. Webhook URLs are redacted for token-like query parameters before they are written to reports.

Remote Storyblok inspection and mutations require:

```text
STORYBLOK_MANAGEMENT_TOKEN
STORYBLOK_SPACE_ID
```

Optional:

```text
STORYBLOK_REGION
STORYBLOK_TIMEOUT_MS
STORYBLOK_CONTENT_TIMEOUT_MS
STORYBLOK_INSPECT_MAX_ITEMS
STORYBLOK_REQUEST_INTERVAL_MS
STORYBLOK_RETRY_LIMIT
STORYBLOK_RETRY_BASE_MS
STORYBLOK_RETRY_MAX_MS
```

In the interactive wizard, missing Storyblok values are requested at the Storyblok review step and again before a real apply if they are still unavailable. Non-interactive commands fail with actionable messages instead of prompting.

Supported region values are `eu`, `us`, `ca`, `ap`, and `cn`.

To verify that a draft story can be read through the Storyblok Content API:

```sh
html-to-storyblok inspect-storyblok-content \
  --slug acme-homepage-v1/home \
  --version draft
```

To validate every planned draft story after an apply:

```sh
html-to-storyblok validate-storyblok \
  --manifest .tmp/html-to-storyblok/integration-manifest.json \
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

Use `--framework auto` with `--repo <path>` when you want the planner to inspect the target repository and store a concrete framework in the manifest. If `auto` is used without a repository path, planning falls back to static output and later generation honors that planned mode for deterministic file creation.

To infer likely frontend and Storyblok component duplication candidates during planning, also pass a repository path:

```sh
html-to-storyblok plan \
  --integration-id acme-homepage-v1 \
  --template templates/acme-homepage \
  --repo ../client-site \
  --schema-overrides schema-overrides.json \
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
- create draft stories outside `<integration-id>/`
- use duplicate file paths, component names, story slugs, or asset names
- allow unnamespaced Storyblok content components
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

Before generating into an existing site, run the read-only repository preflight:

```sh
html-to-storyblok repository-preflight \
  --manifest .tmp/html-to-storyblok/integration-manifest.json \
  --repo ../client-site
```

For real apply this refuses planned file or asset collisions and unrelated Git worktree changes before local generation runs. During apply dry-runs, existing planned targets are reported as warnings so the preview can still complete without writing files.

### 8. Generate a report

```sh
html-to-storyblok report
```

This summarizes commands run, failures, artifacts, skipped duplication diagnostics, latest validation state, latest Netlify state, and safety confirmations from the evidence log.

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

- run a non-mutating repository preflight that refuses planned file/asset collisions and unrelated worktree changes during real apply, while reporting those collisions as warnings during dry-run preview
- run a non-mutating Storyblok preflight when Storyblok operations are planned
- duplicate approved frontend and Storyblok components into the integration namespace
- convert supplied template HTML/CSS/assets into isolated framework files and route previews
- validate the generated local integration before remote mutations
- create or reuse matching integration-owned Storyblok component folders
- create or reuse matching integration-owned Storyblok internal tags
- create new Storyblok components
- create or reuse matching integration-owned Storyblok asset folders
- upload new Storyblok assets listed in the manifest
- create or reuse matching integration-owned Storyblok component presets
- create new draft Storyblok stories with asset fields hydrated from the uploaded Storyblok assets
- validate created draft stories through the Storyblok Content API when a preview/delivery token is available
- reconcile and verify created Storyblok resources through the Management API
- record filtered Storyblok activity evidence when the activity endpoint is available

It does not modify existing registries, routes, Storyblok components, Storyblok stories, assets, dependencies, or Netlify configuration.

During real and dry-run apply, completed stages are written as incremental artifacts in `.tmp/html-to-storyblok/` before the final result file. `apply-step-00-repository-preflight.json` is written before local generation and records planned repository targets, collisions, duplicate-source availability, and worktree safety checks. If a later remote operation fails, the completed step files remain available for review, resume decisions, and rollback planning. When retrying an integration after local files were already generated, repository preflight can reuse existing targets only when they are inside the integration namespace and match `generated-file-hashes.json`; drifted or unrelated files still block apply.

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

For multi-page templates, generation keeps the existing primary preview file for backwards compatibility and also creates route-specific previews under the integration namespace:

```text
src/integrations/<integration-id>/
  adapter-plan.json
  INTEGRATION_GUIDE.md
  generated-file-hashes.json
  TemplatePage.astro | TemplatePage.jsx | TemplatePage.vue | template.html
  routes/
    manifest.json
    home/
      TemplatePage.* | template.html
      template-html.js
    about/
      TemplatePage.* | template.html
      template-html.js
  route-proposals/
    manifest.json
    README.md
    home/
      page.astro | page.jsx | Page.vue | route.js
```

Route preview files use route-relative local asset paths, so a preview under `routes/home/` resolves copied template assets from the generated integration folder instead of relying on the root preview path. The generated `adapter-plan.json`, `INTEGRATION_GUIDE.md`, and `route-proposals/` files provide framework-specific import examples, route-to-story mappings, review-only route wrapper modules, suggested host-route file names, and required checks before wiring the import into a real route. These files are not registered with the host application's router. They are isolated preview/import targets that an existing site can review or wire manually after validation.

Supported framework output modes are:

- `auto`
- `astro`
- `react`
- `next`
- `vue`
- `nuxt`
- `static`

Schema generation also respects explicit editorial field hints in the supplied template. Add one of these attributes to text, image, link, or form-control elements when the generic inferred model needs a business-specific field:

- `data-hts-field`
- `data-storyblok-field`
- `data-sb-field`
- `data-field`
- `itemprop`

For example, `data-hts-field="service_intro"` creates a namespaced `service_intro` field on the integration-owned content section and seeds the draft preview from the template text. Image hints become Storyblok asset fields, link hints become multilink fields, select/radio hints become option fields, and checkbox hints become boolean fields.

For business-specific fields that should not be embedded in the template HTML, pass a schema override file during planning:

```json
{
  "components": {
    "hero": {
      "display_name": "Campaign Hero",
      "preview_field": "campaign_code",
      "fields": {
        "campaign_code": { "type": "text", "description": "CRM campaign code" },
        "related_services": {
          "type": "options",
          "source": "stories",
          "folder_slug": "services/"
        },
        "cards": {
          "type": "bloks",
          "component_whitelist": ["feature_item"],
          "maximum": 3
        }
      },
      "draft": {
        "campaign_code": "spring-launch",
        "cards": [
          { "component": "feature_item", "headline": "Managed migration" }
        ]
      }
    }
  },
  "draft_story": {
    "name": "Campaign Import Preview",
    "headline": "Campaign Preview"
  }
}
```

Override component keys may use short generated names such as `hero` or full namespaced technical names. Nested block whitelists and seeded draft block `component` values are automatically rewritten into the integration Storyblok prefix. Draft story slug overrides are allowed only inside `<integration-id>/`.

For multi-page templates, route-specific draft story overrides can be supplied with `draft_stories`:

```json
{
  "draft_stories": {
    "index.html": {
      "headline": "Home Preview"
    },
    "about": {
      "name": "About Preview",
      "headline": "About the Integration"
    }
  }
}
```

Override keys may target a full draft slug, route segment, route path, source HTML filename, or source filename without extension. Unknown targets fail planning instead of being ignored.

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

Add `--write-manifest` to persist the inferred entries back into the manifest after reviewing the output. Frontend inference walks a bounded local import graph, resolves safe relative imports plus `tsconfig.json`/`jsconfig.json` path aliases, duplicates safe local source dependencies (`.astro`, `.vue`, `.js`, `.jsx`, `.ts`, `.tsx`, `.mjs`, `.cjs`, `.mts`, `.cts`) into `components/dependencies/`, duplicates safe local style dependencies into `styles/dependencies/`, duplicates local JSON data dependencies into `data/dependencies/`, copies resolvable local static assets into `assets/dependencies/`, rewrites import, `new URL(..., import.meta.url)`, and CSS `url(...)` specifiers between copied files, and namespaces duplicated CSS with the integration root. Skipped candidates are reported with blockers such as unresolved imports, unsupported files, unsafe paths, oversized graphs, or unresolved asset references.

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

Run Storyblok preflight checks before real apply:

```sh
html-to-storyblok storyblok-preflight \
  --manifest .tmp/html-to-storyblok/integration-manifest.json
```

Preflight performs non-mutating Management API reads for the resources required by the manifest. It verifies credentials, space access, read access for component folders, components, stories, asset folders, assets, and presets, and returns a permission matrix showing which planned resource classes are readable and which additive create calls will verify write access during execution. Storyblok internal tags are treated as optional metadata: if the current space, token, region, or plan does not expose the internal-tags endpoint, the import continues and records the planned tags as skipped or present-unverified instead of blocking component, asset, and draft-story creation.

Create Storyblok component folders listed in `storyblok.component_groups_to_create`:

```sh
html-to-storyblok storyblok-component-groups \
  --manifest .tmp/html-to-storyblok/integration-manifest.json \
  --dry-run
```

Generated template components are filed into a single integration-owned component folder by default. Matching folders are reused by name and parent; existing component folders are never renamed or updated.

Create Storyblok internal tags listed in `storyblok.internal_tags_to_create`:

```sh
html-to-storyblok storyblok-internal-tags \
  --manifest .tmp/html-to-storyblok/integration-manifest.json \
  --dry-run
```

Generated manifests add namespaced component and asset tags such as `hts_acme_homepage_v1_components` and `hts_acme_homepage_v1_assets`. Tags are created additively and never assigned to existing non-integration resources.

Create Storyblok components:

```sh
html-to-storyblok storyblok-components \
  --manifest .tmp/html-to-storyblok/integration-manifest.json \
  --dry-run
```

Real Storyblok component creation is idempotent: if a namespaced component already exists and matches the manifest, the CLI reports it as `already_exists`; if it differs, the CLI stops and reports drift.

Storyblok Management API requests retry `429` rate-limit responses and transient `5xx` failures with backoff. Requests also use configurable timeouts, and `STORYBLOK_REQUEST_INTERVAL_MS` can be set to pace requests for stricter rate-limit environments. If an earlier run stopped part-way through because of rate limiting, rerun the same manifest/integration ID; matching namespaced resources are reused and remaining resources continue from the manifest.

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

When `apply` or `storyblok-apply` runs the full workflow, uploaded asset results are fed into draft story creation. Template-local asset references such as `./assets/hero.svg` are converted into Storyblok asset fields with the uploaded asset ID, final Storyblok filename, alt text, and `fieldtype: "asset"`.

Existing Storyblok assets are reused only when the match is integration-owned and exact. The CLI compares the manifest filename/path and the resolved integration asset folder, so a generic existing asset with the same basename, such as `logo.svg`, is not treated as a safe match unless it belongs to the planned integration namespace. Upload evidence now includes the local byte size and SHA-256 hash for each source file.

Create Storyblok component presets listed in `storyblok.presets_to_create`:

```sh
html-to-storyblok storyblok-presets \
  --manifest .tmp/html-to-storyblok/integration-manifest.json \
  --dry-run
```

Template-derived plans create one namespaced editor preset per generated block where representative draft content exists. Presets are attached only to integration-owned components. When the full workflow runs, preset asset fields are hydrated from uploaded Storyblok asset results before the preset is created.

Create draft stories:

```sh
html-to-storyblok create-draft-story \
  --manifest .tmp/html-to-storyblok/integration-manifest.json \
  --dry-run
```

Draft story creation uses `publish: false`. Templates create one integration-owned story folder named `<integration-id>` and place imported draft stories inside it. `index.html` is mapped to `<integration-id>/home`; multi-page templates create additional stories such as `<integration-id>/about`, `<integration-id>/services`, and `<integration-id>/contact`. Internal template links that match generated routes, such as `/about`, `about.html`, `/contact`, or `/gallery#work`, are converted into Storyblok story links pointing at the generated draft stories. During real Storyblok apply, created route stories are resolved back to their Storyblok UUIDs so multilink fields include `id`, `cached_url`, `url`, and `fieldtype`. If an unpublished integration-owned draft from an earlier run only has `cached_url`, apply safely repairs that link metadata without changing non-integration stories. The integration-specific story folder is created or reused additively when needed. Existing matching draft stories are treated as idempotent, including Storyblok-generated editor and asset metadata; published or genuinely differing stories are treated as blockers. If a draft story was created by an earlier version with unresolved local asset paths or under `integration-preview/`, rerun with a new integration ID or use confirmed remote rollback for the integration-owned draft resources before applying again.

Run the complete Storyblok-only workflow without a repository:

```sh
html-to-storyblok storyblok-apply \
  --manifest .tmp/html-to-storyblok/integration-manifest.json \
  --dry-run
```

This combines component folder creation, internal tag creation, component creation, asset folder creation, asset upload, component preset creation, draft story creation, Content API validation when possible, Management API reconcile/verification, and activity evidence capture. It is useful for validating the Storyblok side of a template before a target repository exists. For real execution, omit `--dry-run`; the command requires `STORYBLOK_MANAGEMENT_TOKEN` and `STORYBLOK_SPACE_ID`, or credentials entered in the interactive wizard.

After real Storyblok apply, run Content API validation manually if needed:

```sh
html-to-storyblok validate-storyblok \
  --manifest .tmp/html-to-storyblok/integration-manifest.json \
  --version draft
```

The validation confirms generated draft stories can be fetched, root components are namespaced, nested component names remain within the integration prefix, asset fields have filenames, and generated Storyblok story links include UUID metadata.

To reconcile a manifest against the current Management API state without mutating Storyblok:

```sh
html-to-storyblok storyblok-reconcile \
  --manifest .tmp/html-to-storyblok/integration-manifest.json
```

Reconcile classifies every planned Storyblok resource as `matching`, `missing`, `drifted`, `blocked`, or `present_unverified`. It covers component folders, internal tags, components, asset folders, assets, presets, and draft stories.

To run the stronger post-apply Management API verification manually:

```sh
html-to-storyblok storyblok-verify \
  --manifest .tmp/html-to-storyblok/integration-manifest.json
```

This combines reconcile with story-level checks for unpublished imported drafts, namespaced root and nested components, generated story links with UUID metadata, generated links that target planned routes, and asset fields that have been hydrated to uploaded Storyblok assets rather than local template paths. Management verification hydrates planned component and story summaries through single-resource Management API reads when list responses omit schema or story content, and component schema checks compare the intended contract while ignoring Storyblok-generated editor metadata.

To capture Storyblok activity evidence for the current integration:

```sh
html-to-storyblok storyblok-activities \
  --manifest .tmp/html-to-storyblok/integration-manifest.json \
  --since 2026-08-07T09:00:00.000Z
```

Activity evidence is read-only. It filters recent Management API activity records down to entries that mention the integration ID, Storyblok prefix, planned story slugs, component names, or asset names.

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

The CLI infers the GitHub repository from `origin` by default, including SSH remotes such as `git@github.com:owner/repo.git`, `ssh://git@github.com/owner/repo.git`, HTTPS remotes, and GitHub SSH host aliases. If no GitHub token is available, the command refuses to create the PR through the API and prints a manual GitHub compare URL that can be opened in the browser.

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

Rollback removes only manifest-listed local files and assets inside the integration namespace by default. New generated integrations include `generated-file-hashes.json`; rollback verifies generated file hashes before deleting local files and refuses drifted files unless you pass `--allow-modified-generated-files` after review.

To also delete integration-owned Storyblok draft resources, use explicit remote confirmation:

```sh
html-to-storyblok rollback \
  --manifest .tmp/html-to-storyblok/integration-manifest.json \
  --repo ../client-site \
  --confirm-integration-id acme-homepage-v1 \
  --remote \
  --confirm-remote-delete
```

Remote rollback deletes only manifest-owned namespaced component folders, internal tags, components, presets, unpublished draft stories with namespaced root components, exact namespaced assets, and matching namespaced asset folders. Published stories, unnamespaced resources, and unverified asset matches are refused or skipped.

## Command reference

```sh
html-to-storyblok
html-to-storyblok dashboard
html-to-storyblok settings [--show] [--set key=value] [--profile <name>]
html-to-storyblok env [--init] [--path .env.local] [--force] [--print]
html-to-storyblok doctor
html-to-storyblok view-report
html-to-storyblok completion [--shell zsh|bash|fish]
html-to-storyblok inspect-template --template <path>
html-to-storyblok inspect-repository --repo <path>
html-to-storyblok inspect-storyblok [--remote] [--full] [--audit]
html-to-storyblok storyblok-audit [--full]
html-to-storyblok inspect-storyblok-content --slug <slug> [--version draft|published]
html-to-storyblok inspect-netlify --repo <path>
html-to-storyblok check-access
html-to-storyblok netlify-preview --site-id <site-id> [--branch <branch>] [--verify] [--wait] [--include-logs]
html-to-storyblok plan --integration-id <id> [--storyblok-prefix <derived_prefix>] [--template <path>] [--schema-overrides <json>] [--repo <path>] [--infer-duplicates] [--framework auto|astro|react|next|vue|nuxt|static]
html-to-storyblok infer-duplicates --manifest <path> --repo <path> [--storyblok-inspection <path>] [--write-manifest]
html-to-storyblok validate-plan --manifest <path> [--severity all|error|warning]
html-to-storyblok storyblok-preflight --manifest <path> [--dry-run]
html-to-storyblok validate-storyblok --manifest <path> [--version draft|published] [--dry-run]
html-to-storyblok storyblok-reconcile --manifest <path>
html-to-storyblok storyblok-verify --manifest <path> [--dry-run]
html-to-storyblok storyblok-activities [--manifest <path>] [--since <iso-date>] [--limit 50]
html-to-storyblok examples [--manifest <path>]
html-to-storyblok diff --manifest <path> --repo <path>
html-to-storyblok repository-preflight --manifest <path> --repo <path>
html-to-storyblok validate --manifest <path> --repo <path>
html-to-storyblok build --repo <path> [--script build] [--dry-run]
html-to-storyblok generate --manifest <path> --repo <path> [--template <path>] [--framework auto|astro|react|next|vue|nuxt|static] [--dry-run]
html-to-storyblok duplicate --manifest <path> --repo <path> [--dry-run]
html-to-storyblok storyblok-component-groups --manifest <path> [--dry-run]
html-to-storyblok storyblok-internal-tags --manifest <path> [--dry-run]
html-to-storyblok storyblok-components --manifest <path> [--dry-run]
html-to-storyblok storyblok-asset-folders --manifest <path> [--dry-run]
html-to-storyblok upload-assets --manifest <path> [--dry-run]
html-to-storyblok storyblok-presets --manifest <path> [--dry-run]
html-to-storyblok create-draft-story --manifest <path> [--dry-run]
html-to-storyblok storyblok-apply --manifest <path> [--dry-run]
html-to-storyblok apply --manifest <path> --repo <path> [--template <path>] [--framework auto|astro|react|next|vue|nuxt|static] [--host-checks lint,typecheck,build] [--skip-host-checks] [--dry-run]
html-to-storyblok open-pr --repo <path> --title <title> [--base main] [--manifest <path> --prepare-branch --commit --push] [--dry-run]
html-to-storyblok open-mr --repo <path> --title <title> [--target-branch main] [--manifest <path> --prepare-branch --commit --push] [--dry-run]
html-to-storyblok rollback-preview --manifest <path> [--repo <path>]
html-to-storyblok rollback --manifest <path> --repo <path> --confirm-integration-id <id> [--remote --confirm-remote-delete] [--allow-modified-generated-files] [--dry-run]
html-to-storyblok report [--view] [--html]
```

Mutating commands support `--dry-run` and require the relevant credentials before real execution. Scripted commands that normally emit JSON also support `--json-summary` for compact CI output. Storyblok shortcut aliases are available for frequent operations: `sb-audit`, `sb-preflight`, `sb-validate`, `sb-reconcile`, `sb-verify`, `sb-activities`, and `sb-apply`.

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
html-to-storyblok inspect-template --template templates/acme-campaign
html-to-storyblok inspect-repository --repo ../client-site
html-to-storyblok inspect-storyblok
html-to-storyblok inspect-netlify --repo ../client-site
html-to-storyblok check-access

html-to-storyblok plan \
  --integration-id acme-campaign-v1 \
  --template templates/acme-campaign \
  --repo ../client-site \
  --schema-overrides templates/acme-campaign/schema-overrides.json \
  --framework auto

html-to-storyblok validate-plan \
  --manifest .tmp/html-to-storyblok/integration-manifest.json

html-to-storyblok apply \
  --manifest .tmp/html-to-storyblok/integration-manifest.json \
  --repo ../client-site \
  --template templates/acme-campaign \
  --framework auto \
  --dry-run

html-to-storyblok validate \
  --manifest .tmp/html-to-storyblok/integration-manifest.json \
  --repo ../client-site

html-to-storyblok report
```

## Production capability status

Implemented:

- Interactive wizard with the ID30 startup banner, session-only credential prompts, credential test screen, Storyblok-only test mode, resume dashboard, import history, one-step Storyblok execution, recovery menu, apply preview diff, link and field mapping editors, dashboard, live sandbox test, project profiles, settings, shell completion, doctor checks, report viewer with Storyblok/assets/links/activity/rollback drilldowns, report search, HTML export, shortcut aliases, compact JSON summaries, command examples, severity-filtered validation, skipped duplication diagnostics, and scriptable commands.
- Template conversion for static HTML, CSS, local assets, JSX/Vue-safe attributes, ID reference rewrites, multi-route isolated repository previews, review-only route proposal wrappers, and local JavaScript isolation.
- CSS namespacing and JavaScript isolation inside the integration root.
- Additive-only manifests with derived Storyblok prefixes and isolated repository namespaces.
- Opt-in frontend and Storyblok duplication candidate inference with dependency graph copying, style dependency namespacing, local JSON data copying, static asset copy planning, import/URL rewrites, skipped-candidate diagnostics, manifest validation, and duplicated-output validation.
- Richer Storyblok component schema generation for navigation, feature grids, galleries, testimonials, stats, pricing, steps/timelines, FAQ/accordion content, team/profile grids, CTA groups, forms, nested form fields, explicit template field hints, additive schema override files, route-specific draft story overrides, one-draft-story-per-route generation, draft story route link hydration, component folder creation, internal tag creation, component preset creation, asset folder creation, asset upload with source hashes, draft story asset hydration, Storyblok-only apply, and idempotent collision handling.
- Paginated Storyblok Management API reads for component folders, components, stories, asset folders, assets, internal tags, presets, workflows, workflow stages, releases, webhook endpoints, datasources, datasource entries, collaborators, space roles, activities, tasks, tags, branches, and approvals, with bounded remote inspection, retry/backoff, timeouts, optional request pacing, optional-collection failure tolerance, and webhook URL redaction.
- Storyblok preflight checks with a permission matrix, Content API draft story validation, Management API reconcile/verification, generated-link and asset-field checks, and filtered Storyblok activity evidence without exposing tokens.
- Netlify deploy-preview lookup, build contract verification, deploy-state polling, deploy log page references, and optional redacted Netlify CLI log snapshots.
- Local validation and diffing for generated files, adapter plans, route proposal wrappers, duplicated component files, dependency copies, and assets, plus repository collision/worktree preflight checks, apply preflight artifacts, incremental apply step artifacts, rollback previews, confirmed local rollback for integration-owned files and route-preview directories, and confirmed remote Storyblok rollback for integration-owned draft resources.
- Strict Storyblok safety validation for draft story location, namespaced story content components, and exact integration-owned asset reuse.
- GitHub draft pull-request and GitLab draft merge-request creation through their APIs, with optional branch preparation, scoped staging, commit, and push orchestration.
- Automated CLI acceptance coverage for the safe local workflow from planning through repository preflight, dry-run apply, real local generation, validation, report generation, rollback preview, and confirmed local rollback, plus a local static/Astro/Next/Nuxt/Vue/React demo-site matrix with Git safety checks, mocked Storyblok API coverage, and an opt-in live Storyblok sandbox test.

## Remaining limitations

- Duplication inference is conservative and opt-in. It now handles local code dependencies, barrel re-export dependencies, local style dependencies, local JSON data dependencies, safe path aliases, and resolvable local static assets, but still skips unresolved, unsupported, unsafe, or oversized dependency graphs and requires manifest review before apply.
- Schema generation covers common editorial patterns, several bespoke landing-page patterns, explicit template field hints, and additive schema override files. Highly bespoke modelling can still require review, but business-specific fields and namespaced nested relationships can now be supplied at planning time.
- Multi-page templates are inspected route by route, and the bundled fixture now contains five HTML routes. Storyblok planning creates one namespaced draft story per route, and repository conversion now writes isolated preview files for every route under `src/integrations/<integration-id>/routes/`, plus an adapter plan, guide, and `route-proposals/` wrappers for manual host wiring. These route previews and proposal wrappers are deliberately not registered with the host site router automatically.
- The default demo-site build checks validate generated integration shape, framework-specific preview files, route manifests, and existing-file safety without installing full Astro/Next/Nuxt/Vue/React dependency trees. The opt-in generated demo runner can temporarily wire generated route proposals and compile them through the real Astro/Next/Nuxt/Vue/React framework builds. Before wiring an import into a real client route, still run that client repository's own install and browser checks.
- Netlify raw deploy logs are not exposed through the Netlify REST verification path. Use `--include-logs` with `netlify-cli` installed, or use the Netlify UI for full deploy output; `html-to-storyblok doctor` reports whether the CLI is available.
- Optional Storyblok audit collections such as approvals, branches, workflow stages, or activities may be unavailable depending on the Storyblok plan, space features, token scope, and region. The audit records unavailable collections instead of treating them as a failed import.
- Live Storyblok, Netlify, GitHub, and GitLab calls require credentials from the shell environment, `.env` / `.env.local`, or the interactive session; use `html-to-storyblok check-access` to verify readiness.
- No command modifies existing registries, routes, dependencies, Storyblok resources, or Netlify configuration.

## Validation

```sh
npm run check
npm run lint
npm run typecheck
npm run security:audit
npm test
npm run test:demo-sites-full:list
```

`npm run check` discovers checkable JavaScript/MJS files under `bin/`, `src/`, `test/`, `scripts/`, and `demo-sites/scripts/` and runs `node --check` against each one. GitHub Actions runs the same syntax check and test suite on pushes to `main` and pull requests.

The test suite includes a temp-directory end-to-end CLI workflow test that exercises the production command path without requiring live Storyblok, Netlify, GitHub, or GitLab credentials.

To validate the demo sites with real framework compilers and preview smoke checks, run:

```sh
npm run test:demo-sites-full:install
```

This installs each demo site's dependencies, runs its dependency-light build contract, runs the real framework build where available, starts the framework preview server, and fetches the configured preview URL. It is intentionally opt-in because it downloads Astro, Next, Nuxt, Vue, React, Vite, and Storyblok framework packages.

To also compile generated route proposal handoffs through each real framework compiler, run:

```sh
npm run test:demo-sites-generated
```

To run the opt-in live Storyblok sandbox test against a disposable integration namespace:

```sh
STORYBLOK_MANAGEMENT_TOKEN=... \
STORYBLOK_SPACE_ID=... \
STORYBLOK_PREVIEW_TOKEN=... \
npm run test:storyblok-live
```

The live test creates namespaced components, asset folders, assets, and unpublished draft stories, validates the drafts when a Content API token is provided, then runs confirmed remote rollback for that generated integration ID.
