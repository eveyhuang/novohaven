## NEVER EVER DO

These rules are ABSOLUTE:

### NEVER Publish Sensitive Data
- NEVER publish passwords, API keys, tokens to git/npm/docker
- Before ANY commit: verify no secrets included

### NEVER Commit .env Files
- NEVER commit `.env` to git
- ALWAYS verify `.env` is in `.gitignore`


## New Project Setup

When creating ANY new project:

### Required Files
- `.env` - Environment variables (NEVER commit)
- `.env.example` - Template with placeholders
- `.gitignore` - Must include: .env, node_modules/, dist/
- `CLAUDE.md` - Project overview

### Required Structure
project/
├── src/
├── tests/
├── docs/
├── .claude/
│   ├── skills/
│   ├── agents/
│   └── commands/
└── scripts/

### Node.js Requirements
Add to entry point:
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection:', reason);
  process.exit(1);
});