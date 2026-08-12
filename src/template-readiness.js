import { ensureArray } from './utils.js';

const ERROR_DEDUCTION = 25;
const WARNING_DEDUCTION = 8;

export function assessTemplateReadiness(inventory = {}) {
  const checks = [];
  const summary = buildTemplateReadinessSummary(inventory);

  addCheck(checks, {
    id: 'html_pages_present',
    label: 'HTML Pages',
    status: summary.pages > 0 ? 'passed' : 'failed',
    severity: 'error',
    message: summary.pages > 0
      ? `${summary.pages} HTML page(s) found.`
      : 'No HTML pages were found in the template folder.',
    recommendation: 'Add at least one HTML page, usually index.html.'
  });

  addCheck(checks, {
    id: 'local_assets_resolved',
    label: 'Local Assets',
    status: summary.missing_assets === 0 ? 'passed' : 'failed',
    severity: 'error',
    message: summary.missing_assets === 0
      ? 'All local asset references resolved.'
      : `${summary.missing_assets} local asset reference(s) could not be resolved.`,
    evidence: ensureArray(inventory.missing_assets).slice(0, 10).map((entry) => `${entry.source_file}: ${entry.reference}`),
    recommendation: 'Place missing assets inside the template folder or update the HTML/CSS references before importing.'
  });

  addCheck(checks, {
    id: 'page_titles_present',
    label: 'Page Titles',
    status: summary.missing_titles === 0 ? 'passed' : 'warning',
    severity: 'warning',
    message: summary.missing_titles === 0
      ? 'Every page has a title.'
      : `${summary.missing_titles} page(s) are missing a <title>.`,
    evidence: pagesMissingTitle(inventory),
    recommendation: 'Add a useful <title> to every supplied route so SEO fields can be generated later.'
  });

  addCheck(checks, {
    id: 'primary_headings_present',
    label: 'Primary Headings',
    status: summary.pages_without_h1 === 0 ? 'passed' : 'warning',
    severity: 'warning',
    message: summary.pages_without_h1 === 0
      ? 'Every page has an H1.'
      : `${summary.pages_without_h1} page(s) do not expose an H1.`,
    evidence: pagesWithoutHeading(inventory),
    recommendation: 'Add one clear H1 per route so hero/page headline mapping is deterministic.'
  });

  addCheck(checks, {
    id: 'editorial_field_hints',
    label: 'Editorial Field Hints',
    status: summary.field_hints > 0 ? 'passed' : 'warning',
    severity: 'warning',
    message: summary.field_hints > 0
      ? `${summary.field_hints} explicit data-hts-field/data-storyblok-field hint(s) found.`
      : 'No explicit editorial field hints were found.',
    recommendation: 'Add data-hts-field attributes to key copy, image, link, and form fields to improve schema quality.'
  });

  addCheck(checks, {
    id: 'external_dependencies_reviewed',
    label: 'External Dependencies',
    status: summary.external_urls === 0 && summary.external_scripts === 0 ? 'passed' : 'warning',
    severity: 'warning',
    message: summary.external_urls === 0 && summary.external_scripts === 0
      ? 'No third-party URLs or external scripts detected.'
      : `${summary.external_urls} third-party URL(s) and ${summary.external_scripts} external script(s) require review.`,
    evidence: [
      ...ensureArray(inventory.third_party_integrations),
      ...externalScripts(inventory)
    ].slice(0, 12),
    recommendation: 'Confirm analytics, embeds, fonts, and vendor scripts are approved for the target site.'
  });

  addCheck(checks, {
    id: 'script_behaviour_reviewed',
    label: 'Script Behaviour',
    status: summary.unsafe_script_patterns === 0 ? summary.inline_handlers === 0 ? 'passed' : 'warning' : 'failed',
    severity: summary.unsafe_script_patterns === 0 ? 'warning' : 'error',
    message: summary.unsafe_script_patterns > 0
      ? `${summary.unsafe_script_patterns} unsafe JavaScript pattern(s) need rewriting.`
      : summary.inline_handlers > 0
        ? `${summary.inline_handlers} inline event handler(s) will be isolated or removed.`
        : 'No unsafe script behaviour detected.',
    evidence: [
      ...unsafeScriptEvidence(inventory),
      ...inlineHandlerEvidence(inventory)
    ].slice(0, 12),
    recommendation: 'Move required behaviour into reviewed integration JavaScript and avoid unsafe DOM injection patterns.'
  });

  addCheck(checks, {
    id: 'forms_reviewed',
    label: 'Forms',
    status: summary.forms === 0 && summary.external_form_actions === 0 ? 'passed' : 'warning',
    severity: 'warning',
    message: summary.forms === 0
      ? 'No forms detected.'
      : `${summary.forms} form(s) detected; ${summary.external_form_actions} external action(s) require endpoint review.`,
    evidence: formEvidence(inventory),
    recommendation: 'Confirm form endpoint, validation, consent, spam protection, and CRM routing before production use.'
  });

  addCheck(checks, {
    id: 'accessibility_reviewed',
    label: 'Accessibility',
    status: summary.accessibility_issues === 0 ? 'passed' : 'warning',
    severity: 'warning',
    message: summary.accessibility_issues === 0
      ? 'No template-level accessibility issues detected by static inspection.'
      : `${summary.accessibility_issues} accessibility issue(s) need review.`,
    evidence: ensureArray(inventory.accessibility_issues).slice(0, 12),
    recommendation: 'Resolve missing alt text, empty links, labels, and heading structure before client review.'
  });

  addCheck(checks, {
    id: 'css_namespace_readiness',
    label: 'CSS Namespace Readiness',
    status: summary.global_css_selectors === 0 ? 'passed' : 'warning',
    severity: 'warning',
    message: summary.global_css_selectors === 0
      ? 'No risky global selectors detected.'
      : `${summary.global_css_selectors} global CSS selector(s) require namespacing review.`,
    evidence: globalSelectorEvidence(inventory).slice(0, 12),
    recommendation: 'Prefer class-scoped selectors and avoid styling html, body, root, or broad globals in supplied templates.'
  });

  addCheck(checks, {
    id: 'fonts_licence_reviewed',
    label: 'Fonts',
    status: summary.fonts === 0 ? 'passed' : 'warning',
    severity: 'warning',
    message: summary.fonts === 0
      ? 'No local font files detected.'
      : `${summary.fonts} local font file(s) require licence review.`,
    evidence: ensureArray(inventory.fonts).slice(0, 12).map((font) => font.file),
    recommendation: 'Confirm font licences permit redistribution in the target site before importing.'
  });

  addCheck(checks, {
    id: 'unsupported_files_reviewed',
    label: 'Unsupported Files',
    status: summary.unsupported_files === 0 ? 'passed' : 'warning',
    severity: 'warning',
    message: summary.unsupported_files === 0
      ? 'No unsupported files detected.'
      : `${summary.unsupported_files} file(s) were not automatically classified.`,
    evidence: unsupportedFileEvidence(inventory),
    recommendation: 'Remove unused files or document why they are safe to ignore before handoff.'
  });

  const errors = checks.filter((check) => check.status === 'failed');
  const warnings = checks.filter((check) => check.status === 'warning');
  const score = readinessScore({ errors: errors.length, warnings: warnings.length, pages: summary.pages });
  const qualityProfile = buildTemplateQualityProfile(inventory, summary);
  const status = errors.length > 0 ? 'failed' : warnings.length > 0 ? 'warning' : 'passed';

  return {
    action: 'template_readiness',
    status,
    readiness_level: status === 'failed' ? 'blocked' : status === 'warning' ? 'needs_review' : 'ready',
    score,
    quality_score: qualityProfile.score,
    quality_grade: qualityProfile.grade,
    quality_profile: qualityProfile,
    summary,
    checks,
    blockers: errors.map(readinessIssue),
    warnings: warnings.map(readinessIssue),
    next_steps: recommendedNextSteps({ status, errors, warnings }),
    designer_contract: designerContract(summary)
  };
}

function buildTemplateReadinessSummary(inventory) {
  const pages = ensureArray(inventory.pages);
  const pageInventory = ensureArray(inventory.page_inventory);
  return {
    pages: pages.length,
    routes: pages,
    assets: ensureArray(inventory.assets).length,
    fonts: ensureArray(inventory.fonts).length,
    scripts: scriptCount(inventory),
    inline_handlers: pageInventory.reduce((count, page) => count + ensureArray(page.inline_handlers).length, 0),
    unsafe_script_patterns: ensureArray(inventory.behaviour_inventory)
      .reduce((count, script) => count + ensureArray(script.unsafe_patterns).length, 0),
    forms: pageInventory.reduce((count, page) => count + ensureArray(page.forms).length, 0),
    external_form_actions: externalFormActions(inventory).length,
    external_urls: ensureArray(inventory.third_party_integrations).length,
    external_scripts: externalScripts(inventory).length,
    missing_assets: ensureArray(inventory.missing_assets).length,
    accessibility_issues: ensureArray(inventory.accessibility_issues).length,
    field_hints: fieldHintEntries(inventory).length,
    global_css_selectors: globalSelectorEvidence(inventory).length,
    unsupported_files: unsupportedFileEvidence(inventory).length,
    missing_titles: pagesMissingTitle(inventory).length,
    pages_without_h1: pagesWithoutHeading(inventory).length
  };
}

function addCheck(checks, check) {
  checks.push({
    ...check,
    evidence: ensureArray(check.evidence),
    recommendation: check.recommendation || null
  });
}

function readinessScore({ errors, warnings, pages }) {
  if (pages === 0) return 0;
  return Math.max(0, 100 - (errors * ERROR_DEDUCTION) - (warnings * WARNING_DEDUCTION));
}

function buildTemplateQualityProfile(inventory, summary) {
  const categories = [
    qualityCategory({
      id: 'route_seo',
      label: 'Route and SEO Readiness',
      weight: 16,
      score: ratioScore(summary.pages, summary.missing_titles + summary.pages_without_h1, 35),
      evidence: [
        `${summary.pages} page(s)`,
        `${summary.missing_titles} missing title(s)`,
        `${summary.pages_without_h1} page(s) without H1`
      ],
      recommendation: 'Provide a title and one clear H1 for every route before importing.'
    }),
    qualityCategory({
      id: 'editorial_model',
      label: 'Editorial Model Signals',
      weight: 18,
      score: Math.min(100, Math.round((summary.field_hints / Math.max(1, summary.pages * 3)) * 100)),
      evidence: [`${summary.field_hints} explicit editable field hint(s)`],
      recommendation: 'Add data-hts-field hints to key headings, rich text, images, links, forms, and repeated items.'
    }),
    qualityCategory({
      id: 'asset_health',
      label: 'Asset Health',
      weight: 16,
      score: Math.max(0, 100 - (summary.missing_assets * 30)),
      evidence: [
        `${summary.assets} asset(s) discovered`,
        `${summary.missing_assets} missing local asset reference(s)`
      ],
      recommendation: 'Include all local images, media, CSS assets, JavaScript files, and fonts inside the template folder.'
    }),
    qualityCategory({
      id: 'javascript_safety',
      label: 'JavaScript Safety',
      weight: 12,
      score: Math.max(0, 100 - (summary.unsafe_script_patterns * 40) - (summary.inline_handlers * 12)),
      evidence: [
        `${summary.scripts} script(s)`,
        `${summary.unsafe_script_patterns} unsafe pattern(s)`,
        `${summary.inline_handlers} inline handler(s)`
      ],
      recommendation: 'Move behaviour into reviewed integration modules and remove unsafe DOM execution patterns.'
    }),
    qualityCategory({
      id: 'css_isolation',
      label: 'CSS Isolation Readiness',
      weight: 10,
      score: Math.max(0, 100 - (summary.global_css_selectors * 12)),
      evidence: [`${summary.global_css_selectors} risky global selector(s)`],
      recommendation: 'Prefer class-scoped CSS and avoid broad html/body/root/global selectors.'
    }),
    qualityCategory({
      id: 'accessibility',
      label: 'Accessibility Signals',
      weight: 12,
      score: Math.max(0, 100 - (summary.accessibility_issues * 15)),
      evidence: [`${summary.accessibility_issues} static accessibility issue(s)`],
      recommendation: 'Resolve image alt text, labels, empty links, and heading structure before client review.'
    }),
    qualityCategory({
      id: 'forms',
      label: 'Form Production Readiness',
      weight: 8,
      score: summary.forms === 0 ? 100 : Math.max(45, 85 - (summary.external_form_actions * 25)),
      evidence: [
        `${summary.forms} form(s)`,
        `${summary.external_form_actions} external action(s)`
      ],
      recommendation: 'Confirm form endpoints, validation, consent, CRM routing, and spam protection.'
    }),
    qualityCategory({
      id: 'third_party_dependencies',
      label: 'Third-Party Dependency Review',
      weight: 8,
      score: Math.max(0, 100 - (summary.external_urls * 4) - (summary.external_scripts * 15) - (summary.fonts * 8)),
      evidence: [
        `${summary.external_urls} third-party URL(s)`,
        `${summary.external_scripts} external script(s)`,
        `${summary.fonts} local font file(s)`
      ],
      recommendation: 'Document approved analytics, embeds, external scripts, font licences, and vendor dependencies.'
    })
  ];
  const score = weightedScore(categories);
  const risks = categories.filter((category) => category.score < 75);
  const strengths = categories.filter((category) => category.score >= 90).map((category) => category.label);
  return {
    score,
    grade: qualityGrade(score),
    status: score >= 90 ? 'excellent' : score >= 75 ? 'good' : score >= 60 ? 'review_required' : 'blocked',
    categories,
    strengths,
    risks: risks.map((category) => ({
      id: category.id,
      label: category.label,
      score: category.score,
      grade: category.grade,
      recommendation: category.recommendation,
      evidence: category.evidence
    })),
    recommended_actions: risks.map((category) => category.recommendation).slice(0, 5)
  };
}

function qualityCategory({ id, label, weight, score, evidence, recommendation }) {
  const normalizedScore = clampScore(score);
  return {
    id,
    label,
    weight,
    score: normalizedScore,
    grade: qualityGrade(normalizedScore),
    status: normalizedScore >= 90 ? 'excellent' : normalizedScore >= 75 ? 'good' : normalizedScore >= 60 ? 'review_required' : 'weak',
    evidence,
    recommendation
  };
}

function ratioScore(total, issues, deductionPerIssue) {
  if (total === 0) return 0;
  return Math.max(0, 100 - (issues * deductionPerIssue));
}

function weightedScore(categories) {
  const totalWeight = categories.reduce((total, category) => total + category.weight, 0);
  if (totalWeight === 0) return 0;
  return clampScore(categories.reduce((total, category) => total + (category.score * category.weight), 0) / totalWeight);
}

function clampScore(value) {
  return Math.max(0, Math.min(100, Math.round(Number(value) || 0)));
}

function qualityGrade(score) {
  if (score >= 90) return 'A';
  if (score >= 80) return 'B';
  if (score >= 70) return 'C';
  if (score >= 60) return 'D';
  return 'F';
}

function readinessIssue(check) {
  return {
    id: check.id,
    label: check.label,
    severity: check.severity,
    message: check.message,
    evidence: check.evidence,
    recommendation: check.recommendation
  };
}

function recommendedNextSteps({ status, errors, warnings }) {
  if (status === 'passed') {
    return [
      'Proceed to Storyblok inspection or plan generation.',
      'Keep the supplied template source unchanged so generated output remains auditable.'
    ];
  }
  return [
    ...errors.map((check) => check.recommendation).filter(Boolean),
    ...warnings.slice(0, Math.max(0, 5 - errors.length)).map((check) => check.recommendation).filter(Boolean)
  ];
}

function designerContract(summary) {
  return {
    required: [
      'One or more HTML pages, with index.html used as the home route when present.',
      'All local image, media, CSS, JavaScript, and font references included inside the template folder.',
      'No required production behaviour hidden in unsafe inline scripts or external snippets.',
      'Clear route names for each page that should become a Storyblok draft story.'
    ],
    recommended: [
      'One <title> and one H1 per page.',
      'Use data-hts-field, data-storyblok-field, data-sb-field, or data-field on important editable content.',
      'Provide alt text for meaningful images and labels for form controls.',
      'Document analytics, forms, embeds, fonts, and other third-party services.'
    ],
    current_status: {
      has_multiple_routes: summary.pages > 1,
      has_field_hints: summary.field_hints > 0,
      has_external_dependencies: summary.external_urls > 0 || summary.external_scripts > 0,
      has_forms: summary.forms > 0
    }
  };
}

function scriptCount(inventory) {
  const pageScripts = ensureArray(inventory.page_inventory)
    .reduce((count, page) => count + ensureArray(page.scripts).length, 0);
  const localScriptFiles = ensureArray(inventory.behaviour_inventory).length;
  return pageScripts + localScriptFiles;
}

function externalScripts(inventory) {
  return ensureArray(inventory.page_inventory)
    .flatMap((page) => ensureArray(page.scripts)
      .filter((script) => /^(https?:)?\/\//i.test(String(script.src || '')))
      .map((script) => `${page.page}: ${script.src}`));
}

function unsafeScriptEvidence(inventory) {
  return ensureArray(inventory.behaviour_inventory).flatMap((script) =>
    ensureArray(script.unsafe_patterns).map((pattern) => `${script.source_file}: ${pattern}`));
}

function inlineHandlerEvidence(inventory) {
  return ensureArray(inventory.page_inventory).flatMap((page) =>
    ensureArray(page.inline_handlers).map((handler) => `${page.page}: ${handler.event || handler.name || 'inline handler'}`));
}

function externalFormActions(inventory) {
  return ensureArray(inventory.page_inventory).flatMap((page) =>
    ensureArray(page.forms)
      .filter((form) => /^https?:\/\//i.test(String(form.action || '')))
      .map((form) => ({ page: page.page, action: form.action, method: form.method })));
}

function formEvidence(inventory) {
  return ensureArray(inventory.page_inventory).flatMap((page) =>
    ensureArray(page.forms).map((form) => `${page.page}: ${form.method || 'get'} ${form.action || '(no action)'}`));
}

function globalSelectorEvidence(inventory) {
  return ensureArray(inventory.css_inventory).flatMap((css) =>
    ensureArray(css.global_selectors).map((selector) => `${css.source_file}: ${selector}`));
}

function unsupportedFileEvidence(inventory) {
  return ensureArray(inventory.inventory)
    .filter((entry) => entry.classification === 'Excluded item')
    .map((entry) => entry.source_file || entry.template_item);
}

function pagesMissingTitle(inventory) {
  return ensureArray(inventory.page_inventory)
    .filter((page) => !String(page.title || '').trim())
    .map((page) => page.page);
}

function pagesWithoutHeading(inventory) {
  return ensureArray(inventory.page_inventory)
    .filter((page) => !ensureArray(page.headings).some((heading) => Number(heading.level) === 1 && String(heading.text || '').trim()))
    .map((page) => page.page);
}

function fieldHintEntries(inventory) {
  return ensureArray(inventory.page_inventory).flatMap((page) => [
    ...ensureArray(page.headings).filter((entry) => entry.field_hint),
    ...ensureArray(page.text_blocks).filter((entry) => entry.field_hint),
    ...ensureArray(page.images).filter((entry) => entry.field_hint),
    ...ensureArray(page.links).filter((entry) => entry.field_hint),
    ...ensureArray(page.forms).flatMap((form) => ensureArray(form.inputs).filter((entry) => entry.field_hint))
  ]);
}
