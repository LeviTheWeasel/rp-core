import { expect, test } from 'bun:test';
import { FileRecordStore, MemoryRecordStore, checkRecordStoreConformance } from '../../src/session/port.ts';
import { tmpHome } from '../helpers.ts';
import { makeHeader, msg, seqd } from './fixtures.ts';

const rows = seqd([msg('aaaa0001', null), msg('aaaa0002', 'aaaa0001', 'user')]);

for (const [label, make] of [
  ['memory', () => new MemoryRecordStore()],
  ['file', () => new FileRecordStore(tmpHome())],
] as const) {
  test(`${label} record store passes the shared contract`, async () => {
    await checkRecordStoreConformance(make, makeHeader(), rows);
  });
}

test('file durable rows survive a new store instance', async () => {
  const home = tmpHome();
  await checkRecordStoreConformance(() => new FileRecordStore(home), makeHeader(), rows, () => new FileRecordStore(home));
});

test('in-memory store rejects a bad batch without writing its prefix', async () => {
  const store = new MemoryRecordStore();
  const header = makeHeader();
  await store.create(header);
  const lease = await store.acquire(header.id);
  expect(store.append(lease, [rows[0]!, { ...rows[1]!, seq: 9 }], true)).rejects.toThrow();
  const read = [];
  for await (const row of store.read(header.id)) read.push(row);
  expect(read).toEqual([header]);
  await lease.release();
});
