# Demo Sites

Local target sites used to test repository integration before touching real client repositories.

Each demo site has a recognizable framework shape and a dependency-light `build` script that runs a local Node check. The fixtures are intentionally small so integration tests can copy them to temporary folders, generate into `src/integrations/<integration-id>`, validate the result, and verify existing app files remain unchanged.

