import type { HandleClientError } from '@sveltejs/kit/hooks';
import { isPageAssetError } from './lib/page-error.ts';

export const handleError: HandleClientError = (caught) => {
  console.error('Pi Companion page error:', caught.error);
  if (caught.kind === 'unknown' && isPageAssetError(caught.error)) {
    return { message: 'Page assets unavailable' };
  }
};
