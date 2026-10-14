export function isPageAssetError(error: unknown): boolean {
  return error instanceof Error && /Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed|Unable to preload CSS/i.test(error.message);
}

export function pageError(status: number, message?: string): { title: string; message: string } {
  if (message === 'Page assets unavailable') return {
    title: 'This page could not download',
    message: 'Check your connection, then reload. An older app version or an interrupted download can prevent this page from opening.'
  };
  if (status === 404) return {
    title: 'Page not found',
    message: 'This address does not exist, or the item is no longer available. Open Overview to find your sessions and automations.'
  };
  if (status === 401 || status === 403) return {
    title: 'Access unavailable',
    message: 'This device does not have permission to open this page. Check its access from the computer running Pi Companion.'
  };
  if (status >= 500) return {
    title: 'Could not open this page',
    message: 'An unexpected error stopped this page from opening. Reload to try again. If it happens again, share the error code and page address (without pairing tokens).'
  };
  return {
    title: 'Page unavailable',
    message: 'Pi Companion could not load this page. Reload to try again, or return to Overview.'
  };
}
