/** Keep bundle diagnostics portable without changing dependency identities. */
export function normalizeBundleReportModuleId(id: string | null, repoRoot: string): string | null {
  if (id === null) return null;
  const normalized = id.replaceAll('\\', '/');
  const virtualPrefix = normalized.startsWith('\0') ? '\0' : '';
  const pathPart = virtualPrefix ? normalized.slice(1) : normalized;
  const root = repoRoot.replaceAll('\\', '/').replace(/\/+$/, '');
  if (pathPart.startsWith(`${root}/`)) {
    return `${virtualPrefix}${pathPart.slice(root.length)}`;
  }
  // Linked worktrees can resolve packages from the primary checkout or an
  // external store. Keep the complete nested package path, not its machine root.
  const dependencyStart = pathPart.indexOf('/node_modules/');
  return dependencyStart >= 0
    ? `${virtualPrefix}${pathPart.slice(dependencyStart)}`
    : normalized;
}
