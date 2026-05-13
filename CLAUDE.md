# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## SGC Fork Context

This is the SGC fork of [Owncast](https://owncast.online), used to build and release hardened Owncast containers with better security defaults. It is paired with:

- **Ansible role**: `~/sgc/ansible/roles/okast-ar/` — deploys this image as a systemd-wrapped Docker container.
- **Parent playbook**: `~/sgc/SGC/` — orchestrates okast alongside other MASH services.

### 3-Branch Strategy (per project)

| Branch | Role |
|---|---|
| `main` | Mirror of the upstream fork. Synced from upstream; never edited directly. |
| `sgc-dev` | Development & security-testing branch. All upstream changes land here first via cherry-pick for review. |
| `sgc` | Production primary. Tagged releases are cut from here and consumed by `okast-ar`. |

Flow: upstream → `main` → cherry-pick → `sgc-dev` → security test → merge → `sgc` → tag → image release.

The Go module path in `go.mod` is `github.com/owncast/owncast` (not the fork's GitHub path). The Dockerfile's `-ldflags -X ...config.VersionNumber=...` must reference that module path or the version injection is silently dropped and the image reports the hardcoded `StaticVersionNumber` instead. Fork commit `3b27c9abb7` got this wrong (used `github.com/P3X-118/owncast/...`) and was reverted.

## Architecture

Owncast is a single binary that bundles:

- **Go backend** (repo root) — RTMP ingest, HLS transcoder, chat, ActivityPub federation, web server, admin/public APIs.
- **Next.js/React frontend** (`web/`) — public viewer page and `/admin` UI. Built output is bundled into `static/web/` and served by the Go binary in production.

### Backend layout

- `main.go` — flag parsing, bootstraps `core.Start()` and `router.Start()`.
- `core/` — runtime: `rtmp/` ingest, `transcoder/` (ffmpeg HLS), `chat/`, `playlist/`, `storage*`, `webhooks/`. Uses package-level globals (`_stats`, `_storage`, `_transcoder`, etc.).
- `webserver/` — HTTP routing and handlers. Public + admin APIs live under `webserver/handlers/`; generated OpenAPI stubs land in `webserver/handlers/generated/`.
- `persistence/` — repository layer over SQLite (one package per domain: `configrepository`, `userrepository`, `chatmessagerepository`, etc.). `tables/` owns schema bootstrap.
- `db/` — sqlc-generated typed query layer. Hand-written SQL in `db/query.sql` + `db/schema.sql`; do not edit `db/query.sql.go` or `db/models.go` (regenerated).
- `activitypub/`, `auth/`, `services/{geoip,notifications}/`, `yp/` (Owncast directory) — feature subsystems.
- `models/` — shared types crossing package boundaries.

### Code generation

Two generators feed the build; commit the generated output:

1. **sqlc** (`sqlc.yaml`) — `make sqlc` regenerates `db/query.sql.go` + `db/models.go` from `db/schema.sql` and `db/query.sql`.
2. **oapi-codegen** — `make api-generate` (or `./build/gen-api.sh`) lints `openapi.yaml` with redocly, then regenerates `webserver/handlers/generated/`. New endpoints: edit `openapi.yaml` first, regenerate, then implement.

Tooling versions are pinned in `tools/go.mod` and installed into `./bin/` (kept out of the runtime go.mod). Use `make install-tools` to fetch them.

### Frontend

Next.js 14 + Ant Design + Sass. Components are developed in Storybook. The build output is checked in under `static/web/` for releases (do **not** commit during day-to-day work — see "Web bundling" below).

## Common Commands

### Backend (run from repo root)

```bash
make install-tools         # populate ./bin/ with lefthook, golangci-lint, gofumpt, sqlc, oapi-codegen
make install-hooks         # install lefthook git hooks (uses ./bin/lefthook)
make build                 # go build -o owncast .
make test                  # go test ./...
make lint                  # ./bin/golangci-lint run ./...
make fmt                   # ./bin/gofumpt -l -w .
make sqlc                  # regenerate db/ from SQL
make api-generate          # regenerate webserver/handlers/generated/

go test ./core/chat/...    # run a single package's tests
go test -run TestName ./pkg # run a single test
go run main.go             # run dev backend on :8080 (admin: admin / abc123)
```

### Frontend (run from `web/`)

```bash
npm install --include=dev
npm run dev          # next dev on :3000 — talks to backend on :8080
npm run build        # production build
npm run lint         # eslint + stylelint
npm test             # jest
npm run storybook    # component playground on :6006
```

For local UI work: run `go run main.go` (backend on :8080) **and** `npm run dev` (frontend on :3000). Develop against `http://localhost:3000`, not :8080. Do not run `bundleWeb.sh` or commit `static/web/` for local iteration.

### Web bundling (release only)

`build/web/bundleWeb.sh` builds `web/` and copies the output into `static/web/` so the Go binary serves it. This is what produces the embedded admin in releases. The recent commit `ad82448b6e Bundle embedded web app` is an example. Only bundle when cutting a release.

### Container builds

- `Dockerfile` — convenience build (Alpine + ffmpeg, static Go binary, runs as uid 101). Used for the SGC fork's image releases.
- `Earthfile` — upstream's official multi-platform build recipes. Reference, not used by SGC release pipeline.

### Integration tests

`test/automated/api/` is a Jest-based suite that boots a real `owncast` binary and a fake stream, then hits the HTTP API. Run via `test/automated/api/run.sh` (installs ffmpeg, starts owncast, runs `npm test`). Add API tests here for new endpoints. `test/automated/browser/` holds Playwright-style UI tests.

## Conventions

- **Don't commit `static/web/`** during feature work; it is generated and only refreshed for releases.
- **No emoji** in code comments or commit messages (upstream policy, carried in copilot-instructions.md).
- **Localization**: all user-facing strings go through the `Translation` component or `t()` from `next-export-i18n`. Test with `?lang=de` etc.
- **OpenAPI-first**: new HTTP endpoints start in `openapi.yaml`, then `make api-generate`, then implement against the generated stub.
- **Conventional Commits** are validated by `commit-msg` lefthook if `commitlint` is installed globally.
- Lefthook runs `gofumpt`, `golangci-lint`, `go test`, `eslint`, `prettier`, `stylelint`, and `knip` on commit; `npm run build` (web) on push.
