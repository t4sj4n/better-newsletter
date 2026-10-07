# Changelog

## v0.1.0-beta.3

[compare changes](https://github.com/t4sj4n/better-newsletter/compare/v0.1.0-beta.2...v0.1.0-beta.3)

### 💅 Refactors

- Simplify local releases with release-it ([#64](https://github.com/t4sj4n/better-newsletter/pull/64))

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
