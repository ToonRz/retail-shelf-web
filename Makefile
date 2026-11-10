# SPEC §7. Releases come from GitHub (or AGENT_RELEASES_DIR=<folder of vX.Y.Z/ release folders>).
.PHONY: fetch-agent-release bump-agent agent-lag

# Download + verify the release pinned in agent.version into public/agent/<version>/ (not committed).
fetch-agent-release:
	node scripts/agent-release.mjs fetch

# make bump-agent [AGENT_VERSION=vX.Y.Z] [ALLOW_MINOR=1]
# Moves agent.version (latest patch of the same minor by default), runs npm test + npm run build,
# and restores the old pin if anything fails. Does not commit.
bump-agent:
	node scripts/agent-release.mjs bump $(if $(AGENT_VERSION),--version $(AGENT_VERSION)) $(if $(filter 1,$(ALLOW_MINOR)),--allow-minor)

# Warn when a newer patch of the pinned minor exists.
agent-lag:
	node scripts/agent-release.mjs lag
