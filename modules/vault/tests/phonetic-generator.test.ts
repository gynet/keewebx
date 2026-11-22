import { expect, jest, test } from 'bun:test';
import { PasswordGenerator } from '../src/util/generators/password-generator';
import { randomBelow } from '../src/util/generators/phonetic';

test('the random index rejects samples outside the uniform range', () => {
    const draws = [0xffffffff, 5];
    const random = jest.spyOn(crypto, 'getRandomValues').mockImplementation(sample => {
        (sample as Uint32Array)[0] = draws.shift()!;
        return sample;
    });
    try {
        expect(randomBelow(3)).toBe(2);
        expect(random).toHaveBeenCalledTimes(2);
    } finally {
        random.mockRestore();
    }
});

test('pronounceable passwords use cryptographic randomness and keep the requested length', () => {
    const random = jest.spyOn(Math, 'random').mockImplementation(() => { throw new Error('Unexpected PRNG'); });
    try {
        const options = { name: 'Pronounceable', length: 24, upper: true };
        const password = PasswordGenerator.generate(options);
        expect(password).toMatch(/^[a-zA-Z]{24}$/);
        expect(password).toMatch(/[A-Z]/);
        expect(PasswordGenerator.generate({ ...options, length: 0 })).toBe('');
    } finally {
        random.mockRestore();
    }
});
