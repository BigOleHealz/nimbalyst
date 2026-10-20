/**
 * `nim wiki export --static <dir> [--title T] [--subtree <page>] [--outside-refs text|console]
 * [--exclude-type <type>,...] [--keep-identity] [--assets <dir>] [--json]`: the local wiki as a static
 * website. See staticExport/exportSite.ts.
 */
import * as path from 'node:path';
import type { ParsedArgs } from '../cli/parse.js';
import { flagBool, flagStr } from '../cli/parse.js';
import { CliError, ExitCode, usageError } from '../cli/exitCodes.js';
import { safeText } from '../cli/output.js';
import type { OpenedWiki } from '../localWiki/open.js';
import { findPage } from '../localWiki/tree.js';
import { installHint, resolveWikiWebAssets } from '../serve/assets.js';
import { exportStaticSite, StaticExportError, type StaticExportReport } from '../staticExport/exportSite.js';

const ISSUE_LABEL: Record<string, string> = {
  'excluded-page': 'links to a page left out (shown as text)',
  'missing-page': 'links to a page the wiki does not have (shown as text)',
  'outside-wiki': 'links to files outside the wiki folder, such as repository docs (shown as text)',
  'app-only': 'nimbalyst:// or collab:// references (shown as text)',
  outside: 'links to the Nimbalyst console',
  'missing-file': 'links to files that do not exist',
};

function describe(report: StaticExportReport, outsideRefs: string): string {
  const lines = [
    `Exported ${report.pages} pages, ${report.typedPages} typed pages, ${report.rows} table rows, ${report.types} types and ${report.files} linked files to ${safeText(report.outDir)}`,
  ];
  if (report.previous) lines.push(`The earlier export is in ${safeText(report.previous)}`);
  if (report.excluded.length) {
    lines.push(`Left out: ${report.excluded.map((entry) => `${safeText(entry.title || entry.id)} (${entry.reason})`).join(', ')}`);
  }
  if (report.strippedFields) lines.push(`Removed ${report.strippedFields} person fields (owners, assignees, emails); --keep-identity keeps them`);
  const counts = new Map<string, number>();
  for (const issue of report.links) counts.set(issue.kind, (counts.get(issue.kind) ?? 0) + 1);
  for (const [kind, count] of counts) {
    const label = kind === 'outside' ? `${ISSUE_LABEL[kind]} (${outsideRefs === 'console' ? 'kept as links' : 'shown as text'})` : ISSUE_LABEL[kind] ?? kind;
    lines.push(`  ${count} ${label}`);
  }
  lines.push('', 'Serve the folder from the root of a site (any static host, or `npx serve <dir>` to try it).');
  return lines.join('\n');
}

export async function runWikiExport(args: ParsedArgs, opened: OpenedWiki, version: string): Promise<number> {
  const outDir = flagStr(args, 'static') ?? args.positionals[0];
  if (!outDir) throw usageError('nim wiki export needs a folder: nim wiki export --static <dir>');
  const outsideRefs = flagStr(args, 'outside-refs') ?? 'text';
  if (outsideRefs !== 'text' && outsideRefs !== 'console') throw usageError('--outside-refs is text or console');
  const rootRef = flagStr(args, 'subtree');
  const rootPageId = rootRef ? findPage(await opened.wiki.snapshot(), rootRef).id : undefined;
  const resolution = resolveWikiWebAssets({ flag: flagStr(args, 'assets'), projectRoot: opened.projectRoot });
  if (!resolution.ok) throw new CliError(ExitCode.NOT_FOUND, installHint(version, resolution).trimEnd());
  let report: StaticExportReport;
  try {
    report = await exportStaticSite({
      wiki: opened.wiki,
      assetsDir: resolution.assets.dir,
      outDir,
      nimVersion: version,
      // A site is named for its project, not its Home page (which every wiki calls Home).
      title: flagStr(args, 'title') ?? (opened.projectRoot ? path.basename(opened.projectRoot) : undefined),
      outsideRefs,
      keepIdentity: flagBool(args, 'keep-identity'),
      rootPageId,
      excludeTypes: (flagStr(args, 'exclude-type') ?? '').split(',').map((typeId) => typeId.trim()).filter(Boolean),
    });
  } catch (error) {
    if (error instanceof StaticExportError) throw usageError(error.message);
    throw error;
  }
  process.stdout.write((flagBool(args, 'json') ? JSON.stringify(report, null, 2) : describe(report, outsideRefs)) + '\n');
  return ExitCode.OK;
}
