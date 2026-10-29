import { expect, test } from 'bun:test';
import { FileSessionStore, MemorySessionStore, type SessionStore } from '../../src/session/backend.ts';
import { tmpHome } from '../helpers.ts';
import { makeHeader, msg, TS } from './fixtures.ts';

function contract(label: string, make: () => SessionStore): void {
  test(`${label}: create, exclusive open, append, reopen and fork`, () => {
    const store = make();
    const header = makeHeader();
    const first = msg('aaaa0001', null);
    const log = store.create(header, [first]);
    expect(log.entries()).toHaveLength(1);
    expect(log.lastSeq()).toBe(1);
    expect(() => store.open(header.id)).toThrow();
    const second = log.append(msg('aaaa0002', 'aaaa0001', 'user'));
    expect(second.seq).toBe(2);
    const fork = store.fork({ header, entries: log.entries() }, 'aaaa0002', { newId: 's_0000a002', now: TS });
    expect(fork.header.fork).toEqual({ from: header.id, at: 'aaaa0002' });
    fork.close();
    log.close();
    const reopened = store.open(header.id).log;
    expect(reopened.entries()).toHaveLength(2);
    expect(reopened.entries().map((entry) => entry.seq)).toEqual([1, 2]);
    reopened.close();
    expect(store.list().map((row) => row.id).sort()).toEqual(['s_0000a001', 's_0000a002']);
  });
}

contract('file session store', () => new FileSessionStore(tmpHome()));
contract('memory session store', () => new MemorySessionStore());
