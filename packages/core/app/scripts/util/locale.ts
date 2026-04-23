// `locales/base.json` resolves via the tsconfig path mapping
// `locales/*` -> `app/scripts/locales/*` and TypeScript's
// `resolveJsonModule: true` setting picks up JSON imports natively.
import Locale from 'locales/base.json';

export { Locale };
