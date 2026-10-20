// @vitest-environment node
/**
 * `nim wiki export --static` over a real temp wiki: what the site holds, what
 * it leaves out, and that links point where a reader can follow them.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { initWiki, openWiki, type LocalWiki, type ReadBodyResult, type StaticSiteLink, type StaticSiteManifest } from '@nimbalyst/local-wiki';
import { exportStaticSite } from '../exportSite.js';

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

async function fixture(): Promise<{ root: string; wiki: LocalWiki; assets: string }> {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'nim-export-')));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const assets = path.join(root, 'app');
  mkdirSync(path.join(assets, 'assets'), { recursive: true });
  mkdirSync(path.join(assets, 'models'), { recursive: true });
  writeFileSync(path.join(assets, 'index.html'), '<!doctype html><html><head><title>Local wiki</title></head><body><div id="root"></div><script type="module" src="/assets/app.js"></script></body></html>');
  writeFileSync(path.join(assets, 'assets', 'app.js'), 'console.log(1)');
  writeFileSync(path.join(assets, 'models', 'editor-models.mjs'), '');
  await initWiki(path.join(root, 'wiki'));
  const wiki = await openWiki(path.join(root, 'wiki'), { repair: true });
  cleanups.push(() => wiki.close());
  return { root, wiki, assets };
}

const read = (file: string) => readFileSync(file, 'utf8');
const json = <T>(file: string) => JSON.parse(read(file)) as T;

describe('exportStaticSite', () => {
  it('writes a page per folder, leaves out export: false pages and person fields, and keeps links followable', async () => {
    const { root, wiki, assets } = await fixture();
    await wiki.command({ type: 'register-document', title: 'Home', parentFolderId: null, sortOrder: 0, body: 'Welcome.' });
    const home = (await wiki.snapshot()).pages.find((page) => page.title === 'Home')!;
    const competitors = await wiki.command({ type: 'register-document', title: 'Competitors', parentFolderId: null, body: '' });
    const secret = await wiki.command({ type: 'register-document', title: 'Secret', parentFolderId: null, fields: { export: false }, body: 'Do not publish.' });
    await wiki.command({ type: 'register-document', title: 'Under secret', parentFolderId: secret.id!, body: 'Also hidden.' });
    const acme = await wiki.command({
      type: 'register-document',
      title: 'Acme',
      parentFolderId: competitors.id!,
      fields: { status: 'active', owner: 'Dana', contact: 'dana@example.com' },
      body: 'placeholder',
    });
    const attachment = await wiki.storeAttachment(acme.id!, 'logo.png', new Uint8Array([1, 2, 3]));
    const snapshot = await wiki.snapshot();
    const acmePage = snapshot.pages.find((page) => page.id === acme.id)!;
    const secretPage = snapshot.pages.find((page) => page.id === secret.id)!;
    const homeRel = path.posix.relative(path.posix.dirname(acmePage.path!), home.path!);
    const secretRel = path.posix.relative(path.posix.dirname(acmePage.path!), secretPage.path!);
    await wiki.writeBody(acme.id!, [
      `Acme competes with us. See [Home](${encodeURI(homeRel)} "id=${home.id}").`,
      '',
      `Notes are in [the secret page](${encodeURI(secretRel)} "id=${secret.id}") and [NIM-12](nimbalyst://NIM-12).`,
      '',
      `![Logo](${attachment.link})`,
    ].join('\n'), null);

    const out = path.join(root, 'site');
    const report = await exportStaticSite({ wiki, assetsDir: assets, outDir: out, nimVersion: '9.9.9', now: () => new Date('2026-10-20T00:00:00Z') });

    // Left out: the opted-out page and its child, by reason.
    expect(report.excluded.map((entry) => [entry.title, entry.reason]).sort()).toEqual([['Secret', 'export-false'], ['Under secret', 'under-excluded']]);
    const manifest = json<StaticSiteManifest>(path.join(out, '_wiki', 'manifest.json'));
    expect(manifest.pages[acme.id!]).toBe('competitors/acme');
    expect(manifest.pages[secret.id!]).toBeUndefined();
    expect(manifest.homeId).toBe(home.id);
    expect(existsSync(path.join(out, '_wiki', 'bodies', `${secret.id}.json`))).toBe(false);
    expect(read(path.join(out, '_wiki', 'search.json'))).not.toContain('Do not publish');

    // Person fields are gone from every file a reader can fetch; other fields stay.
    const exportedAcme = json<{ pages: Array<{ id: string; fields: Record<string, unknown> }> }>(path.join(out, '_wiki', 'snapshot.json')).pages.find((page) => page.id === acme.id)!;
    expect(exportedAcme.fields).toEqual({ status: 'active' });
    expect(report.strippedFields).toBe(2);

    // A link to a left-out page and an app-only reference become their labels; the Home link stays.
    const body = json<ReadBodyResult>(path.join(out, '_wiki', 'bodies', `${acme.id}.json`)).markdown;
    expect(body).toContain(`[Home](${encodeURI(homeRel)} "id=${home.id}")`);
    expect(body).toContain('Notes are in the secret page and NIM-12.');
    expect(report.links.map((issue) => issue.kind).sort()).toEqual(['app-only', 'excluded-page']);

    // Home lists Acme under "Linked from"; the attachment is copied where the app looks for it.
    const links = json<Record<string, StaticSiteLink[]>>(path.join(out, '_wiki', 'links.json'));
    expect(links[home.id].map((link) => [link.direction, link.otherItemId])).toEqual([['in', acme.id]]);
    expect(existsSync(path.join(out, '_wiki', 'files', ...path.posix.join(path.posix.dirname(acmePage.path!), attachment.link).split('/')))).toBe(true);

    // The prerendered page: real HTML with links relative to its folder, and the app's boot config.
    const html = read(path.join(out, 'competitors', 'acme', 'index.html'));
    expect(html).toContain('<title>Acme · Home</title>');
    expect(html).toContain('href="../../">Home</a>');
    expect(html).not.toContain('Do not publish');
    expect(html).toContain('window.__NIMBALYST_WIKI_STATIC__={"format":1,"dataPath":"/_wiki/"}');
    expect(read(path.join(out, 'index.html'))).toContain('<h2>Linked from</h2><ul><li><a href="./competitors/acme/">Acme</a>');
    // The app build is copied without its Node-only models or its unrendered shell.
    expect(existsSync(path.join(out, 'assets', 'app.js'))).toBe(true);
    expect(existsSync(path.join(out, 'models'))).toBe(false);
  });

  it('exports typed pages and table rows with their relations, leaves out excluded types, and never writes over a folder it did not make', async () => {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'nim-export-types-')));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const { assets } = await fixture();
    const typesDir = path.join(root, 'types');
    mkdirSync(typesDir);
    writeFileSync(path.join(typesDir, 'competitor.yaml'), 'type: competitor\ndisplayName: Competitor\ndisplayNamePlural: Competitors\nstorage: pages\nfields:\n  - name: title\n    type: string\n  - name: lead\n    type: user\n  - name: partner\n    type: relationship\n    itemType: partner\n');
    writeFileSync(path.join(typesDir, 'partner.yaml'), 'type: partner\ndisplayName: Partner\ndisplayNamePlural: Partners\nstorage: table\nfields:\n  - name: title\n    type: string\n');
    writeFileSync(path.join(typesDir, 'memo.yaml'), 'type: memo\ndisplayName: Memo\ndisplayNamePlural: Memos\nstorage: pages\nfields:\n  - name: title\n    type: string\n');
    await initWiki(path.join(root, 'wiki'));
    writeFileSync(path.join(root, 'wiki', 'Partners.csv'), 'id,title\nP1,Globex\n');
    const wiki = await openWiki(path.join(root, 'wiki'), { typesDir });
    cleanups.push(() => wiki.close());
    await wiki.command({ type: 'register-document', title: 'Home', parentFolderId: null, sortOrder: 0, body: 'Welcome.' });
    const acme = await wiki.trackerCommand('competitor', { type: 'create-item', item: { title: 'Acme', fields: { lead: 'Dana Lee', partner: 'P1' }, body: 'A competitor.' } });
    const memo = await wiki.trackerCommand('memo', { type: 'create-item', item: { title: 'Board memo', body: 'Private.' } });

    const out = path.join(root, 'site');
    await exportStaticSite({ wiki, assetsDir: assets, outDir: out, nimVersion: '9.9.9', excludeTypes: ['memo'] });
    const manifest = json<StaticSiteManifest>(path.join(out, '_wiki', 'manifest.json'));
    expect(manifest.pages[acme.id!]).toBe('acme');
    expect(manifest.pages.P1).toBe('items/p1');
    expect(manifest.pages[memo.id!]).toBeUndefined();
    expect(Object.keys(manifest.types).sort()).toEqual(['competitor', 'partner']);
    // The relationship field links Acme to the row both ways; the person field is gone.
    const links = json<Record<string, StaticSiteLink[]>>(path.join(out, '_wiki', 'links.json'));
    expect(links.P1).toEqual([expect.objectContaining({ direction: 'in', otherItemId: acme.id, sourceFieldId: 'partner' })]);
    const tracker = json<{ items: Array<{ id: string; fields: Record<string, unknown> }> }>(path.join(out, '_wiki', 'trackers', 'competitor.json'));
    expect(tracker.items.map((item) => [item.id, item.fields])).toEqual([[acme.id, expect.not.objectContaining({ lead: expect.anything() })]]);
    expect(read(path.join(out, 'types', 'partner', 'index.html'))).toContain('href="../../items/p1/">Globex</a>');

    // Re-exporting keeps the earlier site beside the new one; a folder with other files is refused untouched.
    const again = await exportStaticSite({ wiki, assetsDir: assets, outDir: out, nimVersion: '9.9.9' });
    expect(again.previous).toBe(`${out}.previous`);
    expect(existsSync(path.join(out, '_wiki', 'manifest.json'))).toBe(true);
    const busy = path.join(root, 'busy');
    mkdirSync(busy);
    writeFileSync(path.join(busy, 'notes.txt'), 'mine');
    await expect(exportStaticSite({ wiki, assetsDir: assets, outDir: busy, nimVersion: '9.9.9' })).rejects.toThrow(/not empty/);
    expect(read(path.join(busy, 'notes.txt'))).toBe('mine');
  });
});
