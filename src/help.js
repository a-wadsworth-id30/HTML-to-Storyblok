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
      'html-to-storyblok demo-sites-live-preview [--site astro] [--base-url <url>] [--routes /,/about] [--integration-id <id>] [--require-storyblok-draft] [--require-configured] [--report-path <file>]'
    ],
    when: [
      'Use after deploying demo sites to Netlify and configuring the Storyblok preview token.'
    ],
    evidence: ['Writes demo-sites-live-preview-result.json and a markdown evidence report by default.'],
    safety: ['Read-only HTTP checks. It does not change Storyblok, Netlify, GitHub, or repository files.'],
    examples: [
      'html-to-storyblok demo-sites-live-preview --list',
      'html-to-storyblok demo-sites-live-preview --site astro --base-url https://your-astro-demo.netlify.app --integration-id acme-campaign-v1 --require-storyblok-draft --require-configured'
    ]
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
      'html-to-storyblok wire-routes --manifest <path> --repo <path> --dry-run'
    ],
    when: ['Use this after Storyblok apply is stable and the target site is ready for local integration testing.'],
    evidence: ['Preflight, apply, validation, and route handoff each write separate artifacts.'],
    safety: ['The CLI creates isolated files under the integration namespace and blocks existing route/file collisions.'],
    examples: ['html-to-storyblok help repository']
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
