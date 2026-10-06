import { RELEASE_TRUTH } from './release-truth.ts';

export const PRODUCT_NAME = RELEASE_TRUTH.product.name;
export const PRODUCT_TITLE = RELEASE_TRUTH.product.title;
// Public product version tracks the stable public MCP/review snapshot.
// The separately distributed Windows runtime may advance independently.
export const PUBLIC_PRODUCT_VERSION = RELEASE_TRUTH.product.publicSurfaceVersion;
export const PRODUCT_VERSION = PUBLIC_PRODUCT_VERSION;

export function runtimeProductIdentity(): { name: string; title: string; version: string } {
  return { name: PRODUCT_NAME, title: PRODUCT_TITLE, version: PRODUCT_VERSION };
}
