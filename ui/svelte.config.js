import adapter from '@sveltejs/adapter-static';

export default {
  kit: {
    adapter: adapter({
      pages: '../server/web-dist',
      assets: '../server/web-dist',
      fallback: undefined,
      precompress: false,
      strict: true
    })
  }
};
