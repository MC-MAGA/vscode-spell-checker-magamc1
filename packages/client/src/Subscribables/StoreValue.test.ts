import { describe, expect, test, vi } from 'vitest';

import { createEmitter, createSubscribable } from './createFunctions.js';
import { awaitSubscribable } from './helpers/awaitSubscribable.js';
import { createStoreValue } from './StoreValue.js';

describe('StoreValue', () => {
    test('createStoreValue', async () => {
        const store = createStoreValue(5);
        expect(store.value).toBe(5);
        store.set(7);
        expect(store.value).toBe(7);
        const cb = vi.fn();
        store.subscribe(cb);
        expect(cb).toHaveBeenLastCalledWith(7);
        store.dispose();
    });

    test('createSubscribableValue', async () => {
        const source = createEmitter<number>();
        const sub = createSubscribable((s) => source.subscribe(s));
        const pValue = awaitSubscribable(sub);
        source.notify(6);
        await expect(pValue).resolves.toBe(6);
        sub.dispose();
    });
});
