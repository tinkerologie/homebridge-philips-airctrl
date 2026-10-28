# Homebridge development audit research — 28 October 2026

Research uses primary sources, the current npm registry, and Context7. Research was completed before implementation. All linked sources were accessed on 28 October 2026. Package versions and documentation are current observations, not guarantees of future compatibility.

## Current Homebridge requirements

Homebridge latest is **2.4.0** (npm and upstream package manifest agree). Its Node engines are `^22 || ^24 || ^26`. Homebridge 2.0 removed Node 18/20 support and moved its package to ESM. Plugins should import HAP types through the public `homebridge` exports; direct old `hap-nodejs` dependencies and `homebridge/lib/...` imports require migration. Removed APIs include reachability methods, `getServiceByUUIDAndSubType`, old camera publication, and module-level logger helpers. Sources: [Homebridge package](https://github.com/homebridge/homebridge/blob/latest/package.json), [2.0 release](https://github.com/homebridge/homebridge/releases/tag/v2.0.0), [migration guide](https://github.com/homebridge/homebridge/wiki/Updating-To-Homebridge-v2.0).

The official development site now recommends declaring the `supports-hap` keyword for plugins publishing HomeKit accessories; this plugin is HAP-only. Omitting transport keywords preserves existing behavior, so this is recommended metadata rather than a current runtime defect. Source: [developer documentation](https://developers.homebridge.io/).

Node 26's scheduled LTS date is **28 October 2026**, today. Upstream Homebridge accepts it, but the verification README and plugin template still list Node 22/24. Broaden this plugin's Node range only after running its actual build, tests and lint on Node 26; do not claim hardware validation on an untested runtime. Sources: [Node release schedule](https://github.com/nodejs/Release/blob/main/schedule.json), [Homebridge manifest](https://github.com/homebridge/homebridge/blob/latest/package.json), [plugin template manifest](https://github.com/homebridge/homebridge-plugin-template/blob/latest/package.json).

The current verification criteria require a dynamic platform, settings GUI, supported LTS runtimes, configuration before starting, no system-changing installation scripts, no analytics, storage inside Homebridge's storage directory when needed, caught/logged errors, npm publication and GitHub releases with notes. These are criteria to aim for, not proof of Homebridge verification. Source: [official plugin verification README](https://github.com/homebridge/plugins).

The official template recommends caching stable UUIDs, restoring rather than registering duplicate accessories, registering after `didFinishLaunching`, fast GET handlers backed by cached state, asynchronous characteristic updates, and `HapStatusError(SERVICE_COMMUNICATION_FAILURE)` for unreachable devices. Sources: [platform template](https://github.com/homebridge/homebridge-plugin-template/blob/latest/src/platform.ts), [accessory template](https://github.com/homebridge/homebridge-plugin-template/blob/latest/src/platformAccessory.ts).

## TypeScript 7 answer

**TypeScript 7 can compile a Homebridge plugin, but Homebridge consumes the emitted JavaScript and does not itself promise support for every compiler/tool combination.** Microsoft released stable TypeScript 7 on 8 July 2026. The npm registry currently reports stable **7.0.2** and beta **7.1.0-beta**. Homebridge's own current source and official plugin template still use TypeScript **6.0.3**, so there is no basis to claim official Homebridge TS7 certification. Sources: [Microsoft announcement](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/), [Homebridge manifest](https://github.com/homebridge/homebridge/blob/latest/package.json), [template manifest](https://github.com/homebridge/homebridge-plugin-template/blob/latest/package.json).

TS7 is a native compiler without TS6's programmatic API. This matters to this repository's ESLint parser: `@typescript-eslint/parser` currently declares TypeScript `>=4.8.4 <6.1.0`, also confirmed in its official dependency support page. Simply replacing `typescript` with 7 would break the supported lint toolchain. Microsoft documents side-by-side dependencies, keeping TS6 at the `typescript` import name for API consumers and providing native TS7 under an alias. Example: `"@typescript/native": "npm:typescript@^7.0.2"` plus `"typescript": "npm:@typescript/typescript6@^6.0.2"`. Native TS7 provides `tsc`; TS6 provides `tsc6` and the compiler API. Any adoption still needs full local/CI validation of Vitest, eslint and declarations. The user requested a compatibility check, so retaining the existing supported TS6 compiler is also a valid conservative outcome with this explanation. Sources: [Microsoft side-by-side guidance](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/#running-side-by-side-with-typescript-6-0), [typescript-eslint support](https://typescript-eslint.io/users/dependency-versions).

## Repository source audit observations

Observed checkout begins at version **0.2.0**, Homebridge dev dependency `^2.2.1`, Node `^22.12.0 || ^24.0.0`, TypeScript `^6.0.3`, ESLint 10, Vitest 5. The plugin already uses ESM with `.js` relative imports, public Homebridge types and injected `api.hap`, `DynamicPlatformPlugin`, modern `onGet`/`onSet`, `Fanv2`, `AirPurifier`, `Service.setPrimaryService`, stable device IDs, cache restoration, and shutdown cleanup. No deprecated API references were found in a TypeScript symbol/JSDoc audit against the installed dependency declarations: `TypeScript symbol deprecation audit: 0 deprecated references in src/`. This is source/static evidence, not a claim that every firmware/runtime behavior is correct.

Concrete gaps to address within the approved CodeRabbit issue plan:

- Add `supports-hap` package metadata and cover metadata in a meaningful package/scaffold check.
- Investigate repeated 180-second unavailable/reconnect transitions. `DeviceCoordinator.armWatchdog()` immediately marks ordinary models offline after `3 * Max-Age`; only the special quiet-device profile probes reachability first. Logs alone do not prove the device is actually offline.
- Preserve fast cached GET behavior, bounded writes, listener isolation, unavailable errors, and shutdown cancellation when fixing watchdog/Observe behavior.
- Add the missing `test:coverage` command and coverage provider/report/upload/Codecov checks requested by repository governance and the user. Existing CI only runs lint, tests and build on Node 22/24.
- Add a reproducible formatting check if enforcing repository instruction to run format checks; no format script/tool is currently declared. Match existing style and avoid unrelated whole-repo churn.
- Correct README's MIT license statement; both package metadata and the actual LICENSE identify Apache-2.0.
- Bump next patch release from 0.2.0 to 0.2.1 if scope remains compatibility/bug fixes; retain Unreleased changelog entries per governance and include release-specific notes as required by release automation.
- Consider testing latest supported Homebridge 2.4 and Node 26 before changing the declared support matrix. Do not add Homebridge 1 support merely because the template lists it; this plugin deliberately declares Homebridge 2 only.

## CoAP protocol context

CoAP Observe is best-effort and its representation freshness model differs from direct proof of device liveness. RFC 7641 section 3.3 describes using Max-Age and re-registration to obtain a fresh representation. A safe repair should distinguish stale telemetry from failed transport/reachability, and must not claim sensor freshness solely from an unrelated info response. Firmware-specific behavior still requires the repository regression loop and real-device validation. Source: [RFC 7641](https://www.rfc-editor.org/rfc/rfc7641#section-3.3).

## Commands used for current package evidence

Read-only registry queries: `npm view typescript dist-tags --json`, `npm view typescript@7 version --json`, `npm view homebridge version engines --json`, `npm view @typescript-eslint/parser peerDependencies --json`.

Context7 resolved `/homebridge/homebridge` and returned migration, lifecycle and loader details. Direct upstream source and release pages were preferred when indexed wiki content disagreed or lagged.

## Follow-up: Python and Home Assistant reference comparison

Both reference checkouts were clean before and after investigation. `git fetch origin` confirmed the current remote default-branch commits below; no source files were modified.

### Python library: direct root-cause evidence

Repository `/Users/ruaandeysel/Github/ha-philips-airpurifier/philips-airctrl`, current `origin/main` **eff59512f6a163dff6031d4128d5124c35cc97f9** (PR #35, issue #34, released v1.4.0) merged 28 October 2026. Its commit explicitly identifies the same symptom: Observe registered once, device stops notifications after roughly 2.5 minutes, watchdog reconnect at 180 seconds, device still answers new requests. Recorded historical live evidence in this commit: AC4220 firmware 0.2.3, 270-second run, 106 pushes, four renewals at approximately 64/124/185/245 seconds, pushes continued through 269.6 seconds. This is upstream recorded evidence, not a live test performed by this audit.

- `src/philips_airctrl/coap/client.py:163-176`: sanitize Max-Age; missing/noninteger/nonpositive values fall back to 60.
- `client.py:194-216`: register Observe on existing context/encryption session, cancel pending registration on initial response failure/timeout/cancellation.
- `client.py:218-280`: renew every Max-Age from latest registration response; keep a fixed renewal deadline so ongoing pushes do not postpone renewal; open a new token without `_sync()`; await its first response within 10 seconds, then cancel old observation; suppress unchanged renewal snapshot; propagate real transport errors; cancel active observation on generator exit.
- `client.py:178-186`: cancellation is guarded against aiocoap's double-cancel assertion. The exact assertion is Python-specific, but idempotent cleanup is portable.
- `tests/test_client.py:665-850`: regression cases cover same-session renewal, changed and identical snapshots, Max-Age defaults, failed/timed-out renewal, transport TimeoutError versus renewal deadline, early break, decryption failure, ended stream, and cancelled registrations.

Sources: [merged change](https://github.com/tinkerologie/philips-airctrl/commit/eff59512f6a163dff6031d4128d5124c35cc97f9), [client source](https://github.com/tinkerologie/philips-airctrl/blob/eff59512f6a163dff6031d4128d5124c35cc97f9/src/philips_airctrl/coap/client.py#L218), [tests](https://github.com/tinkerologie/philips-airctrl/blob/eff59512f6a163dff6031d4128d5124c35cc97f9/tests/test_client.py#L665).

### Home Assistant: lifecycle hardening and push-only nuances

Repository `/Users/ruaandeysel/Github/ha-philips-airpurifier/ha-philips-airpurifier`, current `origin/main` **e1a173f** (release 2026.10.3); manifest pins `philips-airctrl==1.4.0`. Prior change **e7ea6f118d8bc05e86b4135db6d1c3c44ff60a59** (PR #176, issue #172) adds lifecycle diagnostics and reconnect hygiene.

- `custom_components/philips_airpurifier/coordinator.py:344-384`: replace/retire observer with a generation counter, cancel and bounded-wait before closing its client.
- `coordinator.py:395-438`: first-push diagnostic and push counters; intentional cancellation and retired observers must not trigger reconnect.
- `coordinator.py:440-473`: watchdog measured from last push, includes elapsed time/session push count. This is recovery evidence, not a replacement for library renewal.
- `coordinator.py:475-505` and `527-600`: reconnect duplicate guard plus ceiling for wedged reconnects; bounded create/status/shutdown; release a replacement whose status read failed; exponential backoff; shutdown race safety; report failed stage and exception type, attempt count, outage duration.
- `coordinator.py:251-293`: push-only nudge restores last genuinely observed setting rather than overwriting with a hardcoded default; strip presentation-only `#N` suffix from wire keys.
- `client.py:154-220`: nudge and observation must share one client because some firmware evicts previous clients; wait for registration, bound retries, clean up. This is firmware-specific and must not become general polling.
- `tests/test_coordinator.py:1182-1246`: no work after shutdown, intentional cancellation cannot reconnect, cancellation-resistant tasks, replacement arriving after shutdown.
- `tests/test_coordinator.py:1258-1604`: reconnect failure stages, attempts, stop-before-close ordering, retired observer handling, push diagnostics and exact watchdog timing.

Sources: [lifecycle commit](https://github.com/tinkerologie/ha-philips-airpurifier/commit/e7ea6f118d8bc05e86b4135db6d1c3c44ff60a59), [coordinator](https://github.com/tinkerologie/ha-philips-airpurifier/blob/e1a173f/custom_components/philips_airpurifier/coordinator.py), [client helpers](https://github.com/tinkerologie/ha-philips-airpurifier/blob/e1a173f/custom_components/philips_airpurifier/client.py).

### Focused Homebridge recommendations

1. Port renewal into `PhilipsCoapClient.observe()` for ordinary devices. Its current long-lived observation has no renewal timer (`src/airctrl/client.ts:132-195`), matching the Python pre-fix defect. The existing `refreshObservations()` only resends the same token on demand, and is used only by quiet-profile liveness recovery; it is not the validated Python new-token renewal.
2. Use the same encryption session/socket, renewal deadline derived from registration Max-Age, bounded new registration, then old cancellation. Avoid reconnect/sync and availability flicker on healthy renewal. Ensure queued new notifications and a renewed initial snapshot cannot be lost while switching.
3. Keep quiet/push-only quirks explicitly model-gated. Requiring an initial renewed response every minute would break models that deliberately never provide one; do not blindly apply the ordinary-device algorithm to the CX3550 quiet profile.
4. Treat renewed actual status as watchdog freshness even when its values are unchanged. Suppressing duplicate external HomeKit updates is fine; suppressing heartbeat evidence would reintroduce 180-second false outages on stable readings. The current coordinator deduplicates after arming its watchdog, so preserve that ordering or provide an equivalent freshness signal.
5. Regression harness should expire firmware subscriptions unless renewed, run longer than 180 simulated seconds, prove no unavailable/reconnected logs, prove repeated renewals without extra sync/client creation, and still fail closed for genuine renewal timeout/network failure.
6. Cover cancellation/shutdown during an in-flight replacement, timer cleanup, max-age zero/missing values, frequent pushes that must not defer renewal, and failed renewal preserving the original transport error.

## Local compiler verification

An isolated TypeScript 7.0.2 invocation successfully built this plugin with NodeNext ESM and declaration emission, and typechecked `tsconfig.test.json`. Importing the emitted JavaScript and invoking its entry point registered `PhilipsAirPurifier` successfully. The project dependency remains `typescript ~6.0.3` because its ESLint API consumer requires TypeScript below 6.1. This verifies compilation and registration, not an official Homebridge compiler certification or a production TS7 deployment.

## Baseline and audit decisions

Clean installation of the latest remote main passed build, lint/typecheck and 257 tests. A TypeScript symbol/JSDoc scan found zero deprecated symbol references in production source. Baseline V8 coverage was 93.64% statements, 88.31% branches, 95.81% functions and 96.41% lines; these are the minimum local coverage thresholds. The formatter and transport cleanup tests are in a separate initial commit.

The live AC4220/12 was running plugin 0.2.0, Homebridge 2.4.0 and Node 24.22.1. Its current logs reproduced the recurring 180-second unavailable/reconnected cycle and initial Observe timeout. No malformed-payload errors from issue #45 were present in that evidence, so malformed-payload policy remains unchanged.

Runtime Node support remains 22.12+ and 24. Development on Node 22 needs 22.13+ because of [ESLint's engine requirement](https://github.com/eslint/eslint/blob/main/package.json); [Vitest 5](https://github.com/vitest-dev/vitest/blob/main/packages/vitest/package.json) supports Node 22.12+, 24 and 26. Homebridge accepts Node 26 upstream, but expanding the declared runtime matrix is deferred in this patch.

The custom UI validates request boundaries separately from configuration parsing. The UI only manages discovered/manual device additions, removals and feature switches; names, model overrides and ports remain accessible through Homebridge's JSON editor. UDP ports must remain in 1–65535 in both validation paths.

Cached accessory UUIDs continue to use a device ID when known, otherwise the host. Changing from a host-only identity to a later-discovered device ID can replace an accessory and its HomeKit assignments; an identity migration policy is outside this patch.

Package inspection identified that NOTICE was omitted from the allowlist. The release must include both LICENSE and NOTICE. The README's previous MIT claim was stale; the project uses Apache-2.0 while retaining historical MIT attribution in NOTICE.

Aikido MCP is unavailable in this session, so its requested scan could not run. npm audit, executable local checks, CodeRabbit and PR checks supply the available verification, with the Aikido limitation reported explicitly.

## Implemented behavior and review refinements

Scheduled renewal follows the pinned Python fix, with new-token registrations on the same UDP/encryption session. Every verified replacement snapshot reaches the watchdog before duplicate HomeKit events are suppressed. Startup and reconnect establish one long-lived observation. Default `observe()` continues yielding plain status objects; `observe({ metadata: true })` adds registration metadata for the coordinator. Explicit refresh APIs and the former quiet-profile option remain compatible.

CodeRabbit CLI review identified an idle-CX3550 regression in the generated plan's unconditional ten-minute timeout. That profile explicitly expects long silence, so its existing model-scoped read-only reachability exception is preserved after an initial valid status. This probe keeps the known change-only fan available while retaining cached values; it does not update status freshness. Ordinary AC4220/purifier health still requires real status snapshots and never uses getInfo as a substitute. A quiet device with no initial status remains bounded by its watchdog. Tests cover reachable/offline quiet firmware, late probes, and shutdown. No idle CX3550 hardware was available for this session; model behavior is protected by regression tests and the existing documented profile.

Codecov uses OIDC for ordinary PR runs. Dependabot's restricted token path uses public tokenless upload instead; uploader failures remain fatal for every actor. [GitHub documents Dependabot token restrictions](https://docs.github.com/en/code-security/dependabot/troubleshooting-dependabot/troubleshooting-dependabot-on-github-actions), and [Codecov documents authentication](https://github.com/codecov/codecov-action). The future Dependabot-triggered run cannot be live-tested within this human-authored PR.

The unpinned [betaboon/aioairctrl reference](https://github.com/betaboon/aioairctrl/blob/master/aioairctrl/coap/client.py) was also inspected on 28 October 2026: observe_status registers once and iterates notifications, without scheduled renewal. The updated tinkerologie Python implementation provides the relevant renewal evidence.
