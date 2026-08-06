import { RednoteCommerceService } from '@rednote/commerce-core';

import { rednoteCommerceRepository } from './store.js';

let service: RednoteCommerceService | null = null;

export function getRednoteCommerceService(): RednoteCommerceService {
  service ??= new RednoteCommerceService({ repository: rednoteCommerceRepository });
  return service;
}

export function resetRednoteCommerceServiceForTests(): void {
  service = null;
}
