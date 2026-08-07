export default defineNuxtConfig({
  modules: ['@storyblok/nuxt'],
  storyblok: {
    accessToken: process.env.STORYBLOK_PREVIEW_TOKEN || 'demo-preview-token'
  }
});
