import { app, safeStorage } from 'electron';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { hardenPrivateFile, writePrivateFile } from '../../utils/privateFile';
import { isProviderEncryptionAvailable } from '../credentials/providerCredentials';

const clientSchema = z.object({ clientId: z.string().min(1), clientSecret: z.string().optional() });
const eventSchema = z.object({
  id: z.string(), calendarId: z.string(), title: z.string(), start: z.string(), end: z.string(), allDay: z.boolean(),
  location: z.string().optional(), description: z.string().optional(), url: z.string().optional(),
});
const dataSchema = z.object({
  version: z.literal(1),
  clients: z.object({ google: clientSchema.optional(), microsoft: clientSchema.optional() }),
  accounts: z.array(z.object({
    id: z.string(), provider: z.enum(['google', 'microsoft']), label: z.string(),
    clientId: z.string(), clientSecret: z.string().optional(),
    accessToken: z.string(), refreshToken: z.string(), expiresAt: z.number(),
    calendars: z.array(z.object({ id: z.string(), name: z.string(), primary: z.boolean() })),
    selectedCalendarIds: z.array(z.string()), events: z.array(eventSchema),
    meetingNotes: z.array(z.object({
      calendarId: z.string(), eventId: z.string(), id: z.string(), text: z.string(), createdAt: z.string(),
    })).optional(),
    importedAt: z.string().optional(), range: z.object({ start: z.string(), end: z.string() }).optional(),
    autoRefresh: z.boolean().optional(), syncError: z.string().optional(),
  })),
});

export type CalendarData = z.infer<typeof dataSchema>;
export type CalendarAccount = CalendarData['accounts'][number];
export interface CalendarStorage {
  read(): CalendarData;
  write(data: CalendarData): void;
}

/** A separate vault keeps calendar credentials out of AI-provider credential exports. */
export class CalendarStore implements CalendarStorage {
  private path(): string {
    if (!isProviderEncryptionAvailable(safeStorage, process.platform, app.isReady())) {
      throw new Error('Calendar imports require secure storage. Unlock your keychain and retry.');
    }
    return join(app.getPath('userData'), 'calendar-imports', 'accounts.bin');
  }

  read(): CalendarData {
    const file = this.path();
    if (!existsSync(file)) return { version: 1, clients: {}, accounts: [] };
    try {
      hardenPrivateFile(file);
      return dataSchema.parse(JSON.parse(safeStorage.decryptString(readFileSync(file))));
    } catch {
      throw new Error('Saved calendar connections could not be read. Unlock secure storage and retry.');
    }
  }

  write(data: CalendarData): void {
    const file = this.path();
    try {
      const text = JSON.stringify(dataSchema.parse(data));
      writePrivateFile(file, safeStorage.encryptString(text), bytes => {
        if (safeStorage.decryptString(bytes) !== text) throw new Error('Verification failed');
      });
    } catch {
      throw new Error('Calendar imports could not be saved securely. Retry after checking secure storage.');
    }
  }
}
