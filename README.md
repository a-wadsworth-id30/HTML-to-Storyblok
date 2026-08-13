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
npm install
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

`npm install` is only required for local dependencies such as the optional desktop app. The core CLI remains scriptable through `node bin/html-to-storyblok.js` and `html-to-storyblok`.

## Interactive CLI

Run the command without arguments to launch the guided terminal experience:

```sh
html-to-storyblok
```

Interactive startup displays the compact ID30 ASCII banner in `ascii-art.txt`, converted from `id30-logo.svg`, followed by the ID30 developer credit and proprietary-use legal notice. Non-interactive help output also includes the same branding and legal notice.

On a new or incomplete workstation, the CLI now shows a first-run readiness panel before the goal picker. This panel checks safe local defaults, template discovery, nearby repository discovery, Storyblok Management API readiness, Storyblok Preview API readiness, Netlify readiness, and GitHub/GitLab review automation readiness. It recommends the safest next action without printing or storing secrets.

Interactive mode opens with a goal picker so first-time users can choose the outcome they want before seeing the full command-style menu:

```text
────────────────────────────────────────────

Start Here
Choose the outcome you want. The CLI will pick the right workflow.

Common Goals
✓ Full Import            Template, repository, Storyblok, validation, and report
✓ Storyblok Only         Components, assets, and draft stories without a repository
• Resume                 Continue or recover an existing integration
• Evidence               Review reports, history, validation, and generated files

What are you trying to do?

❯ Import Template Into Existing Site
  Test Storyblok Only
  First-Time Setup Guide
  Resume Failed Or Previous Import
  Validate Existing Import
  Set Up Or Test Credentials
  View Reports And Evidence
  Show Full Main Menu
  Exit
```

Major wizard steps now include a compact context panel showing the workflow, current step, selected template, selected repository, and integration ID where available. The full home screen remains available for users who prefer direct task selection:

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

Dry runs now include a human-readable apply preview diff covering repository files, assets, route preview/proposal paths, Storyblok component folders, internal tags, components, presets, asset folders, draft stories, and generated Storyblok link resolution. Long-running progress output uses a single task-owned progress renderer with percentages, elapsed time, and rate-limit/retry detail so spinner output does not collide with progress bars.

Real repository apply runs a read-only client apply review gate, then available host `lint`, `typecheck`, and `build` scripts before writing generated files, then runs local output validation and the same host checks again before any Storyblok remote mutation. Missing scripts are reported as skipped, failing scripts stop the apply. Use `--host-checks lint,typecheck,build` to customize the script list, or `--skip-host-checks` only when you have already run equivalent checks.

The client apply review gate is also available as `html-to-storyblok client-review --manifest <path> --repo <path>`. It packages repository preflight, planned write isolation, host route preservation, route handoff preview readiness, host script discovery, and next steps into `.tmp/html-to-storyblok/client-review-gate-report.md` without generating files, wiring routes, running host scripts, or mutating Storyblok.

After a completed interactive action, the CLI shows what changed, Storyblok draft editor links, generated route preview files, validation/report locations, remote transaction ledger status, and a rollback-preview command. It then shows a success checkpoint with the latest plan/local validation status, evidence-driven recommended next actions, suggested follow-up commands, and stays open on a `Next` menu. Recommendations include asset integrity, asset field graph blockers, Storyblok link validation, route collision analysis, route handoff, local validation, and handoff pack creation. From there you can return to the main menu, run a validation check, view the latest report, or exit intentionally.

If an interactive action fails, the wizard stays open and shows a recovery assistant before the recovery menu. Common failures such as Storyblok rate limits, draft story drift, missing credentials, Storyblok preflight failures, repository preflight failures, host build failures, Content API validation failures, and Management API verification failures are mapped to a clear problem, likely cause, recommended fix, affected resource when known, and useful follow-up commands. From there you can inspect the affected resource, test credentials, start a new integration ID, retry the failed action, validate the current state, view the latest report, show a rollback preview, return to the main menu, or exit intentionally. Rollback remains explicit and never runs automatically.

Recovery guidance is implemented in a dedicated recovery module and reused by the interactive CLI, so new failure classifications can be added without expanding the main wizard controller.

When you only want to test the Storyblok side before a client repository is available, choose `Test Storyblok Only` from the home screen, or choose `Skip Repository - Storyblok only test` when the create flow asks for a repository. This path still inspects the template, derives the same namespaced component schema, validates the additive-only plan, dry-runs all Storyblok operations, and can optionally run the real Storyblok apply. It does not generate repository files, inspect a repository, change routes, or require `--repo`.

If `.tmp/html-to-storyblok/integration-manifest.json` already exists, the CLI offers to resume the previous integration or start a new one. The resume screen shows the integration ID, latest status, completed apply steps, validation state, failed step if any, and the recommended next action. From the continue workflow you can also review or edit generated Storyblok links, review or edit generated schema field types and labels, run one Storyblok apply step at a time, preview apply changes, wire missing host route files from generated route proposals, and show rollback targets before applying.

`Import History` reads the durable `.tmp/html-to-storyblok/import-history.json` ledger so you can see multiple integrations, statuses, report paths, and manifest snapshots without opening JSON files manually. It still shows recent evidence commands and artifacts as supporting detail. `Live Sandbox Test` guides a disposable Storyblok-only test against a namespaced integration ID, validates the drafts when a Content API token is available, and can roll back generated remote resources.

For CI/CD or scripted usage, pass `--no-interactive` and use the command reference below. The no-command `--no-interactive` path prints help instead of launching a prompt.

## Desktop App

The project now includes an Electron desktop control panel for team members who are more comfortable with a GUI than a terminal:

```sh
npm run desktop
```

or, after `npm link`:

```sh
html-to-storyblok desktop
```

Use `html-to-storyblok desktop --dry-run` to verify the launcher path without opening the app.

The desktop app is intentionally a thin layer over the existing CLI. It does not duplicate planner, validator, generator, Storyblok, route, rollback, or reporting logic. Buttons in the app run whitelisted CLI actions such as onboarding, doctor, template inspection, repository inspection, Storyblok inspection, plan, validate, dry run, real apply, route handoff, Storyblok validation, report generation, evidence index, handoff pack, and rollback preview.

Desktop safety rules:

- The GUI cannot run arbitrary shell commands; it uses the shared `src/desktop-actions.js` action registry.
- Real apply buttons ask for confirmation and still run the same additive-only CLI safety gates.
- Storyblok content remains draft-only and namespaced by integration ID.
- Session credentials are passed to child CLI runs as environment variables and are not stored in settings, reports, command lines, or browser localStorage.
- Non-secret paths and workflow fields can be remembered locally by the app for convenience, and the desktop default work directory lives under Electron `userData` so packaged builds do not need to write into the application bundle.
- The Electron renderer runs with context isolation, no Node integration, sandboxing, a restrictive Content Security Policy, blocked arbitrary navigation/window creation, denied permission prompts, trusted IPC sender checks, and artifact opening limited to known evidence/report filenames.

The intended split is:

- Senior developers can continue using terminal commands and the interactive CLI.
- PM, design, QA, account, and content team members can use the desktop app to run safe checks, inspect evidence, and follow the same import runbook without memorising commands.

## Dashboard, Settings, Doctor, and Reports

View a human-readable project dashboard:

```sh
html-to-storyblok dashboard
```

Review first-run setup guidance at any time:

```sh
html-to-storyblok onboarding
```

This writes `.tmp/html-to-storyblok/onboarding-guide.json` and prints a concise checklist covering configuration, discovered templates, discovered repositories, credential source labels, workflow readiness, and recommended next steps. It is read-only and never writes secret values.

View the scriptable multi-integration ledger:

```sh
html-to-storyblok history
html-to-storyblok history --limit 20
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

Get focused guidance for a command or workflow:

```sh
html-to-storyblok help plan
html-to-storyblok storyblok-apply --help
html-to-storyblok help storyblok
html-to-storyblok help repository
```

The focused help screens explain when to use the command, the required evidence artifacts, safety guarantees, examples, and suggested next commands. Use them when scripting a workflow or handing a process to another developer.

Credential handling:

- Interactive mode asks for missing Storyblok credentials when inspection or real apply needs them.
- `Test Credentials` in the home screen checks Management API readiness, manifest preflight, and Content API draft validation when the relevant credentials are available.
- Tokens entered in the wizard are kept in memory for that CLI run only.
- The Preview API token prompt is optional; press `Enter` to skip it when you only need Management API component, asset, and draft-story testing.
- Local credentials should live in `.env.local` or shell environment variables, not in `settings`.
- Scriptable commands read credentials from shell environment variables and local `.env` / `.env.local` files.
- Shell environment variables override `.env` values.
- `.env` values are loaded from the current working directory and, when `--repo` or a selected repository is available, the target repository.
- Credential readiness output shows safe source labels such as `shell`, `env file .env.local`, `settings profile`, or `session prompt`; it never prints token values.
- Reports and evidence record variable names only, never secret values.

Run environment and project readiness checks:

```sh
html-to-storyblok doctor [--for all|storyblok-only|full-import|netlify-preview|repo-only]
html-to-storyblok doctor --for storyblok-only
html-to-storyblok doctor --for full-import
html-to-storyblok doctor --for netlify-preview
html-to-storyblok doctor --for repo-only
```

The default doctor checks Node.js, npm, Git, optional Netlify CLI availability for log snapshots, Storyblok credentials, Netlify credentials, GitHub/GitLab credentials, required folders, and repository health, then prints actionable fixes for warnings or failures. Credential checks include source labels for configured variables, such as `STORYBLOK_SPACE_ID from env file .env.local`, without exposing values. Use `--for` to run a task-aware profile so optional services do not look like blockers when they are unrelated to the current workflow:

- `storyblok-only`: Node, npm, template folder, required Management API credentials, and optional Content API credentials.
- `full-import`: Node, npm, Git, template folder, repository health, required Management API credentials, and optional Content API credentials.
- `netlify-preview`: Node, npm, Git, repository health, Netlify credentials, and optional Netlify CLI support.
- `repo-only`: Node, npm, Git, template folder, and repository health only.

Create a client handoff readiness report:

```sh
html-to-storyblok readiness \
  --manifest .tmp/html-to-storyblok/integration-manifest.json \
  --repo ../client-site \
  --template templates/acme-campaign
```

`readiness` is read-only. It validates the additive-only manifest, scores the template intake, inspects the repository, runs repository preflight in safe dry-run mode, checks credential sources, performs Storyblok preflight, optionally reconciles remote Storyblok state with `--remote`, builds a rollback preview, and writes `.tmp/html-to-storyblok/readiness-report.md`. Use `--require-storyblok` or `--require-repository` when missing credentials or repository context should fail the handoff gate instead of appearing as warnings. `handoff` is an alias for the same command.

Create a compact handoff evidence index:

```sh
html-to-storyblok evidence-index \
  --manifest .tmp/html-to-storyblok/integration-manifest.json \
  --repo ../client-site
```

`evidence-index` is read-only apart from writing `.tmp/html-to-storyblok/handoff-evidence-index.md` and `.tmp/html-to-storyblok/handoff-evidence-index.json`. It gives project managers and reviewers one concise index of required evidence files, Storyblok draft editor links, route preview files, route/platform handoff state, rollback evidence, deployed preview evidence, sign-off checklist status, and next commands. Use it before status updates or client handoff when you need to answer "what evidence do we have and what is missing?" without opening every JSON artifact. `handoff-index`, `evidence`, and `project-evidence` are aliases.

Create the final production handoff pack:

```sh
html-to-storyblok handoff-pack \
  --manifest .tmp/html-to-storyblok/integration-manifest.json \
  --repo ../client-site \
  --template templates/acme-campaign
```

`handoff-pack` writes `.tmp/html-to-storyblok/production-handoff-pack.md` and `.tmp/html-to-storyblok/production-handoff-pack.json`. It packages the integration summary, Storyblok draft editor links, route preview files, route handoff state, validation state, asset integrity, the asset reference graph, rollback scope, evidence files, sign-off checklist, and next actions into one review-ready document. It runs the same read-only readiness checks by default; pass `--skip-readiness` to package only existing evidence. `production-handoff` and `handoff-report` are aliases.

Open the interactive report viewer:

```sh
html-to-storyblok view-report
html-to-storyblok report --view
html-to-storyblok report --html
```

The report viewer exposes summary, validation, evidence, generated files, warnings, failures, Storyblok drilldowns, Management API content-drift verification, activity timelines, recommended next actions, report search, and optional standalone HTML report export without requiring users to inspect JSON manually.

The report viewer also includes Storyblok, assets, asset reference graph, links, and rollback-target sections so you can inspect created/reused resources, story fields that use uploaded assets, unresolved generated story links, and cleanup scope without opening JSON artifacts directly.

For a scriptable asset integrity dashboard:

```sh
html-to-storyblok asset-dashboard
html-to-storyblok asset-graph
```

This read-only command summarizes planned repository assets, planned Storyblok assets, local source availability, SHA-256 hashes, upload dry-run evidence, real uploaded/reused assets, Storyblok asset IDs, Management API asset-field verification, Content API asset counts, and unresolved draft asset fields.

`asset-graph` is also read-only. It writes `.tmp/html-to-storyblok/asset-reference-graph.json` and joins planned assets, repository copy targets, Storyblok upload evidence, and every generated story field that references an asset. Use it when a draft story image looks wrong or missing: the output shows the source reference, story slug, field path, component, upload status, remote Storyblok asset ID, ambiguous aliases, and unresolved story asset fields.

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
- multi-integration history and manifest snapshots
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

Run the designer handoff readiness gate before planning:

```sh
html-to-storyblok template-readiness --template templates/acme-homepage
html-to-storyblok template-quality --template templates/acme-homepage --minimum-score 75
```

`template-readiness` writes `.tmp/html-to-storyblok/template-readiness.json` and returns:

- `passed` when the template is ready for planning
- `warning` when the import can continue but needs human review
- `failed` when blockers such as missing assets or unsafe local scripts should be fixed first

The readiness gate checks for HTML routes, missing local assets, page titles, H1s, explicit editorial field hints, third-party URLs, external scripts, inline handlers, local unsafe JavaScript, forms, accessibility issues, global CSS selectors, font licence review, and unsupported files. It also includes a weighted template quality profile with category grades for route/SEO readiness, editorial model signals, asset health, JavaScript safety, CSS isolation readiness, accessibility, form production readiness, and third-party dependency review. `template-quality` outputs only that quality profile and can fail CI or agency intake with `--minimum-score`. The interactive wizard shows the same readiness status, quality grade, and top issues during template inspection.

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

The same validation is also available through the CLI:

```sh
html-to-storyblok demo-sites --generated --install --smoke --require-framework
```

This temporarily wires a generated route proposal into each demo site, runs the real Astro, Next, Nuxt, Vue, and React framework builds, starts preview servers, checks HTTP HTML responses, and records per-route smoke evidence before restoring the demo files. For Astro, Next, and Nuxt, the generated route smoke check verifies the imported route URL, integration root, `data-hts-storyblok-source` marker, and Storyblok slug marker. React and Vue Vite demos are reported as client app shell checks by HTTP fetch, then backed by compiled bundle evidence proving the generated integration ID and Storyblok seed content were included in the built client bundle. The runner writes a readable `.tmp/html-to-storyblok/demo-sites-preview-report.md` by default; pass `--report-path <file>` to write it elsewhere or `--report false` to skip it. Use `html-to-storyblok demo-sites --list` to inspect the configured local demo targets. Use browser smoke or visual regression checks for final client handoff.

After demo sites are deployed, run the live preview smoke checker against their public URLs:

```sh
HTS_DEMO_ASTRO_URL=https://your-astro-demo.netlify.app \
HTS_DEMO_NEXT_URL=https://your-next-demo.netlify.app \
npm run test:demo-sites-live-preview
```

The same live check is available through the CLI:

```sh
html-to-storyblok demo-sites-live-preview --list
html-to-storyblok demo-sites-live-preview --site astro --base-url https://your-astro-demo.netlify.app --require-configured
html-to-storyblok demo-sites-live-preview --site astro --base-url https://your-astro-demo.netlify.app --integration-id acme-campaign-v1 --require-storyblok-draft --require-configured
```

Use `--require-configured` when CI should fail if no deployed URL is present, and use `--require-storyblok-draft --integration-id <integration-id>` after the deployed site has the Storyblok preview token configured. That stricter mode requires each imported route to return a hidden `data-hts-storyblok-source="storyblok-draft"` marker instead of silently falling back to generated static content. Non-list live checks write `.tmp/html-to-storyblok/demo-sites-live-preview-report.md` by default; pass `--report-path <file>` to write it elsewhere or `--report false` to skip the markdown report.

Live preview checks can also record deterministic visual fingerprints from the rendered HTML:

```sh
html-to-storyblok demo-sites-live-preview --site astro --base-url https://your-astro-demo.netlify.app --visual --write-visual-baseline .tmp/html-to-storyblok/astro-visual-baseline.json
html-to-storyblok demo-sites-live-preview --site astro --base-url https://your-astro-demo.netlify.app --visual-baseline .tmp/html-to-storyblok/astro-visual-baseline.json
```

The visual baseline captures stable route evidence such as document title, primary and secondary headings, image sources and alt text, link targets, integration root markers, Storyblok source markers, and structural counts. It is intentionally browser-free so it can run in CI without screenshot tooling; use browser screenshots as a later design QA layer when human pixel review is required.

For a single handoff gate that combines local generated-framework validation with deployed preview validation, run the end-to-end demo deployment check:

```sh
html-to-storyblok demo-sites-e2e --generated --install --smoke --require-framework --require-live --integration-id acme-campaign-v1 --require-storyblok-draft
```

`demo-sites-e2e` runs the local `demo-sites` phase, runs the deployed `demo-sites-live-preview` phase, keeps their phase-specific reports, and writes a consolidated `.tmp/html-to-storyblok/demo-sites-e2e-report.md`. Use `--require-live` when missing deployed URLs should fail the gate, `--skip-local` or `--skip-live` to isolate one side while debugging, and `--local-report-path` / `--live-report-path` when CI needs deterministic artifact names. The command is read-only against deployed URLs and remains additive-only for temporary local demo output.

Before handing imported draft stories to editors, run the Visual Editor readiness report:

```sh
html-to-storyblok visual-editor-readiness --manifest .tmp/html-to-storyblok/integration-manifest.json --repo ../client-site --preview-url https://preview.example.com
```

This read-only check verifies planned draft stories, block identity, generated `_editable` marker preservation, isolated preview roots, route proposal draft slugs, Storyblok Bridge evidence, HTTPS preview URLs, and iframe/CSP handoff signals. It writes `.tmp/html-to-storyblok/visual-editor-readiness-result.json` and `.tmp/html-to-storyblok/visual-editor-readiness-report.md`. Use `--require-preview-url` when the preview URL should be a blocking handoff requirement.

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
- write a non-mutating client apply review gate covering planned writes, route preservation, route handoff readiness, host script discovery, and next steps
- run a non-mutating Storyblok preflight when Storyblok operations are planned
- duplicate approved frontend and Storyblok components into the integration namespace
- convert supplied template HTML/CSS/assets into isolated framework files and route previews
- validate the generated local integration before remote mutations
- create or reuse matching integration-owned Storyblok component folders
- create or reuse matching integration-owned Storyblok internal tags
- create new Storyblok components and refresh the remote transaction ledger after each completed Storyblok mutation step
- create or reuse matching integration-owned Storyblok asset folders
- upload new Storyblok assets listed in the manifest
- create or reuse matching integration-owned Storyblok component presets
- create new draft Storyblok stories with asset fields hydrated from the uploaded Storyblok assets
- validate created draft stories through the Storyblok Content API when a preview/delivery token is available
- reconcile and verify created Storyblok resources through the Management API using a refreshed apply-scoped remote state snapshot
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

Route preview files use route-relative local asset paths, so a preview under `routes/home/` resolves copied template assets from the generated integration folder instead of relying on the root preview path. Dry-run and completion output now lists the generated route preview file and route proposal wrapper for each imported route. The generated `adapter-plan.json`, `INTEGRATION_GUIDE.md`, and `route-proposals/` files provide framework-specific import examples, route-to-story mappings, review-only route wrapper modules, suggested host-route file names, and required checks before wiring the import into a real route. `generate` and `apply` do not register these routes with the host application. After review, `wire-routes` can explicitly create missing Astro, Next, or Nuxt host route files from those proposals; it refuses existing host route files, existing dynamic route overlaps, duplicate imported paths, and unsafe host route targets, then writes nothing when a collision is detected. React, Vue, and static projects receive structured manual handoff guidance instead of automatic router mutation because their route registration is project-specific.

Wired Astro, Next, and Nuxt route files include an optional server-side Storyblok Content API draft fetch. When `STORYBLOK_PREVIEW_TOKEN`, `STORYBLOK_PUBLIC_TOKEN`, or `STORYBLOK_DELIVERY_TOKEN` is available in the target site's runtime environment, the route attempts to fetch the generated draft story by slug with `version=draft` and passes the live story content into the imported route proposal. If no token is configured, or the Content API request fails, the route falls back to the generated preview without exposing secrets or failing the build. Wired routes also render a hidden `data-hts-storyblok-source` marker with `storyblok-draft` or `generated-fallback`, plus the generated Storyblok slug, so deployed smoke tests can prove whether the live Content API path is active.

Preview or run the safe route handoff:

```sh
html-to-storyblok platform-readiness \
  --manifest .tmp/html-to-storyblok/integration-manifest.json \
  --repo ../client-site

html-to-storyblok route-checklist \
  --manifest .tmp/html-to-storyblok/integration-manifest.json \
  --repo ../client-site

html-to-storyblok route-collisions \
  --manifest .tmp/html-to-storyblok/integration-manifest.json \
  --repo ../client-site

html-to-storyblok wire-routes \
  --manifest .tmp/html-to-storyblok/integration-manifest.json \
  --repo ../client-site \
  --dry-run
```

`platform-readiness` is read-only. It writes `.tmp/html-to-storyblok/platform-readiness.json` and `.tmp/html-to-storyblok/platform-readiness-report.md`, checking that generated adapter evidence exists for the detected framework, every imported route has a preview and route proposal wrapper, the adapter still proves additive-only route policy, route collision analysis is clear enough to continue, host build/check scripts are discoverable, and the deployed site is expected to use a Storyblok Content API token rather than a Management API token. Astro, Next, and Nuxt are reported as automatic route-file handoff targets; React, Vue, and static projects are reported as manual host-router handoff targets. Add `--require-automatic-routes` when this should be a CI-blocking gate.

`route-checklist` is read-only. It writes `.tmp/html-to-storyblok/route-handoff-checklist.json` and `.tmp/html-to-storyblok/route-handoff-checklist.md`, combining platform readiness, route proposal evidence, route collision status, dry-run route handoff status, per-route acceptance criteria, manual React/Vue/static router steps, Content API token reminders, and browser smoke-test expectations. Use it before `wire-routes` or before handing a React/Vue/static route registration task to the client project owner. `route-handoff-checklist`, `routing-checklist`, and `route-guide` are aliases.

`route-collisions` is read-only. It writes `.tmp/html-to-storyblok/route-collision-analysis.json` and `.tmp/html-to-storyblok/route-collision-analysis-report.md`, scanning Astro, Next, Nuxt, and common `pages`/`app` route files, duplicate planned imported paths, dynamic/catch-all route overlaps, and Netlify `_redirects` / `netlify.toml` rewrite rules. Exact route files, dynamic route overlaps, duplicate imported paths, and unsafe host route targets block automatic wiring. Netlify rewrite/redirect overlaps are warnings because they may mask deployed routes even though the CLI does not edit Netlify configuration.

Omit `--dry-run` only after reviewing the generated route proposal wrappers, route collision analysis, and repository validation. The command is additive-only: it creates new host route files such as `src/pages/about.astro`, `src/app/about/page.jsx`, or `pages/about.vue` only when they do not already exist and no analyzer blocker is present. Every CLI run writes `.tmp/html-to-storyblok/route-handoff-report.md` alongside `route-handoff-result.json`, covering route status, suggested host files, Storyblok draft slugs, SEO fallback evidence, collision analysis, manual handoff instructions, and required checks. Generic React/Vue router projects and static templates are reported as manual-review targets because route registration depends on the host router configuration. For those projects, `wire-routes` returns the generated route proposal file, suggested site path, Storyblok draft slug, safe Content API reminder, React Router/Vue Router/custom-shell integration options, and host-router registration steps.

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

Storyblok Management API requests retry `429` rate-limit responses and transient `5xx` failures with backoff. A `429` response also sets a shared backoff window for later Management API requests against the same space, so the next apply step slows down instead of immediately hitting the same limit again. Requests use configurable timeouts, and `STORYBLOK_REQUEST_INTERVAL_MS` can be set to pace requests for stricter rate-limit environments. If an earlier run stopped part-way through because of rate limiting, rerun the same manifest/integration ID; matching namespaced resources are reused and remaining resources continue from the manifest.

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

Existing Storyblok assets are reused only when the match is integration-owned and exact. The CLI compares the manifest filename/path and the resolved integration asset folder, so a generic existing asset with the same basename, such as `logo.svg`, is not treated as a safe match unless it belongs to the planned integration namespace. Upload evidence includes the local byte size and SHA-256 hash for each source file. `asset-dashboard` combines that evidence with manifest, upload, Content API, and Management API verification results so missing files or unresolved draft asset fields are visible without opening JSON artifacts. `asset-graph` goes one level deeper by showing which story/component field uses each asset and whether that field resolved to uploaded Storyblok media.

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

Draft story creation uses `publish: false`. Templates create one integration-owned story folder named `<integration-id>` and place imported draft stories inside it. `index.html` is mapped to `<integration-id>/home`; multi-page templates create additional stories such as `<integration-id>/about`, `<integration-id>/services`, and `<integration-id>/contact`. Internal template links that match generated routes, such as `/about`, `about.html`, `./services.html?ref=nav#plans`, `../gallery/index.html#work`, `/contact`, or `/gallery#work`, are converted into Storyblok story links pointing at the generated draft stories with anchors preserved where Storyblok supports them. Pure anchors, query-only links, external URLs, protocol-relative URLs, `mailto:`, and `tel:` links remain URL links. The generated plan includes `link_resolution` evidence with planned routes, resolved story-link counts, URL-link counts, anchor-link counts, and unresolved internal targets for review. During real Storyblok apply, created route stories are resolved back to their Storyblok UUIDs so multilink fields include `id`, `cached_url`, `url`, and `fieldtype`. If an unpublished integration-owned draft from an earlier run only has `cached_url`, apply safely repairs that link metadata without changing non-integration stories. The integration-specific story folder is created or reused additively when needed. Existing matching draft stories are treated as idempotent, including Storyblok-generated editor and asset metadata; published or genuinely differing stories are treated as blockers. If a draft story was created by an earlier version with unresolved local asset paths or under `integration-preview/`, rerun with a new integration ID or use confirmed remote rollback for the integration-owned draft resources before applying again.

Run the complete Storyblok-only workflow without a repository:

```sh
html-to-storyblok storyblok-apply \
  --manifest .tmp/html-to-storyblok/integration-manifest.json \
  --dry-run
```

This combines component folder creation, internal tag creation, component creation, Storyblok component duplication, asset folder creation, asset upload, component preset creation, draft story creation, Content API validation when possible, Management API reconcile/verification, and activity evidence capture. It is useful for validating the Storyblok side of a template before a target repository exists. For real execution, omit `--dry-run`; the command requires `STORYBLOK_MANAGEMENT_TOKEN` and `STORYBLOK_SPACE_ID`, or credentials entered in the interactive wizard.

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

This combines reconcile with story-level checks for unpublished imported drafts, namespaced root and nested components, generated story links with UUID metadata, generated links that target planned routes, asset fields that have been hydrated to uploaded Storyblok assets rather than local template paths, and remote draft-story content matching the hydrated manifest. Management verification hydrates planned component and story summaries through single-resource Management API reads when list responses omit schema or story content. Component schema and draft-story content checks compare the intended contract while ignoring Storyblok-generated editor metadata; genuine content drift is reported in `summary.content_drifted_stories`.

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

Rollback preview and confirmed rollback results include a `rollback_ledger` section. The ledger records the integration ID confirmation state, repository path, local target count, owned/unsafe target count, hash-ledger status, removed and missing files, directories to prune, remote target counts, remote confirmation state, remote result totals, and risk flags such as `remote_resources_not_requested`, `hash_ledger_unavailable`, `missing_hash_entries`, or `generated_file_drift_detected`. Reports and the interactive report viewer surface the latest rollback ledger so reviewers can understand exactly what would be removed before any destructive action is confirmed.

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
html-to-storyblok onboarding
html-to-storyblok dashboard
html-to-storyblok settings [--show] [--set key=value] [--profile <name>]
html-to-storyblok env [--init] [--path .env.local] [--force] [--print]
html-to-storyblok doctor
html-to-storyblok view-report
html-to-storyblok asset-dashboard
html-to-storyblok asset-graph
html-to-storyblok completion [--shell zsh|bash|fish]
html-to-storyblok inspect-template --template <path>
html-to-storyblok template-readiness --template <path>
html-to-storyblok template-quality --template <path> [--minimum-score 75]
html-to-storyblok inspect-repository --repo <path>
html-to-storyblok inspect-storyblok [--remote] [--full] [--audit]
html-to-storyblok storyblok-audit [--full]
html-to-storyblok inspect-storyblok-content --slug <slug> [--version draft|published]
html-to-storyblok inspect-netlify --repo <path>
html-to-storyblok check-access
html-to-storyblok netlify-preview --site-id <site-id> [--branch <branch>] [--verify] [--wait] [--include-logs]
html-to-storyblok readiness --manifest <path> [--repo <path>] [--template <path>] [--remote] [--require-storyblok] [--require-repository]
html-to-storyblok evidence-index --manifest <path> [--repo <path>]
html-to-storyblok handoff-pack --manifest <path> [--repo <path>] [--template <path>] [--remote] [--skip-readiness]
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
html-to-storyblok client-review --manifest <path> --repo <path> [--host-checks lint,typecheck,build] [--skip-host-checks] [--dry-run]
html-to-storyblok validate --manifest <path> --repo <path>
html-to-storyblok build --repo <path> [--script build] [--dry-run]
html-to-storyblok generate --manifest <path> --repo <path> [--template <path>] [--framework auto|astro|react|next|vue|nuxt|static] [--dry-run]
html-to-storyblok platform-readiness --manifest <path> --repo <path> [--route home|about|/path] [--require-automatic-routes]
html-to-storyblok route-checklist --manifest <path> --repo <path> [--route home|about|/path]
html-to-storyblok route-collisions --manifest <path> --repo <path> [--route home|about|/path]
html-to-storyblok wire-routes --manifest <path> --repo <path> [--route home|about|/path] [--dry-run]
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
html-to-storyblok asset-dashboard
html-to-storyblok asset-graph
```

Mutating commands support `--dry-run` and require the relevant credentials before real execution. Scripted commands that normally emit JSON also support `--json-summary` for compact CI output. `route-handoff` is an alias for `wire-routes`; `route-analyzer`, `route-analysis`, and `route-collision-analysis` are aliases for `route-collisions`; `route-handoff-checklist`, `routing-checklist`, and `route-guide` are aliases for `route-checklist`; `platform-check`, `adapter-readiness`, and `framework-readiness` are aliases for `platform-readiness`; `repository-review` and `apply-review` are aliases for `client-review`; `handoff` is an alias for `readiness`; `handoff-index`, `evidence`, and `project-evidence` are aliases for `evidence-index`; `production-handoff` and `handoff-report` are aliases for `handoff-pack`; `live-demo-sites` is an alias for `demo-sites-live-preview`; `asset-map` is an alias for `asset-graph`. Storyblok shortcut aliases are available for frequent operations: `sb-audit`, `sb-preflight`, `sb-validate`, `sb-reconcile`, `sb-verify`, `sb-activities`, and `sb-apply`.

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

- Interactive wizard with the ID30 startup banner, first-run onboarding readiness panel, dedicated `onboarding` command, session-only credential prompts, safe credential source display, credential test screen, Storyblok-only test mode, template readiness and quality scoring, resume dashboard, durable multi-integration history with manifest snapshots, one-step Storyblok execution, recovery menu, evidence-driven next-action recommendations, apply preview diff with repository route preview summaries, safe route handoff preview/application, route handoff evidence reports, link and field mapping editors, dashboard, asset integrity dashboard, live sandbox test, project profiles, settings, shell completion, doctor checks, readiness handoff reports, handoff evidence indexes, production handoff packs, report viewer with Storyblok/assets/links/routes/activity/rollback drilldowns, report search, HTML export, shortcut aliases, compact JSON summaries, command examples, severity-filtered validation, skipped duplication diagnostics, a first-pass Electron desktop app for non-terminal users, and scriptable commands.
- Template conversion for static HTML, CSS, local assets, JSX/Vue-safe attributes, ID reference rewrites, Storyblok field hydration for hinted text, rich text, asset, link, and form fields, safe Storyblok `_editable` marker preservation for generated previews, route SEO metadata extraction from template head tags, multi-route isolated repository previews, review-only route proposal wrappers, read-only platform readiness and route handoff checklists, opt-in additive host route handoff for Astro/Next/Nuxt with optional live Storyblok draft fetching and route metadata fallback, and local JavaScript isolation.
- CSS namespacing and JavaScript isolation inside the integration root.
- Additive-only manifests with derived Storyblok prefixes and isolated repository namespaces.
- Opt-in frontend and Storyblok duplication candidate inference with dependency graph copying, style dependency namespacing, local JSON data copying, static asset copy planning, import/URL rewrites, skipped-candidate diagnostics, manifest validation, and duplicated-output validation.
- Richer Storyblok component schema generation for navigation, feature grids, galleries, testimonials, stats, pricing, steps/timelines, FAQ/accordion content, team/profile grids, CTA groups, forms, nested form fields, editable root SEO fields, explicit template field hints, additive schema override files, route-specific draft story and metadata overrides, one-draft-story-per-route generation, page-aware internal route link resolution, draft story route link hydration, component folder creation, internal tag creation, component preset creation, asset folder creation, asset upload with source hashes, draft story asset hydration, remote transaction ledger evidence, Storyblok-only apply, and idempotent collision handling.
- Paginated Storyblok Management API reads for component folders, components, stories, asset folders, assets, internal tags, presets, workflows, workflow stages, releases, webhook endpoints, datasources, datasource entries, collaborators, space roles, activities, tasks, tags, branches, and approvals, with bounded remote inspection, retry/adaptive rate-limit backoff, timeouts, optional request pacing, apply-scoped Management API state caching for final verification, optional-collection failure tolerance, and webhook URL redaction.
- Storyblok preflight checks with a permission matrix, Content API draft story validation, Management API reconcile/verification, hydrated draft-story content drift checks, generated-link and asset-field checks, and filtered Storyblok activity evidence without exposing tokens.
- Netlify deploy-preview lookup, build contract verification, deploy-state polling, deploy log page references, and optional redacted Netlify CLI log snapshots.
- Local validation and diffing for generated files, adapter plans, route proposal wrappers, duplicated component files, dependency copies, and assets, plus repository collision/worktree preflight checks, apply preflight artifacts, incremental apply step artifacts, rollback previews with structured ledgers, confirmed local rollback for integration-owned files and route-preview directories, and confirmed remote Storyblok rollback for integration-owned draft resources.
- Strict Storyblok safety validation for draft story location, namespaced story content components, and exact integration-owned asset reuse.
- GitHub draft pull-request and GitLab draft merge-request creation through their APIs, with optional branch preparation, scoped staging, commit, and push orchestration.
- Automated CLI acceptance coverage for the safe local workflow from planning through repository preflight, dry-run apply, real local generation, validation, report generation, rollback preview, and confirmed local rollback, plus a local static/Astro/Next/Nuxt/Vue/React demo-site matrix with Git safety checks, mocked Storyblok API coverage, and an opt-in live Storyblok sandbox test.

## Remaining limitations

- Duplication inference is conservative and opt-in. It now handles local code dependencies, barrel re-export dependencies, local style dependencies, local JSON data dependencies, safe path aliases, and resolvable local static assets, but still skips unresolved, unsupported, unsafe, or oversized dependency graphs and requires manifest review before apply.
- Template readiness and template quality scoring are static designer-handoff gates. They catch missing assets, unsafe scripts, weak route metadata, forms, third-party dependencies, accessibility warnings, CSS globals, font licence review, unsupported files, and missing field hints before planning, but they do not replace browser rendering, visual regression, client QA, or Storyblok editor review.
- Schema generation covers common editorial patterns, several bespoke landing-page patterns, explicit template field hints, and additive schema override files. Highly bespoke modelling can still require review, but business-specific fields and namespaced nested relationships can now be supplied at planning time.
- Generated framework previews hydrate template markup from Storyblok draft fields through the integration-owned renderer. This works best when templates include explicit `data-hts-field` hints for editorial text, images, links, and form controls. It is not a replacement for a hand-authored production component system when a client needs fully bespoke frontend behavior, Visual Editor bridge annotations throughout custom components, or complex conditional rendering.
- When live Storyblok draft content includes `_editable` comments, generated previews preserve safe root and top-level block markers so the Visual Editor has a better bridge into imported preview output. This is still a preview-oriented bridge; a fully hand-authored component renderer remains the right target for complex per-block editing behavior.
- Route SEO generation covers common static head metadata such as title, description, canonical URL, robots, Open Graph, and Twitter fields. It seeds editable root fields and Storyblok `meta_data` for new imported drafts, and wired Astro/Next/Nuxt routes use those values as a fallback until live draft content is available. It does not attempt to merge with an existing site's custom SEO plugin, layout-level metadata pipeline, sitemap, redirects, or structured data implementation.
- Multi-page templates are inspected route by route, and the bundled fixture now contains five HTML routes. Storyblok planning creates one namespaced draft story per route, and repository conversion now writes isolated preview files for every route under `src/integrations/<integration-id>/routes/`, plus an adapter plan, guide, and `route-proposals/` wrappers. These route previews and proposal wrappers are deliberately not registered by `generate` or `apply`; `platform-readiness` proves generated adapter evidence and expected framework handoff mode, then `wire-routes` is the explicit opt-in handoff and only creates missing Astro/Next/Nuxt route files with optional Content API draft hydration. React, Vue, and static projects receive structured manual handoff guidance, framework-specific integration options, and markdown platform/route handoff reports instead of automatic router mutation.
- The default demo-site build checks validate generated integration shape, framework-specific preview files, route manifests, and existing-file safety without installing full Astro/Next/Nuxt/Vue/React dependency trees. The opt-in generated demo runner can temporarily wire generated route proposals, compile them through the real Astro/Next/Nuxt/Vue/React framework builds, record preview smoke evidence for generated routes, and verify React/Vue generated code reaches the compiled client bundle. Before wiring an import into a real client route, still run that client repository's own install, browser checks, and visual review.
- Netlify raw deploy logs are not exposed through the Netlify REST verification path. Use `--include-logs` with `netlify-cli` installed, or use the Netlify UI for full deploy output; `html-to-storyblok doctor` reports whether the CLI is available.
- Optional Storyblok audit collections such as approvals, branches, workflow stages, or activities may be unavailable depending on the Storyblok plan, space features, token scope, and region. The audit records unavailable collections instead of treating them as a failed import.
- Live Storyblok, Netlify, GitHub, and GitLab calls require credentials from the shell environment, `.env` / `.env.local`, or the interactive session; use `html-to-storyblok check-access` to verify readiness.
- No command overwrites existing registries, routes, dependencies, Storyblok resources, or Netlify configuration. `wire-routes` can create new missing host route files only after preview and collision checks.

## Validation

```sh
npm run check
npm run lint
npm run typecheck
npm run security:audit
npm test
npm run test:demo-sites-full:list
npm run test:demo-sites-apply
npm run test:demo-sites-live-preview
npm run test:demo-sites-e2e
npm run test:visual-regression
npm run test:visual-editor-readiness
```

`npm run check` discovers checkable JavaScript/MJS files under `bin/`, `src/`, `test/`, `scripts/`, `desktop/`, and `demo-sites/scripts/` and runs `node --check` against each one. GitHub Actions runs the same syntax check and test suite on pushes to `main` and pull requests.

The test suite includes a temp-directory end-to-end CLI workflow test that exercises the production command path without requiring live Storyblok, Netlify, GitHub, or GitLab credentials.

To validate that the repository side of the real apply pipeline remains additive-only across every supported demo framework, run:

```sh
npm run test:demo-sites-apply
```

This copies the static, Astro, Next, Nuxt, Vue, and React demo sites into temporary repositories, runs `applyManifest` with remote Storyblok operations disabled, verifies generated route proposals and adapter plans, runs host build checks, and confirms existing app entry files remain byte-for-byte unchanged.

To validate the demo sites with real framework compilers and preview smoke checks, run:

```sh
npm run test:demo-sites-full:install
html-to-storyblok demo-sites --install --smoke --require-framework
```

This installs each demo site's dependencies, runs its dependency-light build contract, runs the real framework build where available, starts the framework preview server, and fetches the configured preview URL. It is intentionally opt-in because it downloads Astro, Next, Nuxt, Vue, React, Vite, and Storyblok framework packages.

To also compile generated route proposal handoffs through each real framework compiler, run:

```sh
npm run test:demo-sites-generated
html-to-storyblok demo-sites --generated --install --smoke --require-framework
```

To check deployed demo sites and catch missing Netlify routes or Storyblok preview-token issues:

```sh
npm run test:demo-sites-live-preview -- --list
html-to-storyblok demo-sites-live-preview --list
HTS_DEMO_ASTRO_URL=https://your-astro-demo.netlify.app \
npm run test:demo-sites-live-preview -- --site astro --require-configured
html-to-storyblok demo-sites-live-preview --site astro --base-url https://your-astro-demo.netlify.app --require-configured --report-path .tmp/html-to-storyblok/astro-live-preview.md
HTS_DEMO_ASTRO_URL=https://your-astro-demo.netlify.app \
npm run test:demo-sites-live-preview -- --site astro --integration-id acme-campaign-v1 --require-storyblok-draft --require-configured
html-to-storyblok demo-sites-live-preview --site astro --base-url https://your-astro-demo.netlify.app --integration-id acme-campaign-v1 --require-storyblok-draft --require-configured
```

To create or enforce visual baselines for deployed demo routes:

```sh
npm run test:visual-regression
html-to-storyblok demo-sites-live-preview --site astro --base-url https://your-astro-demo.netlify.app --visual --write-visual-baseline .tmp/html-to-storyblok/astro-visual-baseline.json
html-to-storyblok demo-sites-e2e --site astro --astro-url https://your-astro-demo.netlify.app --integration-id acme-campaign-v1 --require-live --require-storyblok-draft --visual-baseline .tmp/html-to-storyblok/astro-visual-baseline.json
```

To check Storyblok Visual Editor handoff readiness:

```sh
npm run test:visual-editor-readiness
html-to-storyblok visual-editor-readiness --manifest .tmp/html-to-storyblok/integration-manifest.json --repo ../client-site --preview-url https://preview.example.com
```

To run the combined local plus deployed demo-site handoff gate:

```sh
npm run test:demo-sites-e2e -- --site astro --astro-url https://your-astro-demo.netlify.app --integration-id acme-campaign-v1 --require-live --require-storyblok-draft
html-to-storyblok demo-sites-e2e --site astro --generated --install --smoke --require-framework --astro-url https://your-astro-demo.netlify.app --integration-id acme-campaign-v1 --require-live --require-storyblok-draft
```

To run the opt-in live Storyblok sandbox test against a disposable integration namespace:

```sh
STORYBLOK_MANAGEMENT_TOKEN=... \
STORYBLOK_SPACE_ID=... \
STORYBLOK_PREVIEW_TOKEN=... \
npm run test:storyblok-live
```

The live test creates namespaced components, asset folders, assets, and unpublished draft stories, validates the drafts when a Content API token is provided, then runs confirmed remote rollback for that generated integration ID.
