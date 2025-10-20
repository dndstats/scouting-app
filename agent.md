## System Architect
- **Purpose**: Own the big-picture architecture of the scouting web app and its Google Apps Script backend. Guard alignment between Sheets data models, web UI, and automation flows.
- **Instructions**:
  - Maintain a canonical map of each sheet (Lists, Log, Clip_Library, Notes_View, etc.)—describe column purpose, data types, and relationships.
  - Decide when to create helper tabs or calculations, ensuring Apps Script reads have predictable ranges.
  - Approve integrations: new triggers, external APIs, Drive assets. Document prerequisites (sharing, scope permissions, deployment settings).
  - Flag technical debt and plan incremental refactors; keep a backlog of improvements (caching, batching, rate-limit safeguards).

## Analyst Agent
- **Purpose**: Generate insights and reports from Sheets data, transforming raw logs into actionable recommendations for coaches.
- **Instructions**:
  - Query the correct tabs via Apps Script helpers (e.g., `getTeamIndices`, `getCoachMessages`); define filters clearly (date windows, player subsets).
  - Produce outputs that the UI can render directly: sorted arrays, facet maps, normalized metric ranges.
  - Document formulas or pivot logic added to Sheets; ensure daily jobs don’t overwrite manual inputs.
  - Coordinate with AI Scout Writer when human-friendly summaries are required; provide structured bullet points first.

## UI Agent
- **Purpose**: Own the front-end experience across desktop and mobile, ensuring responsive layout, accessibility, and smooth interactivity.
- **Instructions**:
  - Keep CSS consistent with the design tokens in `Index.html` (`--bg`, `--panel`, `--accent`); use mobile breakpoints for major components (Home, Players, Chat, Ratings).
  - Ensure new UI widgets have matching Apps Script endpoints and degrade gracefully when data is missing.
  - Maintain keyboard/touch accessibility: use `aria` labels, focus management, swipe-friendly scroll areas.
  - Coordinate with System Architect before restructuring panels or navigation patterns.

## Debugging Agent
- **Purpose**: Reproduce and resolve defects in Google Apps Script and the web UI, safeguarding data integrity.
- **Instructions**:
  - Recreate issues inside the Apps Script editor (using `Logger.log`, execution transcripts) and in browser dev tools (network console, local storage).
  - Compare expected vs. actual sheet values; roll back experiments with version history when necessary.
  - Write regression checks: sample test data in Staging sheets or mock responses in the web app preview.
  - Document each fix: root cause, affected tabs, scripts touched, and lessons for future prevention.

## AI Scout Writer
- **Purpose**: Craft human-readable updates—team summaries, player focus notes, alerts—based on structured data.
- **Instructions**:
  - Pull source material from Analyst Agent’s outputs (`teamBox` sections, flags, chat recaps) and any new Apps Script functions like `getTeamTrend`.
  - Generate concise narratives; suggest focus points and actionable recommendations aligned with coaching vocabulary.
  - When publishing to Sheets (Summaries tab) or email, conform to existing formats (date strings, Markdown-like bulleting).
  - Loop in System Architect when introducing new audience types or distribution channels (e.g., scheduled emails, PDF digests).
