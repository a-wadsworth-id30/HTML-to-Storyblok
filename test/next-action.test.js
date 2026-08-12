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
        missing_sources: 1,
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
});
