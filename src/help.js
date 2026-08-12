const COMMAND_GUIDES = {
  interactive: {
    title: 'Interactive Wizard',
    purpose: 'Launches the guided terminal application for first-time or repeat imports.',
    usage: ['html-to-storyblok'],
    when: [
      'Use this when you want the CLI to discover templates, repositories, credentials, plans, validation, and apply steps for you.'
    ],
    evidence: ['Writes manifests, validation results, reports, and step evidence under .tmp/html-to-storyblok.'],
    safety: ['Uses the same additive-only planner, validator, and apply pipeline as the power-user commands.'],
    examples: ['html-to-storyblok']
  },
  onboarding: {
    title: 'First-Time Onboarding',
    purpose: 'Explains what is configured, what is missing, and which workflow is safest to run next.',
    usage: ['html-to-storyblok onboarding [--work-dir .tmp/html-to-storyblok]'],
    when: [
      'Use this on a new workstation or before handing the CLI to someone who has not run an import before.',
      'Use it when the interactive wizard says setup is incomplete and you want a concise checklist.'
    ],
    evidence: ['Writes onboarding-guide.json under the work directory with redacted readiness evidence.'],
    safety: [
      'Read-only. It does not create Storyblok resources, modify repositories, or store secrets.',
      'It reports credential source labels only, never token values.'
    ],
    examples: [
      'html-to-storyblok onboarding',
      'html-to-storyblok onboarding --work-dir .tmp/html-to-storyblok'
    ],
    next: ['settings', 'env', 'doctor', 'interactive']
  },
  doctor: {
    title: 'Doctor',
    purpose: 'Checks the local machine, credentials, repository, and service readiness before an import.',
    usage: ['html-to-storyblok doctor [--for all|storyblok-only|full-import|netlify-preview|repo-only]'],
    when: [
      'Run before client work, before live Storyblok testing, or when the wizard reports a missing dependency.'
    ],
    evidence: ['Writes doctor output into the command evidence stream and keeps secrets redacted.'],
    safety: ['Read-only. It does not create files in the target repository or mutate Storyblok.'],
    examples: [
      'html-to-storyblok doctor --for storyblok-only',
      'html-to-storyblok doctor --for full-import'
    ]
  },
  env: {
    title: 'Environment Setup',
    purpose: 'Creates or prints the local .env scaffold used for credentials and deployed demo URLs.',
    usage: ['html-to-storyblok env [--init] [--path .env.local] [--force] [--print]'],
    when: [
      'Use --init when setting up a workstation, and --print when you need to inspect the supported variable names.'
    ],
    evidence: ['Writes an env init result artifact when it creates a local scaffold.'],
    safety: ['Never writes real secret values. Existing env files are preserved unless --force is supplied.'],
    examples: [
      'html-to-storyblok env --print',
      'html-to-storyblok env --init --path .env.local'
    ]
  },
  plan: {
    title: 'Plan',
    purpose: 'Creates the additive integration manifest from a template and optional target repository.',
    usage: [
      'html-to-storyblok plan --integration-id <id> --template <path> [--repo <path>] [--framework auto|astro|react|next|vue|nuxt|static] [--infer-duplicates]'
    ],
    when: [
      'Use this after inspecting a template and repository, or when scripting the same steps the wizard runs.'
    ],
    evidence: ['Writes integration-manifest.json and records the plan in integration history.'],
    safety: [
      'Generated Storyblok components, stories, folders, assets, CSS, and repository files are namespaced by the integration ID.',
      'The resulting manifest is validated before it can be applied.'
    ],
    examples: [
      'html-to-storyblok plan --integration-id acme-campaign-v1 --template templates/acme-campaign --repo ../client-site --framework auto',
      'html-to-storyblok plan --integration-id storyblok-test-v1 --template templates/acme-campaign --framework static'
    ],
    next: ['validate-plan', 'storyblok-preflight', 'apply --dry-run']
  },
  readiness: {
    title: 'Readiness Handoff',
    purpose: 'Builds a client-ready evidence report before handoff or production apply.',
    usage: [
      'html-to-storyblok readiness --manifest <path> [--repo <path>] [--template <path>] [--remote] [--require-storyblok] [--require-repository]'
    ],
    when: [
      'Use after a successful plan or apply to confirm what is ready, what was checked, and what still needs attention.'
    ],
    evidence: ['Writes readiness-result.json and readiness-report.md under the work directory.'],
    safety: ['Read-only. Remote checks are inspection-only and do not mutate Storyblok.'],
    examples: [
      'html-to-storyblok readiness --manifest .tmp/html-to-storyblok/integration-manifest.json --repo ../client-site --template templates/acme-campaign',
      'html-to-storyblok handoff --manifest .tmp/html-to-storyblok/integration-manifest.json --remote --require-storyblok'
    ]
  },
  'handoff-pack': {
    title: 'Production Handoff Pack',
    purpose: 'Packages the final review evidence for an imported template into one JSON file and one Markdown handoff document.',
    usage: [
      'html-to-storyblok handoff-pack --manifest <path> [--repo <path>] [--template <path>] [--remote] [--skip-readiness]'
    ],
    when: [
      'Use after dry run or real apply when David, the client team, QA, or editors need one concise handoff document.',
      'Use after Storyblok-only testing to show draft story links, validation status, assets, rollback scope, and remaining next actions.'
    ],
    evidence: [
      'Writes production-handoff-pack.json and production-handoff-pack.md under the work directory.',
      'Reads existing report, history, route handoff, Storyblok validation, Netlify, rollback, and apply artifacts.'
    ],
    safety: [
      'Read-only apart from writing local evidence files.',
      'Optional --remote performs the same read-only Storyblok reconciliation used by readiness.',
      'Does not publish content, modify existing stories, overwrite routes, or delete resources.'
    ],
    examples: [
      'html-to-storyblok handoff-pack --manifest .tmp/html-to-storyblok/integration-manifest.json --repo ../client-site --template templates/acme-campaign',
      'html-to-storyblok production-handoff --manifest .tmp/html-to-storyblok/integration-manifest.json --remote',
      'html-to-storyblok handoff-pack --manifest .tmp/html-to-storyblok/integration-manifest.json --skip-readiness'
    ],
    next: ['view-report', 'readiness', 'rollback-preview', 'wire-routes']
  },
  'evidence-index': {
    title: 'Handoff Evidence Index',
    purpose: 'Builds a compact checklist of the exact files, links, checks, and next commands needed for client or internal sign-off.',
    usage: [
      'html-to-storyblok evidence-index --manifest <path> [--repo <path>]'
    ],
    when: [
      'Use after apply or before a project update to show what evidence exists and what is still missing.',
      'Use it when a reviewer does not want to inspect JSON artifacts or search through .tmp/html-to-storyblok manually.'
    ],
    evidence: ['Writes handoff-evidence-index.json and handoff-evidence-index.md.'],
    safety: [
      'Read-only apart from writing local evidence files.',
      'It does not run checks, create routes, mutate Storyblok, publish content, or expose secrets.',
      'It indexes existing reports, apply results, draft Storyblok editor links, route previews, rollback evidence, deployment evidence, and recommended next commands.'
    ],
    examples: [
      'html-to-storyblok evidence-index --manifest .tmp/html-to-storyblok/integration-manifest.json --repo ../client-site',
      'html-to-storyblok handoff-index --manifest .tmp/html-to-storyblok/integration-manifest.json'
    ],
    next: ['handoff-pack', 'view-report', 'platform-readiness']
  },
  'template-quality': {
    title: 'Template Quality',
    purpose: 'Scores a supplied template across route/SEO, editorial hints, assets, JavaScript safety, CSS isolation, accessibility, forms, and third-party dependencies.',
    usage: ['html-to-storyblok template-quality --template <path> [--minimum-score 75]'],
    when: [
      'Use before planning when design or content teams need a clear handoff score.',
      'Use --minimum-score in CI or agency intake checks when low-quality templates should stop the workflow.'
    ],
    evidence: ['Writes template-inventory.json and template-quality.json under the work directory.'],
    safety: ['Read-only. It does not modify the template, repository, or Storyblok.'],
    examples: [
      'html-to-storyblok template-quality --template templates/acme-campaign',
      'html-to-storyblok template-quality --template templates/acme-campaign --minimum-score 75'
    ],
    next: ['template-readiness', 'plan', 'readiness']
  },
  'visual-editor-readiness': {
    title: 'Visual Editor Readiness',
    purpose: 'Checks whether an imported integration is ready for Storyblok Visual Editor preview and handoff.',
    usage: [
      'html-to-storyblok visual-editor-readiness --manifest <path> [--repo <path>] [--preview-url <https-url>] [--require-preview-url]'
    ],
    when: [
      'Use after generation or apply, before asking editors to review imported draft stories in Storyblok.',
      'Use with --repo to check generated renderer files, route proposals, bridge evidence, and iframe/CSP handoff signals.'
    ],
    evidence: ['Writes visual-editor-readiness-result.json and visual-editor-readiness-report.md.'],
    safety: [
      'Read-only against the repository and manifest.',
      'Does not change Storyblok stories, components, assets, or production content.'
    ],
    examples: [
      'html-to-storyblok visual-editor-readiness --manifest .tmp/html-to-storyblok/integration-manifest.json --repo ../client-site --preview-url https://preview.example.com',
      'html-to-storyblok ve-readiness --manifest .tmp/html-to-storyblok/integration-manifest.json --require-preview-url'
    ],
    next: ['demo-sites-live-preview', 'wire-routes', 'readiness']
  },
  'client-review': {
    title: 'Client Apply Review Gate',
    purpose: 'Builds read-only evidence that a repository apply will stay isolated before an existing client site is touched.',
    usage: [
      'html-to-storyblok client-review --manifest <path> --repo <path> [--host-checks lint,typecheck,build] [--skip-host-checks] [--dry-run]'
    ],
    when: [
      'Use before a real full apply to review planned repository writes, host route safety, host script discovery, and route handoff readiness.',
      'Use after generate or apply --dry-run to see concrete route proposal handoff evidence.'
    ],
    evidence: ['Writes client-review-gate.json and client-review-gate-report.md under the work directory.'],
    safety: [
      'Read-only. It does not generate files, wire routes, mutate Storyblok, or run host scripts.',
      'It treats route handoff blockers as review warnings unless the base repository preflight itself fails.'
    ],
    examples: [
      'html-to-storyblok client-review --manifest .tmp/html-to-storyblok/integration-manifest.json --repo ../client-site',
      'html-to-storyblok apply-review --manifest .tmp/html-to-storyblok/integration-manifest.json --repo ../client-site --host-checks lint,build'
    ],
    next: ['apply --dry-run', 'wire-routes', 'readiness']
  },
  'asset-dashboard': {
    title: 'Asset Integrity Dashboard',
    purpose: 'Summarizes planned assets, local source hashes, Storyblok upload evidence, and unresolved draft asset fields.',
    usage: ['html-to-storyblok asset-dashboard [--work-dir .tmp/html-to-storyblok]'],
    when: [
      'Use after planning to verify local asset sources and after apply to confirm uploaded or reused Storyblok assets.',
      'Use when a report says asset fields are unresolved or when editors cannot see imported images in draft stories.'
    ],
    evidence: ['Reads integration-manifest.json, apply-result/storyblok-apply-result artifacts, Content API validation, and Management API verification summaries.'],
    safety: ['Read-only. It does not upload, delete, or modify assets.'],
    examples: [
      'html-to-storyblok asset-dashboard',
      'html-to-storyblok asset-dashboard --work-dir .tmp/html-to-storyblok'
    ],
    next: ['upload-assets', 'storyblok-verify', 'view-report']
  },
  'storyblok-apply': {
    title: 'Storyblok Apply',
    purpose: 'Runs only the Storyblok side of the import: folders, components, presets, assets, and draft stories.',
    usage: ['html-to-storyblok storyblok-apply --manifest <path> [--dry-run]'],
    when: [
      'Use this to test Storyblok integration before touching a repository.',
      'Use --dry-run first to preview every remote operation.'
    ],
    evidence: ['Writes Storyblok step artifacts, validation output, verification output, and the final report.'],
    safety: [
      'Creates draft-only, namespaced resources.',
      'Does not overwrite existing Storyblok components or modify published content.'
    ],
    examples: [
      'html-to-storyblok storyblok-apply --manifest .tmp/html-to-storyblok/integration-manifest.json --dry-run',
      'html-to-storyblok storyblok-apply --manifest .tmp/html-to-storyblok/integration-manifest.json'
    ],
    next: ['storyblok-verify', 'validate-storyblok', 'rollback-preview']
  },
  apply: {
    title: 'Full Apply',
    purpose: 'Runs the full repository and Storyblok integration pipeline.',
    usage: [
      'html-to-storyblok apply --manifest <path> --repo <path> [--template <path>] [--framework auto|astro|react|next|vue|nuxt|static] [--host-checks lint,typecheck,build] [--skip-host-checks] [--dry-run]'
    ],
    when: [
      'Use after the dry run, plan validation, Storyblok preflight, and repository preflight are clean.'
    ],
    evidence: ['Writes step artifacts, generated file evidence, remote Storyblok evidence, validation output, and report.md.'],
    safety: [
      'Refuses repository target collisions before writing generated files.',
      'Creates isolated integration files and draft-only Storyblok resources.'
    ],
    examples: [
      'html-to-storyblok apply --manifest .tmp/html-to-storyblok/integration-manifest.json --repo ../client-site --template templates/acme-campaign --dry-run',
      'html-to-storyblok apply --manifest .tmp/html-to-storyblok/integration-manifest.json --repo ../client-site --template templates/acme-campaign'
    ],
    next: ['wire-routes', 'readiness', 'open-pr']
  },
  'wire-routes': {
    title: 'Wire Routes',
    purpose: 'Creates additive host route handoff files after the isolated integration has been generated.',
    usage: ['html-to-storyblok wire-routes --manifest <path> --repo <path> [--route home|about|/path] [--dry-run]'],
    when: [
      'Use when Storyblok and generated integration files are ready, and the target framework can safely expose preview routes.'
    ],
    evidence: ['Writes route-handoff-result.json and route-handoff-report.md with created, blocked, or manual handoff routes.'],
    safety: [
      'Never overwrites existing app routes.',
      'Blocks when a host route already exists and gives manual handoff guidance for frameworks that need it.'
    ],
    examples: [
      'html-to-storyblok wire-routes --manifest .tmp/html-to-storyblok/integration-manifest.json --repo ../client-site --dry-run',
      'html-to-storyblok route-handoff --manifest .tmp/html-to-storyblok/integration-manifest.json --repo ../client-site --route /about'
    ]
  },
  'demo-sites-live-preview': {
    title: 'Live Demo Site Preview',
    purpose: 'Checks deployed demo URLs and proves imported routes are rendering Storyblok draft content.',
    usage: [
      'html-to-storyblok demo-sites-live-preview [--site astro] [--base-url <url>] [--routes /,/about] [--integration-id <id>] [--require-storyblok-draft] [--require-configured] [--visual] [--visual-baseline <file>] [--report-path <file>]'
    ],
    when: [
      'Use after deploying demo sites to Netlify and configuring the Storyblok preview token.',
      'Use --visual to record deterministic HTML visual fingerprints, then --visual-baseline to fail route checks on unexpected rendered structure changes.'
    ],
    evidence: ['Writes demo-sites-live-preview-result.json and a markdown evidence report by default. Use --write-visual-baseline <file> to store visual fingerprints for later comparison.'],
    safety: ['Read-only HTTP checks. It does not change Storyblok, Netlify, GitHub, or repository files.'],
    examples: [
      'html-to-storyblok demo-sites-live-preview --list',
      'html-to-storyblok demo-sites-live-preview --site astro --base-url https://your-astro-demo.netlify.app --integration-id acme-campaign-v1 --require-storyblok-draft --require-configured',
      'html-to-storyblok demo-sites-live-preview --site astro --base-url https://your-astro-demo.netlify.app --visual --write-visual-baseline .tmp/html-to-storyblok/astro-visual-baseline.json',
      'html-to-storyblok demo-sites-live-preview --site astro --base-url https://your-astro-demo.netlify.app --visual-baseline .tmp/html-to-storyblok/astro-visual-baseline.json'
    ]
  },
  'demo-sites-e2e': {
    title: 'End-to-End Demo Deployment',
    purpose: 'Runs the local demo matrix and deployed preview checks as one release-readiness gate.',
    usage: [
      'html-to-storyblok demo-sites-e2e [--site astro,next] [--generated] [--install] [--smoke] [--require-framework] [--require-live] [--require-storyblok-draft] [--integration-id <id>] [--visual] [--visual-baseline <file>] [--report-path <file>]'
    ],
    when: [
      'Use after Storyblok, GitHub, Netlify, and demo-site wiring are in place.',
      'Use before a client handoff to prove the generated repository output still builds and deployed preview URLs render the expected imported routes.'
    ],
    evidence: [
      'Writes demo-sites-e2e-result.json, demo-sites-e2e-report.md, and phase-specific local/live preview reports by default.'
    ],
    safety: [
      'Read-only against deployed URLs.',
      'Temporary generated local demo output is restored by the underlying demo-sites runner unless --keep-generated is used.'
    ],
    examples: [
      'html-to-storyblok demo-sites-e2e --site astro --generated --install --smoke --require-framework --astro-url https://your-astro-demo.netlify.app --require-live',
      'html-to-storyblok demo-sites-e2e --site astro --astro-url https://your-astro-demo.netlify.app --integration-id acme-campaign-v1 --require-storyblok-draft --require-live --visual-baseline .tmp/html-to-storyblok/astro-visual-baseline.json'
    ],
    next: ['demo-sites-live-preview', 'report', 'readiness']
  },
  'demo-sites': {
    title: 'Demo Site Matrix',
    purpose: 'Builds the local framework demo matrix and optionally validates generated integration output.',
    usage: [
      'html-to-storyblok demo-sites [--list] [--site astro,next] [--generated] [--install] [--smoke] [--require-framework] [--report-path <file>]'
    ],
    when: [
      'Use before live demos to prove Astro, Next, Nuxt, React, Vue, and static examples still build locally.'
    ],
    evidence: ['Writes demo-sites-validation-result.json and a markdown preview report by default.'],
    safety: ['Runs against demo sites and generated test output, not client production repositories.'],
    examples: [
      'html-to-storyblok demo-sites --list',
      'html-to-storyblok demo-sites --site astro,next --generated --smoke --require-framework'
    ]
  },
  report: {
    title: 'Report',
    purpose: 'Compiles command evidence, validation, generated files, warnings, and failures into a review report.',
    usage: ['html-to-storyblok report [--view] [--html]'],
    when: ['Use after a dry run, failed run, successful apply, or before handoff to a reviewer.'],
    evidence: ['Reads evidence artifacts and writes report.md, with optional HTML output.'],
    safety: ['Read-only against repositories and Storyblok.'],
    examples: [
      'html-to-storyblok report',
      'html-to-storyblok report --html',
      'html-to-storyblok view-report'
    ]
  },
  rollback: {
    title: 'Rollback',
    purpose: 'Removes only integration-owned generated files and optionally verified namespaced Storyblok resources.',
    usage: [
      'html-to-storyblok rollback-preview --manifest <path> [--repo <path>]',
      'html-to-storyblok rollback --manifest <path> --repo <path> --confirm-integration-id <id> [--remote --confirm-remote-delete] [--allow-modified-generated-files] [--dry-run]'
    ],
    when: [
      'Use rollback-preview first when an import needs to be removed or a failed apply needs recovery.'
    ],
    evidence: ['Writes rollback-preview.json or rollback-result.json.'],
    safety: [
      'Requires explicit integration ID confirmation.',
      'Refuses modified generated files unless explicitly allowed.',
      'Refuses published Storyblok story deletion.'
    ],
    examples: [
      'html-to-storyblok rollback-preview --manifest .tmp/html-to-storyblok/integration-manifest.json --repo ../client-site',
      'html-to-storyblok rollback --manifest .tmp/html-to-storyblok/integration-manifest.json --repo ../client-site --confirm-integration-id acme-campaign-v1 --dry-run'
    ]
  },
  storyblok: {
    title: 'Storyblok Workflow',
    purpose: 'Recommended order for validating and applying the Storyblok side of an import.',
    usage: [
      'html-to-storyblok inspect-storyblok --remote --full',
      'html-to-storyblok storyblok-preflight --manifest <path>',
      'html-to-storyblok storyblok-apply --manifest <path> --dry-run',
      'html-to-storyblok storyblok-apply --manifest <path>',
      'html-to-storyblok validate-storyblok --manifest <path>',
      'html-to-storyblok storyblok-verify --manifest <path>'
    ],
    when: ['Use this guide when the repository side is being skipped or tested later.'],
    evidence: ['Each step writes a dedicated artifact under .tmp/html-to-storyblok.'],
    safety: ['All resources must be namespaced and remain draft-only unless manually reviewed outside the CLI.'],
    examples: ['html-to-storyblok help storyblok']
  },
  repository: {
    title: 'Repository Workflow',
    purpose: 'Recommended order for integrating generated output into an existing site without breaking it.',
    usage: [
      'html-to-storyblok inspect-repository --repo <path>',
      'html-to-storyblok repository-preflight --manifest <path> --repo <path>',
      'html-to-storyblok apply --manifest <path> --repo <path> --dry-run',
      'html-to-storyblok apply --manifest <path> --repo <path>',
      'html-to-storyblok platform-readiness --manifest <path> --repo <path>',
      'html-to-storyblok route-collisions --manifest <path> --repo <path>',
      'html-to-storyblok wire-routes --manifest <path> --repo <path> --dry-run'
    ],
    when: ['Use this after Storyblok apply is stable and the target site is ready for local integration testing.'],
    evidence: ['Preflight, apply, validation, and route handoff each write separate artifacts.'],
    safety: ['The CLI creates isolated files under the integration namespace and blocks existing route/file collisions.'],
    examples: ['html-to-storyblok help repository']
  },
  'platform-readiness': {
    title: 'Platform Readiness',
    purpose: 'Confirms the generated integration is ready for the target framework before imported routes are exposed.',
    usage: [
      'html-to-storyblok platform-readiness --manifest <path> --repo <path> [--route home|about|/path] [--require-automatic-routes]'
    ],
    when: [
      'Run after generate/apply has written adapter-plan.json and before route-collisions or wire-routes.',
      'Use --require-automatic-routes in CI when React, Vue, or static manual handoff should block the pipeline.'
    ],
    evidence: ['Writes platform-readiness.json and platform-readiness-report.md.'],
    safety: [
      'Read-only. It does not create host route files, edit router registries, mutate Storyblok, or expose secrets.',
      'It verifies generated route preview/proposal files and keeps Content API token guidance separate from Management API credentials.',
      'It reports Astro, Next, and Nuxt as automatic route-file targets; React, Vue, and static projects require manual router handoff.'
    ],
    examples: [
      'html-to-storyblok platform-readiness --manifest .tmp/html-to-storyblok/integration-manifest.json --repo ../client-site',
      'html-to-storyblok framework-readiness --manifest .tmp/html-to-storyblok/integration-manifest.json --repo ../client-site --require-automatic-routes'
    ],
    next: ['route-collisions', 'wire-routes', 'validate']
  },
  'route-checklist': {
    title: 'Route Handoff Checklist',
    purpose: 'Creates per-route acceptance criteria and handoff steps for automatic and manual framework routing.',
    usage: [
      'html-to-storyblok route-checklist --manifest <path> --repo <path> [--route home|about|/path]'
    ],
    when: [
      'Run after platform-readiness and before wire-routes or manual host-router registration.',
      'Use this when React, Vue, or static projects need explicit router handoff instructions for client/project-owner review.'
    ],
    evidence: ['Writes route-handoff-checklist.json and route-handoff-checklist.md.'],
    safety: [
      'Read-only. It runs route handoff preview logic but does not create host route files.',
      'It keeps Astro, Next, and Nuxt automatic route-file steps separate from React, Vue, and static manual-router steps.',
      'It includes Content API token reminders and acceptance criteria without exposing secrets.'
    ],
    examples: [
      'html-to-storyblok route-checklist --manifest .tmp/html-to-storyblok/integration-manifest.json --repo ../client-site',
      'html-to-storyblok route-guide --manifest .tmp/html-to-storyblok/integration-manifest.json --repo ../client-site --route /about'
    ],
    next: ['wire-routes', 'evidence-index', 'demo-sites-e2e']
  },
  'route-collisions': {
    title: 'Route Collision Analysis',
    purpose: 'Checks whether imported routes can be exposed without taking over existing host routes or being masked by Netlify rewrites.',
    usage: [
      'html-to-storyblok route-collisions --manifest <path> --repo <path> [--route home|about|/path]'
    ],
    when: [
      'Run after generate/apply has written the adapter plan and before wire-routes creates host route files.',
      'Use --route to isolate one imported path while debugging a collision.'
    ],
    evidence: ['Writes route-collision-analysis.json and route-collision-analysis-report.md.'],
    safety: [
      'Read-only. It does not create host route files or edit Netlify configuration.',
      'Exact host route files and dynamic route overlaps block automatic route wiring.',
      'Netlify redirect and rewrite overlaps are warnings because they may mask the imported route at deploy time.'
    ],
    examples: [
      'html-to-storyblok route-collisions --manifest .tmp/html-to-storyblok/integration-manifest.json --repo ../client-site',
      'html-to-storyblok route-collisions --manifest .tmp/html-to-storyblok/integration-manifest.json --repo ../client-site --route /about'
    ],
    next: ['wire-routes', 'validate']
  }
};

export function renderHelpTopic(topic) {
  const key = String(topic || '').trim();
  const guide = COMMAND_GUIDES[key];
  if (!guide) return renderUnknownTopic(key);
  return renderGuide(key, guide);
}

export function helpTopicNames() {
  return Object.keys(COMMAND_GUIDES).sort();
}

function renderGuide(key, guide) {
  return `html-to-storyblok help ${key}

${guide.title}

Purpose
  ${guide.purpose}

Usage
${renderLines(guide.usage)}

When To Use
${renderLines(guide.when)}

Evidence
${renderLines(guide.evidence)}

Safety
${renderLines(guide.safety)}

Examples
${renderLines(guide.examples)}
${guide.next ? `
Next Commands
${renderLines(guide.next)}` : ''}
`;
}

function renderUnknownTopic(topic) {
  return `No dedicated help guide exists for "${topic}".

Available help topics:
${renderLines(helpTopicNames())}
`;
}

function renderLines(lines) {
  return lines.map((line) => `  - ${line}`).join('\n');
}
