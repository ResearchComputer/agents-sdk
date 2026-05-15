SHELL := /usr/bin/env bash

PYTHON ?= .venv/bin/python
DIST_DIR ?= python-dist
PY_SDK_DIR := src/python
PY_WASM_HOST_DIR := src/python/wasm-host
PY_WASM_HOST_MANIFEST := $(PY_WASM_HOST_DIR)/Cargo.toml

TWINE ?= $(PYTHON) -m twine
TWINE_REPOSITORY ?=
TWINE_REPOSITORY_ARG := $(if $(TWINE_REPOSITORY),--repository $(TWINE_REPOSITORY),)
MATURIN_COMPATIBILITY ?=
MATURIN_COMPATIBILITY_ARG := $(if $(MATURIN_COMPATIBILITY),--compatibility $(MATURIN_COMPATIBILITY),)
MATURIN_TARGET ?=
MATURIN_TARGET_ARG := $(if $(MATURIN_TARGET),--target $(MATURIN_TARGET),)
MATURIN_EXTRA_ARGS ?=

NPM ?= npm
NPM_TAG ?=
NPM_TAG_ARG := $(if $(NPM_TAG),--tag $(NPM_TAG),)
NPM_OTP ?=
NPM_OTP_ARG := $(if $(NPM_OTP),--otp $(NPM_OTP),)

.PHONY: help
help:
	@printf '%s\n' \
		'Python package targets:' \
		'  make py-tools              Install build/upload tools into PYTHON env' \
		'  make py-version VERSION=X  Bump both Python package versions together' \
		'  make py-clean              Remove python-dist and package build dirs' \
		'  make py-build              Build flash-agents-wasm, then flash-agents' \
		'  make py-build-wasm-host-arm64 Build Linux ARM64 flash-agents-wasm wheel' \
		'  make py-build-linux-wheels Build Linux x86_64 + ARM64 wasm wheels and SDK' \
		'  make py-check              Run twine check on built artifacts' \
		'  make py-upload-testpypi    Upload both packages to TestPyPI' \
		'  make py-upload-pypi        Upload both packages to PyPI' \
		'  make py-release-testpypi   Clean, build, check, upload to TestPyPI' \
		'  make py-release-pypi       Clean, build, check, upload to PyPI' \
		'' \
		'npm package targets:' \
		'  make npm-version VERSION=X Bump root package.json version' \
		'  make npm-clean             Remove dist/ and packed tarballs' \
		'  make npm-build             Run TypeScript build (npm run build)' \
		'  make npm-pack              Produce a local tarball via npm pack' \
		'  make npm-publish           Publish @researchcomputer/agents-sdk to npmjs' \
		'  make npm-publish-dry-run   Dry-run npm publish to validate the package' \
		'  make npm-release           Clean, build, then publish to npmjs' \
		'' \
		'Variables:' \
		'  PYTHON=.venv/bin/python    Python interpreter to use' \
		'  DIST_DIR=python-dist       Output directory for artifacts' \
		'  VERSION=0.2.0              Version for py-version / release bump targets' \
		'  MATURIN_COMPATIBILITY=manylinux2014 Optional maturin compatibility tag' \
		'  TWINE_USERNAME=__token__   PyPI token username' \
		'  TWINE_PASSWORD=pypi-...    PyPI token value' \
		'  NPM=npm                    npm executable (e.g. npm or bun x npm)' \
		'  NPM_TAG=next               Optional dist-tag for npm publish' \
		'  NPM_OTP=123456             Optional 2FA one-time password for npm publish'

.PHONY: require-version
require-version:
	@test -n "$(VERSION)" || { echo 'VERSION is required, for example: make py-version VERSION=0.2.0'; exit 2; }

.PHONY: py-version
py-version: require-version
	node scripts/bump-python-version.mjs "$(VERSION)"

.PHONY: py-tools
py-tools:
	$(PYTHON) -m pip install --upgrade build twine 'maturin[zig]'

.PHONY: py-clean
py-clean:
	rm -rf "$(DIST_DIR)" "$(PY_SDK_DIR)/build" "$(PY_SDK_DIR)/dist" "$(PY_SDK_DIR)"/*.egg-info

.PHONY: py-build-wasm-core
py-build-wasm-core:
	bun run build:wasm:python

.PHONY: py-build-wasm-host
py-build-wasm-host:
	mkdir -p "$(DIST_DIR)"
	$(PYTHON) -m maturin build --manifest-path "$(PY_WASM_HOST_MANIFEST)" --release $(MATURIN_COMPATIBILITY_ARG) $(MATURIN_TARGET_ARG) $(MATURIN_EXTRA_ARGS) --out "$(DIST_DIR)"

.PHONY: py-build-wasm-host-x86_64
py-build-wasm-host-x86_64:
	$(MAKE) py-build-wasm-host MATURIN_TARGET=x86_64-unknown-linux-gnu MATURIN_COMPATIBILITY=manylinux2014 MATURIN_EXTRA_ARGS=--zig

.PHONY: py-build-wasm-host-arm64
py-build-wasm-host-arm64:
	$(MAKE) py-build-wasm-host MATURIN_TARGET=aarch64-unknown-linux-gnu MATURIN_COMPATIBILITY=manylinux2014 MATURIN_EXTRA_ARGS=--zig

.PHONY: py-build-sdk
py-build-sdk:
	mkdir -p "$(DIST_DIR)"
	$(PYTHON) -m build "$(PY_SDK_DIR)" --outdir "$(DIST_DIR)"

.PHONY: py-build
py-build: py-build-wasm-core py-build-wasm-host py-build-sdk

.PHONY: py-build-linux-wheels
py-build-linux-wheels: py-build-wasm-core py-build-wasm-host-x86_64 py-build-wasm-host-arm64 py-build-sdk

.PHONY: py-check
py-check:
	$(TWINE) check "$(DIST_DIR)"/*

.PHONY: py-upload-wasm
py-upload-wasm:
	$(TWINE) upload $(TWINE_REPOSITORY_ARG) "$(DIST_DIR)"/flash_agents_wasm-*.whl

.PHONY: py-upload-sdk
py-upload-sdk:
	$(TWINE) upload $(TWINE_REPOSITORY_ARG) "$(DIST_DIR)"/flash_agents-*

.PHONY: py-upload-testpypi
py-upload-testpypi:
	$(MAKE) py-upload-wasm TWINE_REPOSITORY=testpypi
	$(MAKE) py-upload-sdk TWINE_REPOSITORY=testpypi

.PHONY: py-upload-pypi
py-upload-pypi:
	$(MAKE) py-upload-wasm TWINE_REPOSITORY=pypi
	$(MAKE) py-upload-sdk TWINE_REPOSITORY=pypi

.PHONY: py-release-testpypi
py-release-testpypi: py-clean py-tools py-build py-check py-upload-testpypi

.PHONY: py-release-pypi
py-release-pypi: py-clean py-tools py-build py-check py-upload-pypi

.PHONY: py-release-testpypi-version
py-release-testpypi-version: py-version py-release-testpypi

.PHONY: py-release-pypi-version
py-release-pypi-version: py-version py-release-pypi

.PHONY: npm-version
npm-version: require-version
	$(NPM) version "$(VERSION)" --no-git-tag-version --allow-same-version

.PHONY: npm-clean
npm-clean:
	rm -rf dist
	rm -f researchcomputer-agents-sdk-*.tgz
	rm -f tsconfig.core.tsbuildinfo tsconfig.node.tsbuildinfo

.PHONY: npm-build
npm-build:
	$(NPM) run build

.PHONY: npm-pack
npm-pack: npm-build
	$(NPM) pack

.PHONY: npm-publish-dry-run
npm-publish-dry-run: npm-build
	$(NPM) publish --dry-run --access public $(NPM_TAG_ARG)

.PHONY: npm-publish
npm-publish: npm-build
	$(NPM) publish --access public $(NPM_TAG_ARG) $(NPM_OTP_ARG)

.PHONY: npm-release
npm-release: npm-clean npm-publish

.PHONY: npm-release-version
npm-release-version: npm-version npm-release
