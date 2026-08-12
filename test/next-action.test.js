import assert from 'node:assert/strict';
import test from 'node:test';
import { createNextActionModel } from '../src/next-action.js';

test('next-action model recommends real apply after a safe dry run', () => {
  const model = createNextActionModel({
    result: {
      status: 'dry_run_complete',
      repo_path: '../client-site',
      validation: { valid: true },
      dry_run: {
        dry_run: true,
        steps: []
      }
    },
    workDir: '.tmp/html-to-storyblok'
  });

  assert.equal(model.primary.id, 'run-real-apply');
  assert.equal(model.primary.priority, 'high');
  assert.match(model.primary.command, /apply --manifest/);
  assert.match(model.primary.command, /--repo \.\.\/client-site/);
});

test('next-action model surfaces unresolved Storyblok links and route handoff', () => {
  const model = createNextActionModel({
    manifest: {
      integration_id: 'acme-v1'
    },
    result: {
      status: 'complete',
      result: {
        status: 'complete',
        steps: [
          {
            route_previews: [
              {
                slug: 'home',
                suggested_site_path: '/'
              }
            ],
            results: [
              {
                action: 'create_draft_story',
                link_summary: {
                  total_links: 3,
                  story_links: 2,
                  resolved_story_links: 1,
                  unresolved_story_links: 1
                }
              }
            ]
          }
        ]
      }
    },
    report: {
      work_dir: '.tmp/html-to-storyblok',
      latest_validation: { status: 'passed' },
      latest_route_handoff: null,
      asset_integrity: { status: 'passed' },
      commands_failed: [],
      artifacts: []
    }
  });

  assert.equal(model.actions.some((action) => action.id === 'review-story-links'), true);
  assert.equal(model.actions.some((action) => action.id === 'platform-readiness'), true);
  assert.equal(model.actions.some((action) => action.id === 'route-checklist'), true);
  assert.equal(model.actions.some((action) => action.id === 'wire-routes'), true);
});

test('next-action model prioritizes failures and asset integrity blockers', () => {
  const model = createNextActionModel({
    result: {
      status: 'failed'
    },
    report: {
      work_dir: '.tmp/html-to-storyblok',
      latest_validation: { status: 'passed' },
      asset_integrity: {
        status: 'failed',
        local_sources_missing: 1,
        unresolved_asset_fields: 2
      },
      commands_failed: [
        {
          command: 'apply',
          message: 'Storyblok Management API verification failed'
        }
      ],
      artifacts: []
    }
  });

  assert.equal(model.status, 'attention');
  assert.equal(model.primary.id, 'recover-failure');
  assert.equal(model.actions.some((action) => action.id === 'review-assets' && action.priority === 'critical'), true);
  assert.match(model.actions.find((action) => action.id === 'review-assets').reason, /1 missing source/);
});

test('next-action model surfaces asset reference graph blockers', () => {
  const model = createNextActionModel({
    report: {
      work_dir: '.tmp/html-to-storyblok',
      latest_validation: { status: 'passed' },
      asset_integrity: { status: 'passed' },
      asset_reference_graph: {
        status: 'failed',
        summary: {
          unresolved_story_asset_fields: 2,
          remote_unresolved_asset_fields: 1,
          ambiguous_story_asset_fields: 1
        }
      },
      commands_failed: [],
      artifacts: []
    }
  });

  const action = model.actions.find((entry) => entry.id === 'review-asset-graph');
  assert.equal(action.priority, 'critical');
  assert.match(action.command, /asset-graph/);
  assert.match(action.reason, /2 story asset field/);
});

test('next-action model prioritizes route collision blockers before route handoff', () => {
  const model = createNextActionModel({
    manifest: {
      integration_id: 'acme-v1',
      repository: {
        route_previews: [{ slug: 'home' }]
      }
    },
    report: {
      work_dir: '.tmp/html-to-storyblok',
      latest_validation: { status: 'passed' },
      latest_route_collision_analysis: {
        status: 'blocked',
        blocked: 1,
        warnings: 0
      },
      latest_route_handoff: null,
      asset_integrity: { status: 'passed' },
      commands_failed: [],
      artifacts: []
    },
    repoPath: '../client-site'
  });

  assert.equal(model.primary.id, 'resolve-route-collisions');
  assert.equal(model.actions.some((action) => action.id === 'wire-routes'), false);
  assert.match(model.primary.command, /route-collisions/);
  assert.match(model.primary.command, /--repo \.\.\/client-site/);
});

test('next-action model blocks route exposure when platform readiness fails', () => {
  const model = createNextActionModel({
    manifest: {
      integration_id: 'acme-v1',
      repository: {
        route_previews: [{ slug: 'home' }]
      }
    },
    report: {
      work_dir: '.tmp/html-to-storyblok',
      latest_validation: { status: 'passed' },
      latest_platform_readiness: {
        status: 'blocked',
        failed_checks: 2,
        framework: 'astro'
      },
      latest_route_handoff: null,
      asset_integrity: { status: 'passed' },
      commands_failed: [],
      artifacts: []
    },
    repoPath: '../client-site'
  });

  assert.equal(model.primary.id, 'resolve-platform-readiness');
  assert.equal(model.primary.priority, 'critical');
  assert.match(model.primary.command, /platform-readiness/);
  assert.match(model.primary.reason, /2 platform readiness check/);
});

test('next-action model surfaces manual route checklist reviews', () => {
  const model = createNextActionModel({
    manifest: {
      integration_id: 'acme-v1',
      repository: {
        route_previews: [{ slug: 'home' }]
      }
    },
    report: {
      work_dir: '.tmp/html-to-storyblok',
      latest_validation: { status: 'passed' },
      latest_route_handoff_checklist: {
        status: 'manual_required',
        manual_routes: 2
      },
      latest_route_handoff: null,
      asset_integrity: { status: 'passed' },
      commands_failed: [],
      artifacts: []
    },
    repoPath: '../client-site'
  });

  const action = model.actions.find((entry) => entry.id === 'review-route-checklist');
  assert.equal(action.status, 'needs_review');
  assert.match(action.reason, /2 route/);
  assert.match(action.command, /route-checklist/);
});

test('next-action model recommends rewrite review for route collision warnings', () => {
  const model = createNextActionModel({
    manifest: {
      integration_id: 'acme-v1',
      repository: {
        route_previews: [{ slug: 'home' }]
      }
    },
    report: {
      work_dir: '.tmp/html-to-storyblok',
      latest_validation: { status: 'passed' },
      latest_route_collision_analysis: {
        status: 'warning',
        blocked: 0,
        warnings: 2
      },
      latest_route_handoff: null,
      asset_integrity: { status: 'passed' },
      commands_failed: [],
      artifacts: []
    }
  });

  assert.equal(model.actions.some((action) => action.id === 'review-route-rewrites'), true);
  assert.equal(model.actions.some((action) => action.id === 'wire-routes'), true);
});
