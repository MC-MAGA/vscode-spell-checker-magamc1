import { describe, expect, test } from 'vitest';

import * as index from './index.js';

describe('index', () => {
    test('index api', () => {
        expect(Object.keys(index).sort()).toMatchSnapshot();
    });
});
