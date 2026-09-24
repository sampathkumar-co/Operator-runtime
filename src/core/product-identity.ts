export const PRODUCT_NAME = 'mecord-connect';
export const PRODUCT_TITLE = 'Mecord Connect';
// Public product version tracks the stable public MCP/review snapshot.
// The separately distributed Windows runtime may advance patch versions without changing this value.
export const PUBLIC_PRODUCT_VERSION = '1.0.0';
export const PRODUCT_VERSION = PUBLIC_PRODUCT_VERSION;

export function runtimeProductIdentity(): { name: string; title: string; version: string } {
  return { name: PRODUCT_NAME, title: PRODUCT_TITLE, version: PRODUCT_VERSION };
}
