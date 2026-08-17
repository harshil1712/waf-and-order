# Contributing

Thanks for your interest in contributing to WAF and Order.

## Prerequisites

- Node.js 22 (see `.nvmrc`; `nvm use` will select it)
- npm

## Getting started

```sh
npm ci
npm run check
npm test
```

- `npm run check` type-checks and builds the project.
- `npm test` runs the Vitest suite.

Before opening a pull request, make sure both pass locally. Keep changes
focused, and open an issue first for anything non-trivial so the direction is
agreed before the work starts.