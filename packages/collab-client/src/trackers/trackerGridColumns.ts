import { clientSessionClass } from '@nimbalyst/runtime/core/clientSessionHighlight';
import type { TrackerRecord } from '@nimbalyst/runtime/core/TrackerRecord';
import type { TrackerColumnDef } from '@nimbalyst/runtime/plugins/TrackerPlugin/components/trackerColumns';
import { getCellValue, resolveColumnFieldName } from './model';
import { getRecordTicketKey } from '@nimbalyst/runtime/plugins/TrackerPlugin/trackerRecordAccessors';

/** Row key holding the tracker item id; prefixed so it cannot collide with a field name. */
export const ROW_ITEM_ID = '__trackerItemId';
/** Row key holding the primary tracker type for mixed-schema resolution. */
export const ROW_ITEM_TYPE = '__trackerItemType';
/** Display metadata only; editable title cells retain their original raw value. */
export const ROW_TICKET_KEY = '__trackerTicketKey';
/** Structural pinned column owned by the host grid adapter. */
export const ROW_ACTIONS = '__trackerActions';

export type TrackerGridRow = Record<string, unknown>;

/** Build one portable grid source row per record, keyed by column id. */
export function buildGridSource(
  items: TrackerRecord[],
  columns: TrackerColumnDef[],
): TrackerGridRow[] {
  return items.map(item => {
    const row: TrackerGridRow = {
      [ROW_ITEM_ID]: item.id,
      [ROW_ITEM_TYPE]: item.primaryType,
      __clientSessionClass: clientSessionClass(item),
      [ROW_TICKET_KEY]: getRecordTicketKey(item),
    };
    for (const col of columns) {
      row[col.id] = getCellValue(item, resolveColumnFieldName(item.primaryType, col));
    }
    return row;
  });
}
