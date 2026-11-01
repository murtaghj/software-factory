// Maps a release's declared component variants to their implementations.
import type { ReleaseDefinition } from './releases.ts';
import type { OrdersVariant } from '../system/orders/service.ts';
import type { InventoryVariant } from '../system/inventory/service.ts';
import { reserveLine as standardClient } from '../system/orders/inventory-client.ts';
import { reserveLine as qtyFieldClient } from '../system/orders/inventory-client.qty-field.ts';
import { cancelOrder as completeCancel } from '../system/orders/cancel.complete.ts';
import { cancelOrder as happyPathCancel } from '../system/orders/cancel.happy-path.ts';
import { reserve as idempotentReserve } from '../system/inventory/reserve.idempotent.ts';
import { reserve as nonIdempotentReserve } from '../system/inventory/reserve.non-idempotent.ts';

export function ordersVariant(def: ReleaseDefinition): OrdersVariant {
  const reserveLine = def.components.ordersClient === 'standard' ? standardClient : qtyFieldClient;
  switch (def.components.ordersCancel) {
    case 'none': return { reserveLine };
    case 'complete': return { reserveLine, cancelOrder: completeCancel };
    case 'happy-path': return { reserveLine, cancelOrder: happyPathCancel };
  }
}

export function inventoryVariant(def: ReleaseDefinition): InventoryVariant {
  return { reserve: def.components.inventoryReserve === 'idempotent' ? idempotentReserve : nonIdempotentReserve };
}
