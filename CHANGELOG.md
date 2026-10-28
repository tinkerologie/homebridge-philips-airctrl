# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Releases are driven by the `version` field in `package.json`: bump it on `main` and
push, and `.github/workflows/release.yml` tags the commit, creates the GitHub release
using the matching section below, and publishes to npm. A release will **fail** if
this file has no `## [x.y.z]` section for the version being released.

## [Unreleased]

### Added

- Executable formatting and V8 coverage checks, with coverage floors measured against the unchanged 0.2.0 source.

### Changed

- Pull requests get path labels and at most one type label, `bug` or `enhancement`, from the shared tinkerologie PR labeler. Dependabot pull requests whose largest update is a patch or minor version merge automatically once the checks and commit statuses on their head commit have finished without a failure (a Codecov check that is still pending is not waited for; a Codecov failure blocks); majors, and pull requests with open review threads, stay for review.
- Releases are split into two jobs. A read-only Package job installs dependencies, runs lint, the build and the tests, and packs the tarball; a separate Publish job, the only one with write access and an npm OIDC identity, publishes that tarball with lifecycle scripts disabled and creates the GitHub release. Dependency install scripts and the project's own build and test code therefore never run with publishing credentials, and the Publish job installs nothing (it checks that Node 24's bundled npm supports trusted publishing instead of upgrading npm). The Publish job checks npm again before publishing: a re-run after a partial failure skips the publish when npm already has that run's exact tarball and still creates the release; publishing runs one at a time, so a racing run that finds a different package on npm fails instead of publishing twice; and the tarball is kept for 7 days for such re-runs. A version that was tagged but never reached npm is no longer silently skipped: re-running the workflow run of the tagged commit publishes it (so npm provenance names the commit that built it), and a run of any other commit fails with those instructions. npm lookups fail on registry errors instead of treating them as "not published", and when a re-run or racing run finds the version already on npm at publish time, it is accepted only if npm holds that run's exact tarball.
- Dependabot no longer opens TypeScript, Homebridge or `@types/node` major updates (typescript-eslint supports TypeScript below 6.1 only; Homebridge v2 is the supported runtime). `@types/node` now tracks Node 22, the oldest supported runtime, so the compiler rejects APIs Node 22 does not have.
- Release workflows hardened (least-privilege job permissions, no expressions in shell scripts, no persisted checkout credentials, no dependency caches); scheduled workflows run on Australia/Brisbane time. Relicensed from MIT to the Apache License 2.0; NOTICE retains the MIT notice for earlier releases.
- Workflow layout tidied after the release hardening (no behaviour change): `permissions:` blocks moved back to the top of their workflow or job in `release.yml`; the comment explaining the npm upgrade before publishing is restored.
- Tinkerologie-Bot governance report updated to v1.4.3: an older run can no longer post a stale report after a newer run passed. Workflow formatting tidied.
- Repository standardised to the tinkerologie layout (STANDARDS.md in tinkerologie/.github): workflows renamed to the standard set (CI, Validate, Release, PR Governance, ...), every action pinned to a commit SHA, shared Dependabot, `.editorconfig`, `.gitattributes` and `CODEOWNERS` files, and organization-wide labels and community files.
- Tinkerologie-Bot's comment is now a readable "Pull request checklist": each problem is a numbered heading with plain-English guidance and its items listed underneath, and report updates for a pull request are serialised so an older run can never overwrite a newer one.
- Contribution governance: issues without a `bug` or `enhancement` label are labeled automatically when their type can be determined (issues labeled `question`, `duplicate`, `invalid`, `wontfix`, or `no-type` are skipped), so CodeRabbit can plan them. Pull requests that conflict with the default branch are labeled, and their authors are notified in a comment. Stale issues and pull requests are labeled after 14 days without activity and closed 30 days later. PR governance now re-validates a human-authored, non-draft PR when a bot such as CodeRabbit edits its description, instead of skipping the check and reporting a pass, only maintainers with write access may use `None` instead of linking an issue, and a link to an issue that does not exist now fails the check.
- Tinkerologie-Bot now posts one comment on pull requests that fail PR governance, listing every problem to fix, and updates it once they are fixed. PR governance runs from the default branch's workflow (`pull_request_target`), so a pull request cannot change its own check.
- Update repository URLs and documentation references to tinkerologie organization.

### Fixed

- Renew status observations before Philips devices expire them, preserving fresh HomeKit state without repeated 180-second reconnects.

- Reject invalid UDP ports above 65535 and handle custom UI spinner failures without unhandled rejections.

## [0.2.1] - 2026-10-28

### Fixed

- Renew long-lived CoAP Observe subscriptions at each registration's Max-Age, using a new token on the same socket and encryption session. Establish the replacement before cancelling the previous token, and retain the 180-second watchdog for genuinely stale telemetry.
- Use one long-lived status registration during startup and reconnect, avoiding the temporary registration and its immediate replacement that contributed to Observe timeouts.
- Refresh the watchdog for unchanged renewal snapshots without duplicate HomeKit updates. Preserve quiet-device bootstrap behavior and the CX3550 ten-minute reachability check, without treating reachability as fresh telemetry.
- Cancel pending registrations, timers and retired tokens on errors, reset, iterator return and shutdown. Contain reconnect cleanup errors and prevent overlapping reconnects.
- Reject UDP ports outside 1–65535 and handle custom UI spinner failures without unhandled rejections.
- Keep deployment passwords out of process arguments and require known SSH host keys.
- Include NOTICE in the npm package and correct the README's licence and display-light defaults.

### Added

- Reproducible formatting and V8 coverage checks, with local baseline coverage floors and Codecov CI gates.
- Homebridge's `supports-hap` package keyword and a sourced 2026 development audit, including isolated TypeScript 7 compatibility checks.

### Changed

- Constrain TypeScript to 6.0.x to retain compatibility with the current ESLint compiler API requirements.

## [0.2.0] - 2026-10-08

### Added

- HomeKit support for the Philips CX3550/01 fan using a native
  Fan service, with power, three manual speeds, and oscillation.
- Opt-in Sleep and Natural Breeze switches. Turning either mode off returns the
  fan to its previous manual speed.

### Notes

Behaviour confirmed against a CX3550/01 that differs from what the published
device registries describe:

- Fan speed is selected through `D0310C`; `D0310D` is treated as reported state
  rather than written as part of a speed change.
- Oscillation is enabled by writing `17242`, while enabled status can report a
  different non-zero value. Any non-zero reported value is therefore treated as
  enabled.
- The fan may establish a status observation without immediately publishing an
  initial snapshot. The plugin uses a bounded bootstrap mechanism to obtain that
  state when required.
- Long periods without status updates are normal for this fan. Rather than treating
  silence itself as a failure, the plugin refreshes the existing observation and
  probes device reachability after a model-specific quiet interval, escalating to
  observation re-registration and reconnect only when recovery checks fail. Normal
  status updates remain event-driven rather than polled.
- Malformed same-token Observe packets that are not encrypted status payloads
  are ignored instead of terminating an otherwise healthy observation.

## [0.1.0] - 2026-07-31

First release.

### Added

- HomeKit support for Philips air purifiers over the local, encrypted CoAP API.
  The CoAP stack, the AES-128-CBC encryption and the device registry are all
  implemented in TypeScript in this plugin — **no Python, no cloud service, and no
  third-party CoAP dependency**, so installation is a plain `npm install` with no
  install scripts.
- Air Purifier service with power, fan speed and Auto/Manual, plus Air Quality
  (from PM2.5), Temperature, Humidity, and Pre-filter / NanoProtect filter life.
- Opt-in Display light, Sleep, Auto+ AI and Beep controls.
- A custom configuration UI that scans the local network on open and adds a
  discovered purifier in one click. Nothing needs to be typed into a JSON file.
- Automatic reconnection with backoff. The device API uses non-confirmable CoAP,
  which has no retransmission, so a single dropped datagram is normal and must not
  strand a device — a purifier that misses its first response is retried rather
  than dropped until Homebridge restarts.
- Support for 62 models across the Gen1, Gen2 and Gen3 device APIs.

### Notes

Behaviour confirmed against an AC4220/12 that differs from what the published
device registries describe:

- `D03105` is a **read-only** status mirror — writes are acknowledged and silently
  discarded. The writable display-light control is `D03135`. Models with no known
  writable light key therefore expose no Lightbulb rather than one that appears to
  work and does nothing.
- Beep is a boolean stored as **0 / 100**, not 0 / 1.
- Speed 5 is Turbo, not a distinct mode, so no separate Turbo switch is exposed.
