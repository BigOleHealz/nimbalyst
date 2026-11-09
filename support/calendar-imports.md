# Calendar imports

Open **Settings → Application → Calendar imports** under Integrations. Google Calendar and Microsoft 365, Exchange Online, and Outlook.com accounts share this one page. Choose a provider in **Add calendar account**, expand **Connection setup**, and connect in your browser. You can add multiple accounts from either provider.

To see your events, click **Calendar** in the main left navigation gutter, alongside Files, Agent, and Tracker. Settings also has an **Open calendar** button. Calendar opens a month grid with a daily agenda and event details. **Manage accounts** returns to this unified settings page. If you previously hid the Calendar button, right-click the gutter and show it through its customization menu.

Each provider requires an OAuth application registration for your fork. Enter application credentials directly in Nimbalyst. Credentials and imported event snapshots are encrypted with your operating system’s secure storage and remain in this app profile on this computer.

People who clone the repository should create their own provider registrations and enter them in their own local Nimbalyst settings. Client credentials and account tokens are never supplied through the repository. Read [Calendar data privacy](calendar-privacy.md) for the calendar integration’s data practices.

## Google Calendar setup

1. In Google Cloud, enable the Google Calendar API and configure the OAuth consent screen. If the app is in testing, add the Google accounts you want to connect as test users.
2. Create an OAuth client with application type **Desktop app**. Enter its client ID and client secret in Calendar imports, then choose **Connect account**.
3. Complete Google sign-in and select the calendar read permission on the consent screen. Nimbalyst requests read-only calendar access and your account’s email for identifying the connection.

### Keep a personal Google connection renewable

An External Google OAuth app in **Testing** issues calendar refresh tokens that expire after seven days. In Google Auth Platform, complete the **Branding** fields and change **Audience → Publishing status** to **In production**. Google may require public application and policy links before enabling Publish. Use accurate pages on a domain you control; do not claim an upstream application’s domain or policy as your fork’s own.

Personal-use apps used only by you or a few people you know can qualify for Google’s verification exception. Production status and verification are separate: an unverified personal app can still show a warning and remains subject to Google’s user cap and organization restrictions. Publicly distributing one shared OAuth application to arbitrary users has different verification requirements. Other people running their own clones can use their own registrations.

After publishing, reconnect the existing account once in Nimbalyst to obtain a new production-mode refresh token. Reconnecting preserves the existing account’s agenda. Production tokens can still be revoked or invalidated by Google or a Workspace administrator; Nimbalyst reports refresh failures and retains the last successful events.

See [Google audience and token lifetime rules](https://support.google.com/cloud/answer/15549945), [branding requirements](https://support.google.com/cloud/answer/15549049), and [personal-use verification exceptions](https://developers.google.com/identity/protocols/oauth2/production-readiness/sensitive-scope-verification#personal-use).

See [Google’s Desktop app OAuth guide](https://developers.google.com/identity/protocols/oauth2/native-app) and [Calendar API authorization](https://developers.google.com/workspace/calendar/api/auth).

## Microsoft calendar setup

1. Register an application in Microsoft Entra ID. Choose account types that include your work/school account and personal Microsoft accounts if needed.
2. Add a **Mobile and desktop applications** platform with redirect URI **http://localhost/auth/callback**. The sign-in flow uses an ephemeral loopback port. Microsoft ignores the port when matching a localhost redirect URI.
3. Add delegated Microsoft Graph permissions **Calendars.Read** and **User.Read**. Enter the application client ID in Calendar imports, choose **Connect account**, and complete browser sign-in. Organizational consent policies may require an administrator’s approval.

This connection supports Microsoft 365 / Exchange Online and Outlook.com. Company-hosted Exchange Server is a separate integration.

See [Microsoft app registration](https://learn.microsoft.com/en-us/entra/identity-platform/quickstart-register-app), [redirect URI rules](https://learn.microsoft.com/en-us/entra/identity-platform/reply-url), and [calendarView](https://learn.microsoft.com/en-us/graph/api/calendar-list-calendarview?view=graph-rest-1.0).

## Import events and use the agenda

Automatic refresh is enabled by default for connected accounts, including accounts imported before this feature was added. Nimbalyst refreshes the saved calendar selections on startup, every five minutes while the app is running, and after wake or network recovery. Closing the settings page does not stop it. A closed app or sleeping computer cannot fetch changes; it catches up when opened or awakened.

The range rolls forward each day: seven days before today through ninety days after today, with both end dates included. Boundaries use this computer’s local calendar days, including daylight-saving changes. Refreshes replace the account’s snapshot only after every selected calendar and page succeeds. Overlapping background refreshes are skipped while a calendar operation is running; the next scheduled cycle retries. One account’s failure does not stop the others.

Choose calendars under each account and use **Refresh now** to save those selections and update immediately. The primary calendar is selected when first connecting. To use fixed **From** and **Through** dates instead, turn off **Automatic refresh** for that account, choose up to one year including both end days, and use **Import events** or **Refresh import**. Re-enable automatic refresh to return to the rolling range.

The **Calendar** view combines the latest snapshots and updates when background refreshes complete. Use previous/next month or **Today** to navigate. Click a day for its agenda or an event to see its details and open the original. Calendar checkboxes at the top control what is visible; they do not change which calendars are synced. All-day dates stay as calendar dates, multi-day events appear on each affected day, and timed events display in this computer’s time zone. Only events in each account’s last successful import range are shown; change that range in settings for dates outside the automatic rolling window.

Use **Refresh import** to retrieve changes, canceled events, and expanded recurring occurrences. A complete successful import replaces that account’s previous snapshot for the selected calendars and range. If any selected calendar or page fails, the last successful snapshot remains visible. Repeating an import deduplicates events within a calendar. The same meeting on two different connected calendars appears with each source.

**Reload calendars** refreshes the list of calendars you can select. **Disconnect** removes the account’s saved tokens and its events from the local agenda. You can reconnect and import again.

## Meeting notes

Select a meeting in Calendar to read its **Meeting notes** or add a note. Notes are private to your local Nimbalyst profile and do not change the Google or Microsoft event or notify attendees. Automatic refresh, manual imports, and reconnecting the same account preserve notes for each occurrence. Notes stay saved when an event temporarily leaves the imported range and reappear if that occurrence returns. Disconnecting the account removes its notes along with its local agenda.

You can also use the agent prompt, for example: “Add a note to tomorrow’s design review: ask about the launch date.” The agent looks up imported meetings and saves directly when your request clearly identifies one occurrence. For a request such as “Add a meeting note: discuss the budget,” it asks which meeting, showing titles, local dates and times, calendars and accounts. Repeated titles, recurring occurrences and multiple matching calendars also require a choice. It saves only after you choose; canceling the question saves nothing. The agent confirms the meeting after saving, and notes appear in that meeting’s calendar details.

Prompt access uses your latest imported snapshots. If an account is disconnected, a refresh has failed, or the meeting is outside the imported range, check **Manage accounts** and refresh or adjust the range. Using calendar tools in a prompt shares the returned meeting details and notes with the AI provider selected for that conversation; see [Calendar data privacy](calendar-privacy.md).

Imports read from the providers. Creating or changing events, replying to invitations, webhooks, syncing while the desktop app is closed, and turning events into tracker tasks are outside this import workflow.
