import type { TrackerRecord } from './TrackerRecord';
import { getFieldByRole } from '../plugins/TrackerPlugin/trackerRecordAccessors';

/** Keep client-session highlighting consistent across tracker surfaces. */
export function clientSessionClass(item: TrackerRecord): string {
  const tags = getFieldByRole(item, 'tags');
  const labels = item.fields.labels;
  return [tags, labels].some(values => Array.isArray(values)
    && values.some(value => typeof value === 'string' && value.trim().toLowerCase() === 'rustdesk'))
    ? 'tracker-client-session' : '';
}
