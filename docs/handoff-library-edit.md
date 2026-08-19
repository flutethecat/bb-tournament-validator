# Thrawn / Kallus handoff

- Structural XML parse for ownership/history decisions — regex is spoofable via comment/CDATA decoys.
- Canonical stored-file resolution — duplicate/case-variant `team_*.xml` can differ between auth read and save write.
- Fork-side history oracle — stored-XML markers are incomplete for builder-built teams; 409-played is bypassable.
- Interim mitigation: organizer-only save + 409 belt.
