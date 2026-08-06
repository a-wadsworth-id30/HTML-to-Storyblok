# HTML-to-Storyblok Five Route Test Template

Sample multi-page HTML template for testing the HTML-to-Storyblok import workflow.

Routes:

- `index.html` - Home
- `about.html` - About
- `services.html` - Services
- `gallery.html` - Gallery
- `contact.html` - Contact us

The content uses this project as the example subject matter. It includes shared navigation, local assets, repeated cards, gallery media, pricing-style content, forms, JavaScript behaviour, external form and analytics references, and `data-hts-field` hints for schema generation.

Useful commands:

```sh
node bin/html-to-storyblok.js inspect-template --template templates/acme-campaign

node bin/html-to-storyblok.js plan \
  --integration-id acme-campaign-v1 \
  --template templates/acme-campaign \
  --schema-overrides templates/acme-campaign/schema-overrides.json \
  --framework static
```
