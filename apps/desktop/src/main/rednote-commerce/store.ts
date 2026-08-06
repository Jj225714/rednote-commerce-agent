import { BrowserWindow } from 'electron';
import Store from 'electron-store';

import type { RednoteCommerceState, RednoteStateRepository } from '@rednote/commerce-core';

import { ownerScopedUserDataPath } from '../appSessionState.js';
import { REDNOTE_COMMERCE_CHANNELS } from '../../shared/rednoteCommerce.js';

interface RednoteCommerceStoreShape {
  state: RednoteCommerceState | null;
}

let storeInstance: Store<RednoteCommerceStoreShape> | null = null;
let storePath: string | null = null;

function getStore(): Store<RednoteCommerceStoreShape> {
  const currentPath = ownerScopedUserDataPath();
  if (!storeInstance || storePath !== currentPath) {
    storeInstance = new Store<RednoteCommerceStoreShape>({
      name: 'rednote-commerce',
      cwd: currentPath,
      defaults: { state: null },
    });
    storePath = currentPath;
  }
  return storeInstance;
}

function broadcastChanged(revision: number): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(REDNOTE_COMMERCE_CHANNELS.changed, { revision });
    }
  }
}

export const rednoteCommerceRepository: RednoteStateRepository = {
  async load() {
    return getStore().get('state');
  },
  async save(state) {
    getStore().set('state', state);
    broadcastChanged(state.revision);
  },
};

export function resetRednoteCommerceStoreForTests(): void {
  storeInstance = null;
  storePath = null;
}
