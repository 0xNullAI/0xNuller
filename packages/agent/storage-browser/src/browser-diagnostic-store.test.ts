import 'fake-indexeddb/auto';
import { expect, it } from 'vitest';
import { BrowserDiagnosticStore } from './browser-diagnostic-store';
it('serializes incremental writes and prunes retired records, including clear', async () => {
  const store = new BrowserDiagnosticStore<{ id: string; message: string }>();
  await store.load();
  await store.save([]);
  const one = { id: 'one', message: 'first' };
  const two = { id: 'two', message: 'second' };
  await Promise.all([store.save([one]), store.save([one, two]), store.save([two])]);
  expect(await new BrowserDiagnosticStore().load()).toEqual([two]);
  await store.save([]);
  expect(await new BrowserDiagnosticStore().load()).toEqual([]);
});

it('clears persisted history before the new instance has loaded it', async () => {
  await new BrowserDiagnosticStore().save([{ id: 'old' }]);
  await new BrowserDiagnosticStore().save([]);
  expect(await new BrowserDiagnosticStore().load()).toEqual([]);
});
it('orders a pending load before clear so stale history cannot survive', async () => {
  await new BrowserDiagnosticStore().save([{ id: 'old' }]);
  const store = new BrowserDiagnosticStore();
  const loading = store.load();
  const clearing = store.save([]);
  await Promise.all([loading, clearing]);
  expect(await store.load()).toEqual([]);
});
