// Module augmentation for kdbxweb's ProtectedValue class.
//
// `app/scripts/util/kdbxweb/protected-value-ex.ts` monkey-patches the
// ProtectedValue prototype at runtime to add helpers that don't exist on
// the upstream class (isProtected discriminator flag, textLength,
// forEachChar, includesLower/indexOfLower/indexOfSelfInLower, equals,
// isFieldReference, saltedValue, dataAndSalt, fromBase64). The patches
// are applied at import time during app bootstrap, but TypeScript has
// no way to know about them unless we tell it here.
//
// The extra `import` below turns this file into a module (instead of a
// script), which is what makes `declare module 'kdbxweb'` act as a
// module augmentation rather than a wholesale redeclaration. Without
// the import, this declaration would shadow the real kdbxweb types and
// every property on `KdbxEntry`, `Kdbx`, `ByteUtils`, etc. would vanish.
//
// If you add a new prototype patch in protected-value-ex.ts, mirror its
// signature here.
import 'kdbxweb';

declare module 'kdbxweb' {
    interface ProtectedValue {
        /**
         * Runtime discriminator flag set to `true` on every ProtectedValue
         * instance. Lets consumers tell protected values apart from plain
         * strings when narrowing `string | ProtectedValue` field values
         * without reaching for `instanceof` (which is awkward across the
         * many `as unknown` casts in the legacy code).
         */
        readonly isProtected: true;

        readonly length: number;
        readonly textLength: number;

        forEachChar(fn: (charCode: number) => void | false): void;
        includesLower(findLower: string): boolean;
        indexOfLower(findLower: string): number;
        indexOfSelfInLower(targetLower: string): number;
        equals(other: unknown): boolean;
        isFieldReference(): boolean;
        saltedValue(): string | number;
        dataAndSalt(): { data: number[]; salt: number[] };
    }

    namespace ProtectedValue {
        function fromBase64(base64: string): ProtectedValue;
    }
}
