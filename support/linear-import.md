# Import Linear projects and tickets

Open **Settings → Application → Linear**. Create a personal API key in Linear’s **Settings → Security & access**, with read access to the projects you want to import. Enter it in Nimbalyst’s password field and select **Connect Linear**. The key is encrypted using your operating system’s credential storage and stays on this computer. An empty key field keeps the saved key; replacing it first checks that the new key works.

Choose a destination folder, select projects, and select **Import selected projects**. Use **Load more projects** to see additional projects. Each project becomes a separate local workspace in that folder, with a readable folder name and the project’s unique ID. **Open** beside a result opens that workspace. Its README contains the Linear project description and a link to the original project.

Each project’s tickets become native tracker tasks, including completed, canceled, and archived tickets. Titles include their Linear identifier. Descriptions, labels, priorities, workflow state, and source links are imported; the description also records the Linear project and assignee. Completed tickets map to Done, canceled tickets to Won’t Do, and started tickets to In Progress. Other tickets start in To Do. Existing Nimbalyst tasks can be edited and linked to agent sessions normally.

Repeat an import into the same destination to add missing tickets. Existing tickets and local README edits are preserved, including after a Linear project is renamed. The result lists imported and already-imported counts and any failures. If a request fails or Linear rate limits access, retry after resolving the error; completed imports are not duplicated. Keep the workspace folder’s ID suffix and its `.linear-project.json` file so future imports can recognize it.

For individual tickets, open an existing workspace and choose **Trackers → Import → Import from Linear**. Choose a Linear project or **All accessible tickets**, filter by title and state, load additional pages, select tickets, and import. This includes tickets with no Linear project. The source chip opens Linear. **Pull latest from source** conservatively updates unchanged titles and statuses, unions labels, and offers changed descriptions for review.

This is a read-only snapshot import. It does not write changes back to Linear, automatically synchronize future changes, clone code repositories, or connect newly created workspaces to a Nimbalyst team. Comments, attachments, cycles, and ticket relationships are not copied. Use the workspace’s normal sharing settings if you want to share imported work.

## Manual acceptance

1. Connect a key with access to at least two projects. Select both, choose an empty destination folder, and import. Confirm two workspaces appear and each contains only its project’s tickets, with descriptions, status, labels, priority, and working Linear links. Include a project with more than 50 tickets and at least one completed ticket.
2. Edit an imported ticket and README locally. Repeat the import into the same folder. Confirm those edits remain and no tickets are duplicated. Add a Linear ticket, import again, and confirm only the new ticket is added.
3. In an existing workspace, import an individual ticket using the title search and **Load more**. Switch project bindings while a request is pending; confirm old results do not replace the current project’s results.
4. Try an invalid replacement key. Confirm the error appears and the existing connection still works. Retry a partial import after an access or network failure; confirm successful tickets are preserved.

API reference: [Linear GraphQL authentication and error handling](https://linear.app/developers/graphql), [pagination](https://linear.app/developers/pagination).
