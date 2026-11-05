# Calendar data privacy

This page describes the calendar integration in a locally run Nimbalyst fork. It is limited to this calendar feature; other Nimbalyst features and services have their own data flows. A fork operator publishing an OAuth app should review this page against their actual implementation and supply their own application name, support contact, and hosting domain before using it as an OAuth privacy notice.

## Data accessed and purpose

When you connect a Google account, the integration requests your account identity and primary email address to label the connection, and read-only calendar access to list calendars and display their events in your local unified agenda. Microsoft connections request the corresponding account and calendar read permissions. Imported event data can include titles, start and end times, descriptions, locations, calendar identifiers, and source-event links. Recurring events are expanded into individual occurrences for the chosen range.

The calendar integration does not create or change provider events, respond to invitations, or edit sharing permissions. Calendar data is used to display and refresh your local agenda, not for advertising or sale.

## Storage and transfers

OAuth credentials, tokens, account details, calendar selections, and imported event snapshots are stored in the local application profile, encrypted through the operating system’s secure storage. The app exchanges authorization codes and tokens with the selected calendar provider and makes authenticated HTTPS requests to that provider to retrieve calendars and events. Automatic refresh uses the same local connection and permissions as manual import.

This calendar feature does not upload event snapshots to a Nimbalyst calendar server or automatically send calendar content to an AI provider. If you manually copy event information into another service or an AI conversation, that is a separate action governed by the destination’s configuration and policies.

## Retention and control

You choose which calendars to include. Automatic refresh can be paused per account. Each successful refresh replaces that account’s previous event snapshot for the selected range; a failed refresh leaves the last successful snapshot available. Disconnecting an account removes its saved connection and imported agenda from this application profile. Operating-system backups or separately exported copies may retain their own copies.

To revoke provider access, use your Google Account’s third-party connections controls or the corresponding Microsoft account or organization controls. Disconnecting locally does not itself revoke authorization at the provider. Uninstalling an application may leave its profile unless that profile is separately removed.

## Local copies and OAuth ownership

People cloning this repository configure their own OAuth application registrations and local credentials. They should not reuse another operator’s credentials or commit credentials or tokens to source control. A modified fork or a hosted service must update its privacy notice if it changes the practices described here.
