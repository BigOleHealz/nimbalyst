# Calendar imports

Open **Settings → Application → Calendar imports** under Integrations. Google Calendar and Microsoft 365, Exchange Online, and Outlook.com accounts share this one page. Choose a provider in **Add calendar account**, expand **Connection setup**, and connect in your browser. You can add multiple accounts from either provider.

Each provider requires an OAuth application registration for your fork. Enter application credentials directly in Nimbalyst. Credentials and imported event snapshots are encrypted with your operating system’s secure storage and remain in this app profile on this computer.

## Google Calendar setup

1. In Google Cloud, enable the Google Calendar API and configure the OAuth consent screen. If the app is in testing, add the Google accounts you want to connect as test users.
2. Create an OAuth client with application type **Desktop app**. Enter its client ID and client secret in Calendar imports, then choose **Connect account**.
3. Complete Google sign-in and approve calendar read access. Nimbalyst requests read-only calendar access and your account’s email for identifying the connection. Google testing-mode refresh tokens may expire, requiring reconnection.

See [Google’s Desktop app OAuth guide](https://developers.google.com/identity/protocols/oauth2/native-app) and [Calendar API authorization](https://developers.google.com/workspace/calendar/api/auth).

## Microsoft calendar setup

1. Register an application in Microsoft Entra ID. Choose account types that include your work/school account and personal Microsoft accounts if needed.
2. Add a **Mobile and desktop applications** platform with redirect URI **http://localhost/auth/callback**. The sign-in flow uses an ephemeral loopback port. Microsoft ignores the port when matching a localhost redirect URI.
3. Add delegated Microsoft Graph permissions **Calendars.Read** and **User.Read**. Enter the application client ID in Calendar imports, choose **Connect account**, and complete browser sign-in. Organizational consent policies may require an administrator’s approval.

This connection supports Microsoft 365 / Exchange Online and Outlook.com. Company-hosted Exchange Server is a separate integration.

See [Microsoft app registration](https://learn.microsoft.com/en-us/entra/identity-platform/quickstart-register-app), [redirect URI rules](https://learn.microsoft.com/en-us/entra/identity-platform/reply-url), and [calendarView](https://learn.microsoft.com/en-us/graph/api/calendar-list-calendarview?view=graph-rest-1.0).

## Import events and use the agenda

Choose calendars under each connected account. Pick **From** and **Through** dates, including both end days, for up to one year. Select **Import events** for each account. The **Unified agenda** combines their last successful imports, sorted by day and time. Expand an event for its calendar, account, location, description, and original-event link. All-day dates stay as calendar dates, and timed events display in this computer’s time zone.

Use **Refresh import** to retrieve changes, canceled events, and expanded recurring occurrences. A complete successful import replaces that account’s previous snapshot for the selected calendars and range. If any selected calendar or page fails, the last successful snapshot remains visible. Repeating an import deduplicates events within a calendar. The same meeting on two different connected calendars appears with each source.

**Reload calendars** refreshes the list of calendars you can select. **Disconnect** removes the account’s saved tokens and its events from the local agenda. You can reconnect and import again.

Imports read from the providers. Creating or changing events, replying to invitations, continuous background synchronization, and turning events into tracker tasks are outside this import workflow.
