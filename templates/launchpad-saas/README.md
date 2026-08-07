# LaunchPad SaaS Test Template

Second multi-route HTML template for testing HTML-to-Storyblok imports.

Routes:

- `index.html` - Home
- `about.html` - About
- `services.html` - Services
- `gallery.html` - Gallery
- `contact.html` - Contact us

This fixture models a SaaS operations product. It intentionally includes shared navigation, repeated cards, metrics, a timeline, pricing content, gallery media, a form, local SVG assets, isolated JavaScript behaviour, external references, and `data-hts-field` hints.

When planned with this fixture, Storyblok draft stories are generated as:

- `<integration-id>/home`
- `<integration-id>/about`
- `<integration-id>/services`
- `<integration-id>/gallery`
- `<integration-id>/contact`

Useful commands:

```sh
node bin/html-to-storyblok.js inspect-template --template templates/launchpad-saas

node bin/html-to-storyblok.js plan \
  --integration-id launchpad-saas-v1 \
  --template templates/launchpad-saas \
  --schema-overrides templates/launchpad-saas/schema-overrides.json \
  --framework static
```
