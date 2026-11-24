# Contributing

Contributions to **JS MoMo SDK** are welcome.

## Development setup

```bash
git clone https://github.com/wkambale/jsmomo.git
cd jsmomo
npm ci
```

## Verification suite

Run formatting, linting, strict TypeScript typechecking, Vitest with the 90% coverage gate, and dual ESM/CJS/DTS/CLI builds in one command:

```bash
npm run format
npm run verify
```

## Building the documentation locally

```bash
pip install -r docs/requirements.txt
mkdocs serve
```

Before opening a pull request, verify strict documentation compilation:

```bash
mkdocs build --strict
```

## Testing guidelines

- Never make live HTTP calls to MTN, Airtel, or third-party payment gateways in unit or integration tests.
- Inject a custom `fetch` handler into client constructors or use `startMockServer()` for local end-to-end coverage.
- Maintain at least **90%** line and statement coverage across `src/`.
