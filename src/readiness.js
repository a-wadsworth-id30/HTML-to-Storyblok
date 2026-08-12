import path from 'node:path';
import { checkLiveAccess } from './access.js';
import { writeArtifact } from './evidence.js';
import { inspectRepository, inspectTemplate } from './inspectors.js';
import { validatePlan } from './policy.js';
import { createRollbackPreview } from './rollback.js';
import { preflightRepositoryIntegration } from './validator.js';
import { preflightStoryblokIntegration, reconcileStoryblokManifest } from './storyblok.js';
import { ensureArray, writeText } from './utils.js';

export async function createReadinessHandoff({
  manifest,
  repoPath = null,
  templatePath = null,
  workDir,
  env = process.env,
  remote = false,
  requireStoryblok = false,
  requireRepository = false
} = {}) {
  if (!manifest) throw new Error('readiness requires a manifest');
  if (!workDir) throw new Error('readiness requires a work directory');
  const resolvedRepoPath = repoPath ? path.resolve(repoPath) : null;
  const resolvedTemplatePath = templatePath || manifest.template?.source_path || null;
  const sections = [];

  const planValidation = validatePlan(manifest);
  sections.push(readinessSection('Plan Validation', planValidation.valid ? 'passed' : 'failed', {
    summary: planValidation.valid
      ? 'Manifest passes additive-only policy.'
      : `${ensureArray(planValidation.violations).length} additive-only violation(s) found.`,
    artifact: await writeArtifact(workDir, 'readiness-plan-validation.json', planValidation),
    evidence: ensureArray(planValidation.violations).map((violation) => `${violation.resource}: ${violation.reason}`)
  }));

  let templateInspection = null;
  if (resolvedTemplatePath) {
    templateInspection = await inspectTemplate(resolvedTemplatePath);
    const readiness = templateInspection.template_readiness || {};
    const templateStatus = readiness.status === 'failed'
      ? 'failed'
      : readiness.status === 'warning'
        ? 'warning'
        : 'passed';
    sections.push(readinessSection('Template Intake', templateStatus, {
      summary: `${ensureArray(templateInspection.pages).length} page(s), ${ensureArray(templateInspection.assets).length} asset(s), readiness ${readiness.score ?? 'n/a'}/100.`,
      artifact: await writeArtifact(workDir, 'readiness-template-inventory.json', templateInspection),
      evidence: ensureArray(readiness.checks)
        .filter((check) => check.status !== 'passed')
        .map((check) => `${check.label}: ${check.message}`)
    }));
  } else {
    sections.push(readinessSection('Template Intake', 'warning', {
      summary: 'No template path was supplied and the manifest does not record one.',
      evidence: ['Run readiness with --template <path> for intake scoring.']
    }));
  }

  let repositoryInspection = null;
  if (resolvedRepoPath) {
    repositoryInspection = await inspectRepository(resolvedRepoPath);
    sections.push(readinessSection('Repository Inspection', 'passed', {
      summary: `${repositoryInspection.framework?.name || 'Unknown'} project using ${repositoryInspection.package_manager || 'unknown'}; ${Object.keys(repositoryInspection.scripts || {}).length} npm script(s) detected.`,
      artifact: await writeArtifact(workDir, 'readiness-repository-inspection.json', repositoryInspection),
      evidence: [
        `Framework: ${repositoryInspection.framework?.name || 'Unknown'}`,
        `Storyblok packages: ${ensureArray(repositoryInspection.storyblok_sdk).map((entry) => entry.name).join(', ') || 'none detected'}`,
        `Netlify: ${repositoryInspection.netlify?.site_name || repositoryInspection.netlify?.publish || 'not detected'}`
      ]
    }));

    const repositoryPreflight = await preflightRepositoryIntegration(manifest, {
      repoPath: resolvedRepoPath,
      mode: 'dry-run'
    });
    sections.push(readinessSection('Repository Safety', repositoryPreflight.status === 'failed' ? 'failed' : 'passed', {
      summary: repositoryPreflight.status === 'failed'
        ? 'Repository preflight found blocking collisions.'
        : 'Repository preflight is safe for additive integration output.',
      artifact: await writeArtifact(workDir, 'readiness-repository-preflight.json', repositoryPreflight),
      evidence: ensureArray(repositoryPreflight.checks)
        .filter((check) => check.status !== 'passed')
        .map((check) => `${check.name}: ${check.message}`)
    }));
  } else {
    sections.push(readinessSection('Repository Inspection', requireRepository ? 'failed' : 'warning', {
      summary: 'No repository path was supplied.',
      evidence: ['Run readiness with --repo <path> before client handoff for a full import.']
    }));
  }

  const access = checkLiveAccess(env);
  sections.push(readinessSection('Credential Readiness', credentialStatus(access, requireStoryblok), {
    summary: `Storyblok Management ${access.storyblok.ready ? 'configured' : 'missing'}; Content API ${access.storyblok_content.ready ? 'configured' : 'missing'}; Netlify ${access.netlify.ready ? 'configured' : 'missing'}.`,
    artifact: await writeArtifact(workDir, 'readiness-access.json', access),
    evidence: credentialEvidence(access)
  }));

  const storyblokPreflight = await preflightStoryblokIntegration(manifest, {
    dryRun: !access.storyblok.ready,
    env
  });
  sections.push(readinessSection('Storyblok Preflight', storyblokPreflightStatus(storyblokPreflight, requireStoryblok), {
    summary: storyblokPreflight.reason || storyblokPreflight.status,
    artifact: await writeArtifact(workDir, 'readiness-storyblok-preflight.json', storyblokPreflight),
    evidence: ensureArray(storyblokPreflight.checks)
      .filter((check) => check.status !== 'passed' && check.required !== false)
      .map((check) => `${check.name}: ${check.message}`)
  }));

  if (remote && access.storyblok.ready) {
    const reconciliation = await reconcileStoryblokManifest(manifest, { env });
    sections.push(readinessSection('Storyblok Reconciliation', reconciliation.status === 'passed' ? 'passed' : reconciliation.status === 'incomplete' ? 'warning' : 'failed', {
      summary: reconciliationSummary(reconciliation),
      artifact: await writeArtifact(workDir, 'readiness-storyblok-reconcile.json', reconciliation),
      evidence: ensureArray(reconciliation.resources)
        .filter((resource) => resource.status !== 'matching')
        .slice(0, 20)
        .map((resource) => `${resource.resource_type} ${resource.name || resource.resource}: ${resource.status}`)
    }));
  } else {
    sections.push(readinessSection('Storyblok Reconciliation', remote && requireStoryblok ? 'failed' : 'warning', {
      summary: remote
        ? 'Remote reconciliation was requested but Storyblok Management credentials are not configured.'
        : 'Remote reconciliation was not requested.',
      evidence: ['Run with --remote when Storyblok credentials are available to compare planned resources against the space.']
    }));
  }

  const rollbackPreview = createRollbackPreview(manifest, {
    repoPath: resolvedRepoPath || process.cwd()
  });
  sections.push(readinessSection('Rollback Preview', rollbackPreview.validation.valid ? 'passed' : 'failed', {
    summary: `${rollbackPreview.repository_files_to_remove.length} repository file(s), ${rollbackPreview.storyblok_components_to_remove.length} Storyblok component(s), ${rollbackPreview.storyblok_stories_to_remove.length} draft story/stories in rollback scope.`,
    artifact: await writeArtifact(workDir, 'readiness-rollback-preview.json', rollbackPreview),
    evidence: rollbackPreview.repository_files_to_remove
      .filter((entry) => !entry.owned_by_integration)
      .map((entry) => `${entry.path}: outside integration namespace`)
  }));

  const summary = summarizeSections(sections);
  const result = {
    action: 'readiness_handoff',
    status: summary.failed > 0 ? 'failed' : summary.warnings > 0 ? 'warning' : 'passed',
    integration_id: manifest.integration_id,
    repository_path: resolvedRepoPath,
    template_path: resolvedTemplatePath,
    remote_checked: Boolean(remote && access.storyblok.ready),
    summary,
    sections
  };
  result.markdown_report = await writeReadinessMarkdownReport(workDir, result);
  return result;
}

export async function writeReadinessMarkdownReport(workDir, result) {
  const filePath = path.join(workDir, 'readiness-report.md');
  await writeText(filePath, renderReadinessMarkdown(result));
  return filePath;
}

export function renderReadinessMarkdown(result) {
  const sectionRows = result.sections.map((section) => {
    const evidence = section.evidence.length
      ? section.evidence.map((entry) => `  - ${entry}`).join('\n')
      : '  - No unresolved evidence.';
    return `## ${section.name}

- Status: ${section.status}
- Summary: ${section.summary}
${section.artifact ? `- Artifact: ${section.artifact}\n` : ''}
${evidence}`;
  }).join('\n\n');
  return `# HTML-to-Storyblok Readiness Handoff

- Integration: ${result.integration_id || 'unknown'}
- Status: ${result.status}
- Repository: ${result.repository_path || 'not supplied'}
- Template: ${result.template_path || 'not supplied'}
- Remote Storyblok checked: ${result.remote_checked ? 'yes' : 'no'}
- Passed sections: ${result.summary.passed}
- Warning sections: ${result.summary.warnings}
- Failed sections: ${result.summary.failed}

${sectionRows}

## Rollback Command

\`\`\`sh
html-to-storyblok rollback --manifest .tmp/html-to-storyblok/integration-manifest.json --repo ${result.repository_path || '<repo-path>'} --confirm-integration-id ${result.integration_id || '<integration-id>'} --dry-run
\`\`\`
`;
}

function readinessSection(name, status, { summary, artifact = null, evidence = [] } = {}) {
  return {
    name,
    status,
    summary: summary || status,
    artifact,
    evidence: ensureArray(evidence).filter(Boolean)
  };
}

function summarizeSections(sections) {
  return {
    total: sections.length,
    passed: sections.filter((section) => section.status === 'passed').length,
    warnings: sections.filter((section) => section.status === 'warning').length,
    failed: sections.filter((section) => section.status === 'failed').length
  };
}

function credentialStatus(access, requireStoryblok) {
  if (access.storyblok.ready) return 'passed';
  return requireStoryblok ? 'failed' : 'warning';
}

function credentialEvidence(access) {
  return [
    ...missingCredentialEvidence('Storyblok Management', access.storyblok),
    ...missingCredentialEvidence('Storyblok Content API', access.storyblok_content),
    ...missingCredentialEvidence('Netlify', access.netlify)
  ];
}

function missingCredentialEvidence(label, entry) {
  if (entry.ready) return [];
  return [`${label}: configure ${ensureArray(entry.required_variable_names).join(', ')}`];
}

function storyblokPreflightStatus(preflight, requireStoryblok) {
  if (preflight.status === 'failed') return 'failed';
  if (preflight.status === 'skipped' && requireStoryblok) return 'failed';
  if (preflight.status === 'skipped') return 'warning';
  return 'passed';
}

function reconciliationSummary(reconciliation) {
  const summary = reconciliation.summary || {};
  return `${summary.matching || 0} matching, ${summary.missing || 0} missing, ${summary.drifted || 0} drifted, ${summary.blocked || 0} blocked.`;
}
