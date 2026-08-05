# HTML-to-Storyblok

`html-to-storyblok` is a safety-first CLI scaffold for integrating supplied HTML templates into existing Storyblok-powered repositories.

The current implementation focuses on deterministic discovery, additive-only planning, policy validation, and evidence logging. External mutations such as Storyblok schema creation, draft story creation, GitHub pull requests, and Netlify deploy verification are intentionally dry-run guarded until their adapters are wired.

## Install locally

```sh
npm link
```

## Commands

```sh
html-to-storyblok inspect-template --template ./template
html-to-storyblok inspect-repository --repo ../client-site
html-to-storyblok inspect-storyblok
html-to-storyblok inspect-netlify --repo ../client-site
html-to-storyblok plan --integration-id acme-homepage-v1 --storyblok-prefix hts_acme_v1_
html-to-storyblok validate-plan --manifest .tmp/html-to-storyblok/integration-manifest.json
html-to-storyblok report
```

Artifacts are written under `.tmp/html-to-storyblok/`, which is ignored by Git.

## Policy

The default policy is `additive-only-isolated`.

Automatic operations may only:

- read existing resources
- snapshot existing resources
- duplicate existing resources into a new namespace
- create new resources

The CLI rejects plans that modify existing repository files, reuse existing frontend or Storyblok components at runtime, modify existing stories or assets, change dependencies, or change deployment configuration.

## Validation

```sh
npm run check
npm test
```

