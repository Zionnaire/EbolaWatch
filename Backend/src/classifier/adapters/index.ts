import type { Contract } from '../../contracts/api/index.js';
import { multilabelV1Adapter } from './multilabelV1.js';
import { threeClassV0Adapter } from './threeClassV0.js';
import type { ContractAdapter } from './types.js';

export function adapterFor(contract: Contract): ContractAdapter {
  return contract === 'threeclass-v0' ? threeClassV0Adapter : multilabelV1Adapter;
}

export type { AdaptedItem, ContractAdapter, ParsedResponse } from './types.js';
