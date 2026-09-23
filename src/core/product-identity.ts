export const PRODUCT_NAME = 'mecord-connect';
export const PRODUCT_TITLE = 'Mecord Connect';
export const PRODUCT_VERSION = '1.0.0';

export function runtimeProductIdentity(): { name: string; title: string; version: string } {
  return { name: PRODUCT_NAME, title: PRODUCT_TITLE, version: PRODUCT_VERSION };
}
