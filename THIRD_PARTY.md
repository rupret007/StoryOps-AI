# StoryOps AI third-party software and reference register

**Reviewed:** 2026-07-30  
**Policy:** exact revisions/versions are authoritative; update this file,
lockfiles, container build arguments, notices, and verification evidence
together.

StoryOps AI contains original implementation plus permissively licensed
dependencies. Two repositories were inspected only for non-code domain or
operating patterns. Their code and text are not included.

This register is an engineering inventory, not legal advice. Before
distribution, an authorized reviewer must confirm that all license texts,
copyright notices, source offers (if any), trademarks, provider terms, model
terms, and container/system packages are handled for the actual distribution.

## Foundation and design inputs

| Project                                                                                                                                   | Exact pin                                                  | License at pin                                                            | StoryOps use and boundary                                                                                                                                                                                                                                                                                                                                                                |
| ----------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [marmelab/atomic-crm](https://github.com/marmelab/atomic-crm/tree/167a4cdb652b1ab2b4b030831cfa7adcf2099321)                               | `167a4cdb652b1ab2b4b030831cfa7adcf2099321`                 | MIT                                                                       | Architectural foundation for the React/Vite/Supabase/PWA/test/MCP structure and CRM interaction patterns. The upstream MIT notice is preserved verbatim in `LICENSE.atomic-crm.md`; `NOTICE.md` identifies the relationship.                                                                                                                                                             |
| [rupret007/StoryLand-Driving-School](https://github.com/rupret007/StoryLand-Driving-School/tree/32a67c4f6b3ad9b287b36b5e894c622b75c99976) | `32a67c4f6b3ad9b287b36b5e894c622b75c99976`                 | No top-level license was located at the inspected revision                | Read-only inspection of source-of-truth, current-status, briefing, cadence-runbook, incident, audit, and human-commitment patterns. StoryOps independently reimplements the concepts. **No StoryLand code or text was copied.** Do not copy content from this source without an explicit applicable license or permission.                                                               |
| [OCA/field-service](https://github.com/OCA/field-service/tree/ac20c102ef86676899adfd0e4075141a7bf3028d)                                   | `ac20c102ef86676899adfd0e4075141a7bf3028d` (19.0 snapshot) | AGPL-3.0-or-later project convention; repository license file is AGPL-3.0 | Domain checklist only: work orders, routes, crews, equipment, skills, materials, checklists, time, evidence, incidents, and field-service lifecycle. **No OCA source, schema, translation, asset, or text was copied or adapted.** StoryOps does not claim an AGPL adoption. Any future code adoption requires an explicit licensing decision and full compliance review before copying. |

The absence of a located StoryLand license is recorded conservatively; it is
not a claim about ownership, copyrightability, implied rights, or the
repository’s full history.

## Runtime services built from source

| Project                                                                                                                     | Version / exact pin                                    | License                                           | Packaging and boundary                                                                                                                                                                                                                                                                                                                                                                               |
| --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ | ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [VROOM-Project/vroom](https://github.com/VROOM-Project/vroom/tree/43dd7d0b8b560431eb555bf335cf4797eb7343c4)                 | `v1.15.0` / `43dd7d0b8b560431eb555bf335cf4797eb7343c4` | BSD-2-Clause, copyright © 2015–2025 Julien Coupey | `infra/vroom/Dockerfile` fetches the exact commit and builds the binary. GLPK is deliberately absent, so its GPL license is not introduced and plan-mode ETA validation is disabled.                                                                                                                                                                                                                 |
| [VROOM-Project/vroom-express](https://github.com/VROOM-Project/vroom-express/tree/5475901e60ec13ed9eec6cc87c811206a779eb03) | `v0.12.0` / `5475901e60ec13ed9eec6cc87c811206a779eb03` | BSD-2-Clause, copyright © 2016 Julien Coupey      | Exact source is copied into the optional routing image. `infra/vroom/runtime-package/package-lock.json` pins a compatible, audit-clean runtime graph because upstream v0.12.0 does not publish a lockfile. Its separately generated notice inventory is copied into the image alongside the upstream license; all provider-facing behavior remains covered by the pinned source and StoryOps limits. |

VROOM v1.15.0 records three header-only submodules at exact commits. They are
compiled into the binary and their notices are copied into the routing image:

| Component                                                                                                             | Exact pin                                  | License                                                   |
| --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ | --------------------------------------------------------- |
| [jarro2783/cxxopts](https://github.com/jarro2783/cxxopts/tree/eb787304d67ec22f7c3a184ee8b4c481d04357fd)               | `eb787304d67ec22f7c3a184ee8b4c481d04357fd` | MIT                                                       |
| [vahancho/polylineencoder](https://github.com/vahancho/polylineencoder/tree/01823158e6d2f227c2a001d6739d0a4bdbc60f26) | `01823158e6d2f227c2a001d6739d0a4bdbc60f26` | MIT                                                       |
| [Tencent/rapidjson](https://github.com/Tencent/rapidjson/tree/973dc9c06dcd3d035ebd039cfb9ea457721ec213)               | `973dc9c06dcd3d035ebd039cfb9ea457721ec213` | MIT/BSD notices; only the VROOM-used headers are compiled |

The routing image supports deterministic custom matrices without a routing
engine. Coordinate-based requests require a separately operated
OSRM/ORS/Valhalla endpoint and its own license, data, attribution, privacy,
capacity, and operational review. StoryOps does not bundle those services.

BSD-2-Clause redistribution conditions and disclaimers for both VROOM projects
are available at the pinned
[VROOM license](https://github.com/VROOM-Project/vroom/blob/43dd7d0b8b560431eb555bf335cf4797eb7343c4/LICENSE)
and
[vroom-express license](https://github.com/VROOM-Project/vroom-express/blob/5475901e60ec13ed9eec6cc87c811206a779eb03/LICENSE).
Binary/container distribution must reproduce the applicable copyright notice,
conditions, and disclaimer in its accompanying materials.

The VROOM runtime lock contains 83 exact package paths (81 unique
name/version pairs) and records a resolved artifact URL, integrity hash, and
declared license for every entry. Its generated distribution inventory is
`infra/vroom/runtime-package/NPM_THIRD_PARTY_NOTICES.txt`. It validates the
separately installed runtime graph and embeds all captured MIT, ISC, BSD, and
Python-2.0 notice material. `cookie-signature@1.0.6` places its complete MIT
notice in the shipped `Readme.md` rather than a dedicated license file; the
generator explicitly binds and embeds that exact lock-installed source instead
of substituting notice text from another version. The routing Docker image
copies this inventory to
`/usr/share/licenses/vroom-express-runtime/NPM_THIRD_PARTY_NOTICES.txt`.

## OpenAI agent runtime

| Project                                                                                                                                | Version / exact pin                                   | License    | StoryOps boundary                                                                                                                                                               |
| -------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [openai/openai-agents-js](https://github.com/openai/openai-agents-js/tree/5f54ddc1e1389a6e419c93056b2d46aaae998da4) / `@openai/agents` | `0.14.0` / `5f54ddc1e1389a6e419c93056b2d46aaae998da4` | MIT        | Server-only structured-model adapter, guardrail-aware tracing, and agent definitions. Provider side effects remain in StoryOps typed tools after deterministic policy/approval. |
| [openai/openai-node](https://github.com/openai/openai-node) / `openai`                                                                 | `6.46.0`                                              | Apache-2.0 | Direct OpenAI client dependency and Agents SDK peer; server only.                                                                                                               |

The software license does not grant model/API service access. Live use also
requires an OpenAI account, explicit server enablement, credentials, approved
model, current service terms/policies, privacy/security review, and usage
controls. No model or service is bundled.

## Direct runtime npm dependencies

`package.json` and lockfile use exact versions—no ranges. The lockfile integrity
hash is the install authority.

| Package                     | Version   | SPDX license | Purpose                                                                |
| --------------------------- | --------- | ------------ | ---------------------------------------------------------------------- |
| `@modelcontextprotocol/sdk` | `1.30.0`  | MIT          | MCP server contracts and transport                                     |
| `@openai/agents`            | `0.14.0`  | MIT          | Server-side agent adapter                                              |
| `@supabase/supabase-js`     | `2.110.9` | MIT          | Supabase server/client contract used by operations and Storage scripts |
| `decimal.js`                | `10.6.0`  | MIT          | Deterministic base-10 pricing                                          |
| `idb`                       | `8.0.3`   | ISC          | IndexedDB/PWA persistence                                              |
| `lucide-react`              | `1.27.0`  | ISC          | Interface icons                                                        |
| `openai`                    | `6.46.0`  | Apache-2.0   | OpenAI API client/Agents SDK peer                                      |
| `react`                     | `19.1.0`  | MIT          | UI runtime                                                             |
| `react-dom`                 | `19.1.0`  | MIT          | DOM renderer                                                           |
| `zod`                       | `4.4.3`   | MIT          | Runtime input/output schemas                                           |

The internal same-origin SPA router is original repository code; React Router
is not a current dependency.

## Direct development/build dependencies

| Package                       | Version    | SPDX license |
| ----------------------------- | ---------- | ------------ |
| `@eslint/js`                  | `10.0.1`   | MIT          |
| `@playwright/test`            | `1.62.0`   | Apache-2.0   |
| `@testing-library/jest-dom`   | `6.6.3`    | MIT          |
| `@testing-library/react`      | `16.3.2`   | MIT          |
| `@types/node`                 | `22.19.19` | MIT          |
| `@types/react`                | `19.1.8`   | MIT          |
| `@types/react-dom`            | `19.1.6`   | MIT          |
| `@vitejs/plugin-react`        | `6.0.4`    | MIT          |
| `eslint`                      | `10.8.0`   | MIT          |
| `eslint-plugin-react-hooks`   | `7.1.1`    | MIT          |
| `eslint-plugin-react-refresh` | `0.5.3`    | MIT          |
| `fake-indexeddb`              | `6.2.5`    | Apache-2.0   |
| `globals`                     | `16.3.0`   | MIT          |
| `jsdom`                       | `26.1.0`   | MIT          |
| `prettier`                    | `3.9.6`    | MIT          |
| `tsx`                         | `4.20.6`   | MIT          |
| `typescript`                  | `5.8.3`    | Apache-2.0   |
| `typescript-eslint`           | `8.65.0`   | MIT          |
| `vite`                        | `8.1.5`    | MIT          |
| `vite-plugin-pwa`             | `1.3.0`    | MIT          |
| `vitest`                      | `4.1.0`    | MIT          |

The application build image uses Alpine/musl. Hosted CI and local Linux
verification use Ubuntu/glibc (`ubuntu-24.04`) when a runner actually claims
the job. A hosted Actions job that finishes with empty `steps` and no
`runner_name` is unexecuted; classify it with `npm run check:hosted-ci` and
do not treat that red X as a test pass or a product-test failure. Root
`optionalDependencies`
therefore pin Rollup's published native packages for both libcs on the
supported architectures: `@rollup/rollup-linux-arm64-gnu@4.62.3`,
`@rollup/rollup-linux-arm64-musl@4.62.3`, `@rollup/rollup-linux-x64-gnu@4.62.3`,
and `@rollup/rollup-linux-x64-musl@4.62.3` (MIT). Pinning only the musl
artifacts lets npm skip the GNU binary on Ubuntu, and `vite-plugin-pwa`
then fails looking for `@rollup/rollup-linux-x64-gnu`. Their exact registry
artifact URLs and integrity hashes are in `package-lock.json` and
`NPM_THIRD_PARTY_NOTICES.txt`. They are build inputs only; the final static
runtime image does not copy `node_modules`.

The lockfile forces transitive `ejs` to `5.0.2` (Apache-2.0) to use the
audited/remediated build graph. Override changes require a clean install,
audit, lint, typecheck, test, and build.

## Other pinned tooling and base images

| Item                         | Pin                                                                       | Use                                             |
| ---------------------------- | ------------------------------------------------------------------------- | ----------------------------------------------- |
| Node.js                      | `22.22.3` / `.nvmrc`                                                      | Local, build, and runtime JavaScript engine     |
| Supabase CLI                 | `2.110.0`                                                                 | Local stack, migration/reset/lint, logical dump |
| `node:22.22.3-alpine3.22`    | `sha256:cd7807368cf24826297cbad5dca1a44972ccfd770647db52a8c7589eb4599ac8` | Application build/runtime base                  |
| `node:22.22.3-bookworm-slim` | `sha256:e21fc383b50d5347dc7a9f1cae45b8f4e2f0d39f7ade28e4eef7d2934522b752` | Node runtime copied into the VROOM image        |
| `ubuntu:24.04`               | `sha256:4fbb8e6a8395de5a7550b33509421a2bafbc0aab6c06ba2cef9ebffbc7092d90` | VROOM C++20 build and minimal runtime base      |

Dockerfiles retain the human-readable tags and bind each base to the reviewed
registry digest above. The VROOM image still resolves unversioned Ubuntu apt
packages from the image's configured repositories during its build; no
reviewed snapshot repository is currently pinned. A release build must record
the resulting OS package manifest, scan it, preserve base/OS notices, and treat
any changed apt resolution as a new artifact requiring review.

GitHub Actions in `.github/workflows/ci.yml` are pinned to full commit SHAs with
their major-version names in comments.

## Transitive dependency inventory

`package-lock.json` currently records 683 exact-version package entries with
dependency edges and declared license metadata. npm omits resolved artifact
URLs and integrity hashes from some registry entries in this lockfile; the
generated report preserves values where present and labels every omitted value
`UNKNOWN`. The tables above list direct and specifically controlled components,
not every transitive package.

`NPM_THIRD_PARTY_NOTICES.txt` and the separate VROOM runtime inventory are the
committed, generated distribution inventories. They list every locked package
path and exact version, preserve artifact/integrity references when the
lockfile supplies them, validate non-optional installed package metadata
against the applicable lockfile, clearly label any `UNKNOWN` metadata, and
embed the actual captured license/notice material found in each installed
graph. Platform-specific optional build binaries are listed from the root
lockfile but their text is not guessed from other packages. The generator is
`scripts/generate-npm-notices.mjs`; `npm run verify` fails when either committed
artifact is stale.

Reproduce and verify the inventory after a clean install:

```bash
npm ci --ignore-scripts
npm run install:vroom-runtime
npm run licenses:check
npm ls --all
npm audit
npm audit --prefix infra/vroom/runtime-package --audit-level=high
```

When either lockfile changes, install both exact graphs, run
`npm run licenses:generate`, review the diff, and commit both regenerated
artifacts. Archive the applicable inventory with each release. It is license
evidence, not a legal conclusion: review packages that expose
multiple/alternative licenses, assets under Creative Commons, native binaries,
or embedded data rather than relying only on a declared license field.

## External services and data

OpenAI, Twilio, email/SMTP, Stripe, Google Calendar/Maps, NWS, Supabase,
QuickBooks, routing engines, map/road data, and deployment/observability
providers are external services or data sources, not included software. Their
current terms, API policies, branding/attribution, data-processing/privacy,
consent, retention, security, rate-limit, billing, and geographic requirements
must be reviewed before activation.

NWS public data access still requires an identifying `User-Agent` with monitored
contact information and respectful request behavior. Google/OSM-derived maps or
routes may have display/attribution and data-license obligations independent of
the adapter code.

## Notice-preservation rules

- Keep `LICENSE.atomic-crm.md`, `NOTICE.md`, `THIRD_PARTY.md`, and
  `NPM_THIRD_PARTY_NOTICES.txt` in source and release artifacts. The application
  Docker image copies all four to `/usr/share/licenses/storyops-ai/`.
- Keep dependency license files with installed/vendored packages; reproduce
  required notices in binary/container distributions.
- Keep VROOM and vroom-express license texts plus
  `infra/vroom/runtime-package/NPM_THIRD_PARTY_NOTICES.txt` inside or alongside
  the routing image.
- Do not remove upstream copyright/license headers.
- Do not copy StoryLand or OCA content under the current no-code boundaries.
- Any new vendored source, font, icon set, image, SDS, map data, template, or
  generated asset needs provenance, exact version, applicable license, and
  redistribution review here.
