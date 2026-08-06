# Acme Campaign Template

Sample HTML template for testing the HTML-to-Storyblok import workflow.

Useful commands:

```sh
node bin/html-to-storyblok.js inspect-template --template templates/acme-campaign

node bin/html-to-storyblok.js plan \
  --integration-id acme-campaign-v1 \
  --template templates/acme-campaign \
  --schema-overrides templates/acme-campaign/schema-overrides.json \
  --framework static
```

