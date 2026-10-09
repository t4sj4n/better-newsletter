# Changelog

## v0.1.0-beta.8

[compare changes](https://github.com/t4sj4n/better-newsletter/compare/v0.1.0-beta.7...v0.1.0-beta.8)

### 🚀 Enhancements

- Add submitted email snapshot for #78 ([#79](https://github.com/t4sj4n/better-newsletter/pull/79), [#78](https://github.com/t4sj4n/better-newsletter/issues/78))
- Add audience snapshots and loading helpers for #80 ([#81](https://github.com/t4sj4n/better-newsletter/pull/81), [#80](https://github.com/t4sj4n/better-newsletter/issues/80))
- Add unsubscribe-all and error titles for #82 ([#83](https://github.com/t4sj4n/better-newsletter/pull/83), [#82](https://github.com/t4sj4n/better-newsletter/issues/82))

## v0.1.0-beta.7

[compare changes](https://github.com/t4sj4n/better-newsletter/compare/v0.1.0-beta.6...v0.1.0-beta.7)

### 🚀 Enhancements

- Add external signup refs and safe clearing #76 ([#77](https://github.com/t4sj4n/better-newsletter/pull/77), [#76](https://github.com/t4sj4n/better-newsletter/issues/76))

## v0.1.0-beta.6

[compare changes](https://github.com/t4sj4n/better-newsletter/compare/v0.1.0-beta.5...v0.1.0-beta.6)

### 🚀 Enhancements

- Improve Nuxt composables for #74 ([#75](https://github.com/t4sj4n/better-newsletter/pull/75), [#74](https://github.com/t4sj4n/better-newsletter/issues/74))

## v0.1.0-beta.5

[compare changes](https://github.com/t4sj4n/better-newsletter/compare/v0.1.0-beta.4...v0.1.0-beta.5)

### 🩹 Fixes

- Use Node 22 LTS default in reusable release workflow ([#73](https://github.com/t4sj4n/better-newsletter/pull/73))

## v0.1.0-beta.4

[compare changes](https://github.com/t4sj4n/better-newsletter/compare/v0.1.0-beta.3...v0.1.0-beta.4)

### 🩹 Fixes

- Set dist-tag directly on publish to avoid unauthenticated npm dist-tag add ([#72](https://github.com/t4sj4n/better-newsletter/pull/72))

## v0.1.0-beta.3

[compare changes](https://github.com/t4sj4n/better-newsletter/compare/v0.1.0-beta.2...v0.1.0-beta.3)

### 🚀 Enhancements

- Publish releases through GitHub Actions OIDC ([#66](https://github.com/t4sj4n/better-newsletter/pull/66))
- **nuxt:** Add headless Vue / Nuxt composables ([#68](https://github.com/t4sj4n/better-newsletter/pull/68))
- Simplify release workflow to tag-triggered publishing #69 ([#70](https://github.com/t4sj4n/better-newsletter/pull/70), [#69](https://github.com/t4sj4n/better-newsletter/issues/69))

### 💅 Refactors

- Simplify local releases with release-it ([#64](https://github.com/t4sj4n/better-newsletter/pull/64))

## v0.1.0-beta.3

[compare changes](https://github.com/t4sj4n/better-newsletter/compare/v0.1.0-beta.2...v0.1.0-beta.3)

### 🚀 Enhancements

- Publish releases through GitHub Actions OIDC ([#66](https://github.com/t4sj4n/better-newsletter/pull/66))
- **nuxt:** Add headless Vue / Nuxt composables ([#68](https://github.com/t4sj4n/better-newsletter/pull/68))
- Simplify release workflow to tag-triggered publishing #69 ([#70](https://github.com/t4sj4n/better-newsletter/pull/70), [#69](https://github.com/t4sj4n/better-newsletter/issues/69))

### 💅 Refactors

- Simplify local releases with release-it ([#64](https://github.com/t4sj4n/better-newsletter/pull/64))

### Other changes

- 👌 check tag existence rather than strictly greater version in release flow ([5b2cdd4](https://github.com/t4sj4n/better-newsletter/commit/5b2cdd4))

## v0.1.0-beta.2

<!-- release-base: debb1eaf0227fcc212df2870aded01e93cf08e18 -->

[compare changes](https://github.com/t4sj4n/better-newsletter/compare/v0.1.0-beta.1...v0.1.0-beta.2)

### 🚀 Enhancements

- Add typed public subscribe metadata #59 ([#60](https://github.com/t4sj4n/better-newsletter/pull/60), [#59](https://github.com/t4sj4n/better-newsletter/issues/59))
- Automate local release preparation and publishing #17 ([#61](https://github.com/t4sj4n/better-newsletter/pull/61), [#17](https://github.com/t4sj4n/better-newsletter/issues/17))

### 🩹 Fixes

- Gate local releases on exact-commit CI ([#62](https://github.com/t4sj4n/better-newsletter/pull/62))

## v0.1.0-beta.1

[compare changes](https://github.com/t4sj4n/better-newsletter/compare/v0.1.0-beta.0...v0.1.0-beta.1)

### 🚀 Enhancements

- Add trusted confirmation APIs #40 ([#41](https://github.com/t4sj4n/better-newsletter/pull/41), [#40](https://github.com/t4sj4n/better-newsletter/issues/40))
- Add paginated subscription event history #42 ([#46](https://github.com/t4sj4n/better-newsletter/pull/46), [#42](https://github.com/t4sj4n/better-newsletter/issues/42))
- ⚠️  Simplify Nuxt integration around one handler #48 ([#50](https://github.com/t4sj4n/better-newsletter/pull/50), [#48](https://github.com/t4sj4n/better-newsletter/issues/48))
- Expose schema revisions and SQL provenance #44 ([#51](https://github.com/t4sj4n/better-newsletter/pull/51), [#44](https://github.com/t4sj4n/better-newsletter/issues/44))
- Promote browser client to framework-neutral public API #53 ([#55](https://github.com/t4sj4n/better-newsletter/pull/55), [#53](https://github.com/t4sj4n/better-newsletter/issues/53))
- Add release preparation with bumpp and changelogen ([d80ce9f](https://github.com/t4sj4n/better-newsletter/commit/d80ce9f))
- Add semver dependency and enhance release version validation in release preparation ([b3fcbdd](https://github.com/t4sj4n/better-newsletter/commit/b3fcbdd))

### 🩹 Fixes

- Fix newline characters in canonical SQL output for better readability ([6b83d6c](https://github.com/t4sj4n/better-newsletter/commit/6b83d6c))
- Fix newline characters in canonical SQL output for correct formatting ([28d54fd](https://github.com/t4sj4n/better-newsletter/commit/28d54fd))

### 📖 Documentation

- Include new changelog in release commits ([cee1302](https://github.com/t4sj4n/better-newsletter/commit/cee1302))

### ✅ Tests

- Reproduce and document Nitro route typing limit #43 ([#45](https://github.com/t4sj4n/better-newsletter/pull/45), [#43](https://github.com/t4sj4n/better-newsletter/issues/43))

### Other changes

- Preserve server-controlled subscribe metadata in lifecycle history ([#47](https://github.com/t4sj4n/better-newsletter/pull/47))
- Support request-aware Nuxt config and per-call confirmation replacement ([#56](https://github.com/t4sj4n/better-newsletter/pull/56))

#### ⚠️ Breaking Changes

- ⚠️  Simplify Nuxt integration around one handler #48 ([#50](https://github.com/t4sj4n/better-newsletter/pull/50), [#48](https://github.com/t4sj4n/better-newsletter/issues/48))
