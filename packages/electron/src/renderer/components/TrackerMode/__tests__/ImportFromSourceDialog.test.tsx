import React from 'react';
import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { ImportFromSourceDialog } from '../ImportFromSourceDialog';

const invoke = vi.fn();
const entry = (id: string) => ({ externalId: id, urn: `linear://issue/${id}`, title: `Ticket ${id}`, state: 'Todo', url: '', updatedAt: '' });
beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: { invoke } });
  invoke.mockImplementation(async (channel: string, args: any) => {
    if (channel === 'tracker:importer:listBindings') return [{ id: 'all', label: 'All accessible tickets' }];
    if (channel === 'tracker:importer:listItems') return args.filters.cursor ? { items: [entry('b')] } : { items: [entry('a')], nextCursor: 'next' };
    if (channel === 'tracker:importer:import') return { created: true };
    return undefined;
  });
});

it('loads later ticket pages and imports selections across them in the explicit workspace', async () => {
  const imported = vi.fn();
  render(<ImportFromSourceDialog providerId="linear" providerLabel="Linear" workspacePath="/workspace" importsAs={['task']} onClose={vi.fn()} onImported={imported} />);
  fireEvent.click(await screen.findByText('Ticket a'));
  fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
  fireEvent.click(await screen.findByText('Ticket b'));
  fireEvent.click(screen.getByTestId('import-from-source-confirm'));
  await waitFor(() => expect(imported).toHaveBeenCalledWith(2));
  expect(invoke).toHaveBeenCalledWith('tracker:importer:listItems', expect.objectContaining({ filters: expect.objectContaining({ cursor: 'next' }) }));
  expect(invoke).toHaveBeenCalledWith('tracker:importer:import', { workspacePath: '/workspace', providerId: 'linear', externalId: 'a', primaryType: 'task' });
  expect(invoke).toHaveBeenCalledWith('tracker:importer:import', expect.objectContaining({ externalId: 'b' }));
});

it('discards an older request when the user changes project bindings', async () => {
  let finishOld: (page: unknown) => void = () => {};
  invoke.mockImplementation(async (channel: string, args: any) => {
    if (channel === 'tracker:importer:listBindings') return [{ id: 'one', label: 'One' }, { id: 'two', label: 'Two' }];
    if (channel === 'tracker:importer:listItems') return args.binding.id === 'one' ? new Promise(resolve => { finishOld = resolve; }) : { items: [entry('new')] };
    return undefined;
  });
  render(<ImportFromSourceDialog providerId="linear" providerLabel="Linear" workspacePath="/workspace" importsAs={['task']} onClose={vi.fn()} />);
  await waitFor(() => expect(invoke).toHaveBeenCalledWith('tracker:importer:listItems', expect.objectContaining({ binding: { id: 'one', label: 'one' } })));
  fireEvent.change(screen.getAllByRole('combobox')[0], { target: { value: 'two' } });
  await screen.findByText('Ticket new');
  finishOld({ items: [entry('old')] });
  await waitFor(() => expect(screen.queryByText('Ticket old')).not.toBeInTheDocument());
  expect(screen.getByText('Ticket new')).toBeInTheDocument();
});
