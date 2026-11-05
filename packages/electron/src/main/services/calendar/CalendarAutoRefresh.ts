import { onNetworkAvailable } from '../NetworkAvailability';
import { CALENDAR_AUTO_REFRESH_MS, type CalendarImportsSnapshot } from '../../../shared/calendarImports';

/** One scheduler per app process, independent of settings panels and windows. */
export class CalendarAutoRefresh {
  private timer?: ReturnType<typeof setInterval>;
  private unsubscribe?: () => void;
  private running = false;
  private generation = 0;

  constructor(
    private readonly refreshAccounts: () => Promise<CalendarImportsSnapshot | undefined>,
    private readonly changed: (snapshot: CalendarImportsSnapshot) => void,
    private readonly failed: (error: unknown) => void,
    private readonly subscribeWake: (callback: () => void) => () => void = onNetworkAvailable,
  ) {}

  start(): void {
    if (this.timer) return;
    this.generation++;
    this.unsubscribe = this.subscribeWake(() => { void this.refresh(); });
    this.timer = setInterval(() => { void this.refresh(); }, CALENDAR_AUTO_REFRESH_MS);
    this.timer.unref?.();
    void this.refresh();
  }

  async refresh(): Promise<void> {
    if (!this.timer || this.running) return;
    this.running = true;
    const generation = this.generation;
    try {
      const snapshot = await this.refreshAccounts();
      if (snapshot && this.timer && generation === this.generation) this.changed(snapshot);
    } catch (error) {
      if (this.timer && generation === this.generation) this.failed(error);
    } finally {
      this.running = false;
    }
  }

  stop(): void {
    this.generation++;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }
}
