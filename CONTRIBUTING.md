# Contributing

Install [Bun 1.3.14 or newer](https://bun.sh), then clone the repository:

```sh
git clone https://github.com/malhashemi/workflow-observer.git
cd workflow-observer
bun install --frozen-lockfile
bun run dev
```

`dev` serves the app against your configured Claude profiles. For synthetic data in an isolated temporary profile, run `bun run demo` instead. It uses port 4329 and removes its temporary files when you stop it with Ctrl+C.

Before opening a PR:

```sh
bun run build
bun run check
bun test
bun run test:package
```

Use `bun run format` to apply OXC formatting. Keep tests focused on observable behavior, especially source deletion, incremental reads, response ordering and accounting. Fixtures must use synthetic evidence; do not commit transcripts, personal configuration, tokens or session exports.

Workflow templates can contain arbitrary JavaScript. Planned metadata analysis must remain inert and bounded. Preserve exact recorded identities and distinguish a missing model or price from a zero value. Effect owns the existing lifecycle and settings boundaries; OXC owns linting and formatting.

Describe the problem, the resulting behavior and relevant validation in your PR. For UI changes, include screenshots with synthetic data. For releases, follow [the release guide](docs/releasing.md).
