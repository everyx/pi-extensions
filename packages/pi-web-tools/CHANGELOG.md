# Changelog

## [1.2.3](https://github.com/everyx/pi-extensions/compare/pi-web-tools-v1.2.2...pi-web-tools-v1.2.3) (2026-09-04)


### Bug Fixes

* **pi-web-tools:** start bsk session with --no-focus to avoid stealing focus ([3a1d357](https://github.com/everyx/pi-extensions/commit/3a1d35724ca442e9fd8b72ad9876d39b7de5a9ab))

## [1.2.2](https://github.com/everyx/pi-extensions/compare/pi-web-tools-v1.2.1...pi-web-tools-v1.2.2) (2026-09-01)


### Bug Fixes

* **pi-web-tools:** bsk lifecycle test seam + abort signal into the CLI ([fdc644d](https://github.com/everyx/pi-extensions/commit/fdc644d42b66c3a5468e2099fb85df4b93adbb8b))
* **pi-web-tools:** renderer seam self-reports contentType — bsk is no longer labeled markdown ([92d46b5](https://github.com/everyx/pi-extensions/commit/92d46b5d24f8514e02df2a3b894c7294041c0123))
* **pi-web-tools:** rot sweep — ghost channel comments, curl-identity doc, expand-hint contract, unexport internals ([e0c77bb](https://github.com/everyx/pi-extensions/commit/e0c77bb3c9c32f4c58a683ee4f42968d6a641ef1))
* **pi-web-tools:** tinyfish search limiter 2 → 0.4 qps — free tier is 30 req/min, not 120 ([52d2f81](https://github.com/everyx/pi-extensions/commit/52d2f817a3949bbb43f03722afbe1ee6bb6d0ebd))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @everyx/pi-ui bumped to 1.1.2

## [1.2.1](https://github.com/everyx/pi-extensions/compare/pi-web-tools-v1.2.0...pi-web-tools-v1.2.1) (2026-08-31)


### Bug Fixes

* **pi-ui:** expand hint — content-gated, in the meta parentheses, API key ([e6f866f](https://github.com/everyx/pi-extensions/commit/e6f866feb15bc54f3a6f174e8fe7946fff7fcede))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @everyx/pi-ui bumped to 1.1.1

## [1.2.0](https://github.com/everyx/pi-extensions/compare/pi-web-tools-v1.1.0...pi-web-tools-v1.2.0) (2026-08-31)


### Features

* **pi-web-tools:** direct fetch via the system curl CLI ([53a797f](https://github.com/everyx/pi-extensions/commit/53a797f5b051fa92dd467e39a7cecb7196e8d9b9))


### Bug Fixes

* **pi-web-tools:** fetched-card shows the ctrl+o expand hint, read-like ([316194b](https://github.com/everyx/pi-extensions/commit/316194b51c9fc85cb5515fedc0c12200678486c4))
* **pi-web-tools:** npm package ships fetch/ and search/ trees ([0e22ecd](https://github.com/everyx/pi-extensions/commit/0e22ecd6376d389be09688316dccf4360a9b4fcd))
* **pi-web-tools:** web_fetch transport — impers dropped, honest plain fetch ([7e42299](https://github.com/everyx/pi-extensions/commit/7e42299fbe520c3abf40c45fb9df532e640dd96f))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @everyx/pi-ui bumped to 1.1.0

## [1.1.0](https://github.com/everyx/pi-extensions/compare/pi-web-tools-v1.0.2...pi-web-tools-v1.1.0) (2026-08-30)


### Features

* **pi-web-tools:** full browser impersonation — impers replaces hand-rolled GET headers ([5043802](https://github.com/everyx/pi-extensions/commit/5043802b39cc745342ade2a7f8ca98f70b55209a))
* **pi-web-tools:** rebuild search as a keyless-first fuse chain ([92d686a](https://github.com/everyx/pi-extensions/commit/92d686ac6b3f44058468ff70d98389e14293f68d))
* **pi-web-tools:** web_fetch ctrl+o expand shows the FULL fetched text ([09d30d7](https://github.com/everyx/pi-extensions/commit/09d30d7d5cec82e29e6f5a98cdc4a2ca62858cc5))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @everyx/pi-ui bumped to 1.0.3

## [1.0.2](https://github.com/everyx/pi-extensions/compare/pi-web-tools-v1.0.1...pi-web-tools-v1.0.2) (2026-08-29)


### Bug Fixes

* **release:** migrate to release-please for correct workspace/catalog resolution ([e3b51e4](https://github.com/everyx/pi-extensions/commit/e3b51e421d7679f7c00739646f97d770dd0ff2aa))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @everyx/pi-ui bumped to 1.0.2
