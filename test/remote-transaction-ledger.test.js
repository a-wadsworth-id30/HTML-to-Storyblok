import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createProductionHandoffPack } from '../src/handoff-pack.js';
import { createIntegrationPlan } from '../src/planner.js';
import { createRemoteTransactionLedger } from '../src/remote-transaction-ledger.js';
import { createReport } from '../src/reporter.js';
import { applyStoryblokOnly } from '../src/workflow.js';

test('remote transaction ledger summarizes Storyblok resources and rollback scope', async () => {
  const manifest = await createIntegrationPlan({
    integrationId: 'acme-homepage-v1',
    storyblokPrefix: 'hts_acme_homepage_v1_',
    templatePath: 'test/fixtures/basic-template',
    framework: 'static'
  });
  const ledger = createRemoteTransactionLedger(manifest, {
    workflow: 'storyblok_only_apply',
    steps: [
      {
        action: 'storyblok_components',
        results: [
          {
            action: 'create_component',
            status: 'created',
            technical_name: 'hts_acme_homepage_v1_hero',
            id: 101,
            verification: { id: 101, name: 'hts_acme_homepage_v1_hero' }
          }
        ]
      },
      {
        action: 'storyblok_draft_stories',
        results: [
          {
            action: 'create_draft_story',
            status: 'created',
            slug: 'acme-homepage-v1/home',
            id: 201,
            uuid: 'story-uuid',
            published: false,
            folder_results: [
              {
                action: 'create_story_folder',
                status: 'created',
                slug: 'acme-homepage-v1',
                id: 200
              }
            ]
          }
        ]
      }
    ]
  });

  assert.equal(ledger.action, 'remote_transaction_ledger');
  assert.equal(ledger.transaction_count, 3);
  assert.equal(ledger.summary.created, 3);
  assert.equal(ledger.summary.rollback_allowed, 3);
  assert.equal(ledger.rollback_scope.components.length, 1);
  assert.equal(ledger.rollback_scope.stories.length, 1);
  assert.equal(ledger.rollback_scope.story_folders.length, 1);
  assert.equal(ledger.safety.published_stories, 0);
});

test('Storyblok-only dry run writes a remote transaction ledger artifact', async () => {
  const workDir = await mkdtemp(path.join(os.tmpdir(), 'hts-remote-ledger-storyblok-only-'));
  const manifest = await createIntegrationPlan({
    integrationId: 'acme-homepage-v1',
    storyblokPrefix: 'hts_acme_homepage_v1_',
    templatePath: 'test/fixtures/basic-template',
    framework: 'static'
  });

  await applyStoryblokOnly(manifest, {
    dry_run: true,
    env: {}
  }, workDir);
  const ledger = JSON.parse(await readFile(path.join(workDir, 'storyblok-remote-transaction-ledger.json'), 'utf8'));
  const report = await createReport(workDir);

  assert.equal(ledger.workflow, 'storyblok_only_apply');
  assert.equal(ledger.dry_run, true);
  assert.equal(ledger.summary.dry_run, ledger.transaction_count);
  assert.equal(report.latest_remote_transaction_ledger.type, 'remote_transaction_ledger');
  assert.equal(report.safety_confirmation.remote_transaction_ledger_valid, true);
});

test('production handoff pack includes remote transaction ledger summary', async () => {
  const workDir = await mkdtemp(path.join(os.tmpdir(), 'hts-remote-ledger-handoff-'));
  const manifest = await createIntegrationPlan({
    integrationId: 'acme-homepage-v1',
    storyblokPrefix: 'hts_acme_homepage_v1_',
    templatePath: 'test/fixtures/basic-template',
    framework: 'static'
  });

  await applyStoryblokOnly(manifest, {
    dry_run: true,
    env: {}
  }, workDir);
  const pack = await createProductionHandoffPack({
    manifest,
    workDir,
    skipReadiness: true
  });

  assert.equal(pack.storyblok.remote_transaction_ledger.status, 'planned');
  assert.ok(pack.storyblok.remote_transaction_ledger.transactions > 0);
  assert.match(await readFile(pack.markdown_report, 'utf8'), /Remote transaction ledger/);
});
