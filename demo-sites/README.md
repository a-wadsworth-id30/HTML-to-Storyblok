# Demo Sites

Local target sites used to test repository integration before touching real client repositories.

Each demo site has a recognizable framework shape and a dependency-light `build` script that runs a local Node check. The fixtures are intentionally small so integration tests can copy them to temporary folders, generate into `src/integrations/<integration-id>`, validate the result, and verify existing app files remain unchanged.

Framework demos also expose opt-in full-build scripts:

```sh
npm run test:demo-sites-full:list
npm run test:demo-sites-full:install
npm run test:demo-sites-generated
```

The install variant runs `npm install`, each framework compiler build, and an HTTP smoke check against the framework preview server. The generated variant also temporarily wires a generated route proposal into each framework demo and compiles the handoff before restoring the demo files. These are not part of the default test suite because they download framework dependencies and take longer than the dependency-light safety matrix.
