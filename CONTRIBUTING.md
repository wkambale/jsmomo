# Contributing

Contributions are welcome. Follow these guidelines to set up your environment, meet code quality standards, and run tests.

## Development setup

Clone the repository and install development dependencies (Node.js 22+ recommended for local test tooling; compiled output targets Node.js 18+):

```bash
git clone https://github.com/wkambale/jsmomo.git
cd jsmomo
npm ci
```

## Styling and quality checks

We enforce strict formatting, linting, typing, and security checks across `src/` and `tests/`:

- **Linting:** ESLint 10 with `typescript-eslint`
- **Formatting:** Prettier
- **Type safety:** TypeScript strict mode (`tsc --noEmit`)
- **Security:** `npm audit --audit-level=high` must report zero high or critical vulnerabilities
- **Coverage:** Vitest V8 coverage threshold is **90%** minimum across lines and statements

Run the entire local verification suite before opening a pull request:

```bash
npm run format
npm run verify
```

## Writing and running tests

All new methods, providers, and error handlers must include unit or integration tests under `tests/`.

### Intercepting external requests

Tests must never make live network calls to MTN, Airtel, or third-party payment gateway servers. Inject a custom `fetch` implementation into client constructors or use `startMockServer()` for local end-to-end tests.

### Running tests with coverage

```bash
npm run test:coverage
```
