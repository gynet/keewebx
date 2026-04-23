import { describe, test, expect } from 'bun:test';

// Inline from src/background/protocol/protocol-error.ts
class ProtocolError extends Error {
    readonly code: string;

    constructor(message: string, code: string) {
        super(message);
        this.code = code;
    }
}

enum ProtocolErrorCode {
    DatabaseNotOpened = '1',
    UserRejected = '6',
    NoMatches = '15'
}

describe('ProtocolError', () => {
    test('stores message and code', () => {
        const err = new ProtocolError('Database not opened', ProtocolErrorCode.DatabaseNotOpened);
        expect(err.message).toBe('Database not opened');
        expect(err.code).toBe('1');
    });

    test('is an instance of Error', () => {
        const err = new ProtocolError('test', '0');
        expect(err).toBeInstanceOf(Error);
        expect(err).toBeInstanceOf(ProtocolError);
    });

    test('can be caught as Error', () => {
        try {
            throw new ProtocolError('No matches', ProtocolErrorCode.NoMatches);
        } catch (e) {
            expect(e).toBeInstanceOf(Error);
            expect((e as ProtocolError).code).toBe('15');
        }
    });
});

describe('ProtocolErrorCode', () => {
    test('has expected string values', () => {
        expect(ProtocolErrorCode.DatabaseNotOpened).toBe('1');
        expect(ProtocolErrorCode.UserRejected).toBe('6');
        expect(ProtocolErrorCode.NoMatches).toBe('15');
    });
});
