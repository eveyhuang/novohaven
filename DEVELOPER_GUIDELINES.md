# NovoHaven Developer Guidelines

> A reference for team members and code reviewers.
> **Stack**: React 18 + TypeScript + Tailwind | Node.js + Express + TypeScript | SQLite (sql.js)

---

## Table of Contents

1. [Quick Start](#1-quick-start)
2. [Project Structure](#2-project-structure)
3. [Naming Conventions](#3-naming-conventions)
4. [TypeScript Guidelines](#4-typescript-guidelines)
5. [Backend (Server)](#5-backend-server)
6. [Frontend (Client)](#6-frontend-client)
7. [Styling (Tailwind)](#7-styling-tailwind)
8. [API Contract](#8-api-contract)
9. [Error Handling](#9-error-handling)
10. [Database](#10-database)
11. [Testing](#11-testing)
12. [i18n (Internationalization)](#12-i18n-internationalization)
13. [Environment & Secrets](#13-environment--secrets)
14. [Git & Code Review](#14-git--code-review)
15. [Architecture Patterns](#15-architecture-patterns)
16. [Common Pitfalls](#16-common-pitfalls)

---

## 1. Quick Start

### Prerequisites

- Node.js 18+
- npm

### Setup

```bash
# 1. Clone & enter the repo
git clone <repo-url> && cd novohaven-app

# 2. Environment variables
cp .env.example .env
# Edit .env — add your own API keys (see Section 13)

# 3. Install & run server
cd server && npm install && npm run dev
# → http://localhost:3001

# 4. Install & run client (separate terminal)
cd client && npm install && npm start
# → http://localhost:3000
```

### Demo Login

The MVP uses mock auth. Any password works with `demo@novohaven.com`.

### Useful Commands

| Command | Location | Purpose |
|---------|----------|---------|
| `npm run dev` | `server/` | Start server with hot-reload (ts-node-dev) |
| `npm start` | `client/` | Start React dev server (CRA) |
| `npm run build` | `server/` | Compile TypeScript → `dist/` |
| `npm run build` | `client/` | Production build → `build/` |
| `npm test` | `server/` | Run Jest tests |
| `npm test` | `client/` | Run CRA tests |

---

## 2. Project Structure

```
novohaven-app/
├── client/                          # React 18 + TypeScript frontend
│   ├── src/
│   │   ├── components/
│   │   │   ├── common/              # Reusable UI primitives (Button, Card, Modal, Input…)
│   │   │   ├── Dashboard/           # Landing page
│   │   │   ├── RecipeBuilder/       # Workflow editor + runner
│   │   │   ├── TemplateEditor/      # Single-task template editor
│   │   │   ├── WorkflowExecution/   # Execution list + detail views
│   │   │   ├── WorkflowBuilder/     # AI-powered workflow generator
│   │   │   ├── CompanyStandards/    # Brand standards CRUD
│   │   │   ├── OutputsGallery/      # Output browser
│   │   │   └── ReviewAnalysis/      # Scraping & review analysis
│   │   ├── context/                 # React Context providers (Auth, Language, Notification)
│   │   ├── hooks/                   # Custom hooks (useTranslatedText)
│   │   ├── i18n/                    # Translation dictionaries (en/zh)
│   │   ├── services/                # API client (fetch-based), translation service
│   │   ├── types/                   # Shared TypeScript types
│   │   ├── App.tsx                  # Root component + route definitions
│   │   └── index.tsx                # React entry point
│   ├── tailwind.config.js
│   └── tsconfig.json
│
├── server/                          # Node.js + Express backend
│   ├── src/
│   │   ├── routes/                  # Express routers (recipes, executions, ai, …)
│   │   ├── services/                # Business logic (aiService, workflowEngine, …)
│   │   ├── executors/               # Step executor plugin system
│   │   │   ├── StepExecutor.ts      # Interface + types
│   │   │   ├── registry.ts          # Executor registry (Map-based)
│   │   │   ├── AIExecutor.ts
│   │   │   ├── ScrapingExecutor.ts
│   │   │   ├── ScriptExecutor.ts
│   │   │   ├── HttpExecutor.ts
│   │   │   └── TransformExecutor.ts
│   │   ├── models/
│   │   │   └── database.ts          # Schema, queries, seeds (sql.js)
│   │   ├── middleware/              # Auth middleware
│   │   ├── types/
│   │   │   └── index.ts             # Server-side type definitions
│   │   ├── __tests__/               # Jest tests
│   │   └── index.ts                 # Express entry point
│   ├── data/                        # SQLite database file
│   ├── jest.config.js
│   └── tsconfig.json
│
├── .env.example                     # Environment variable template
├── .gitignore
└── README.md
```

### Organizing Principles

- **Feature-based folders on the frontend** — each UI feature gets its own directory under `components/` with an `index.ts` barrel export.
- **Layer-based folders on the backend** — separated into `routes/`, `services/`, `executors/`, `models/`, `types/`.
- **One barrel export per feature folder** — `index.ts` re-exports the main component(s).
- **Types are centralized** — a single `types/index.ts` per side (client + server). Don't scatter interfaces across files.

---

## 3. Naming Conventions

### Files

| What | Pattern | Example |
|------|---------|---------|
| React component | `PascalCase.tsx` | `Dashboard.tsx`, `RecipeBuilder.tsx` |
| Custom hook | `camelCase.ts` | `useTranslatedText.ts` |
| Service / utility | `camelCase.ts` | `api.ts`, `translationService.ts` |
| Executor class | `PascalCase.ts` | `AIExecutor.ts`, `HttpExecutor.ts` |
| Route file | `camelCase.ts` | `recipes.ts`, `executions.ts` |
| Context provider | `PascalCase.tsx` | `AuthContext.tsx`, `LanguageContext.tsx` |
| Test file | `*.test.ts` | `registry.test.ts` |
| Type barrel | `index.ts` | `types/index.ts` |

### Code Identifiers

| Context | Style | Example |
|---------|-------|---------|
| Variables, functions, parameters | `camelCase` | `recipeId`, `loadRecipe()`, `isLoading` |
| React components | `PascalCase` | `RecipeBuilder`, `Button` |
| Interfaces, types | `PascalCase` | `Recipe`, `AIServiceConfig` |
| Constants | `UPPER_SNAKE_CASE` | `AI_MODELS`, `COLUMN_MAPPINGS` |
| Database columns | `snake_case` | `recipe_id`, `step_order`, `created_at` |
| CSS classes | Tailwind utilities | `bg-primary-600`, `text-secondary-900` |
| Boolean vars/props | `is`/`has`/`can` prefix | `isLoading`, `hasError`, `canEdit` |
| Callbacks (props) | `on` prefix | `onChange`, `onClose`, `onDelete` |

### Type Naming Suffixes

| Suffix | When to use | Example |
|--------|-------------|---------|
| `Config` | Configuration objects | `AIServiceConfig`, `HttpConfig` |
| `Request` | Incoming API payloads | `CreateRecipeRequest`, `StartExecutionRequest` |
| `Response` | Outgoing API payloads | `AIResponse`, `ScrapingResponse` |
| `Result` | Operation return values | `StepExecutorResult`, `ExecutionResult` |
| `WithSteps`, `WithDetails` | Extended join types | `RecipeWithSteps`, `WorkflowExecutionWithDetails` |
| `Public` | Stripped/safe versions | `UserPublic` (no password_hash) |

---

## 4. TypeScript Guidelines

### Compiler Settings (both sides)

- **Strict mode is ON** — do not disable it.
- **Target**: ES2020 — safe to use `?.`, `??`, `Promise.allSettled`, etc.
- Client uses `"jsx": "react-jsx"` (no `import React` needed).
- Client `baseUrl` is `src` — import as `services/api`, not `../../services/api`.

### Do's

```typescript
// Prefer string union types over enums
type ExecutionStatus = 'pending' | 'running' | 'paused' | 'completed' | 'failed';

// Extend interfaces for joined/enriched models
interface RecipeWithSteps extends Recipe {
  steps: RecipeStep[];
}

// Use Omit/Pick for request types derived from models
type CreateStepPayload = Omit<RecipeStep, 'id' | 'recipe_id' | 'created_at'>;

// Type route handler params explicitly
router.get('/:id', (req: Request, res: Response) => { ... });
```

### Don'ts

```typescript
// Don't use `any` without justification — prefer `unknown` or a specific type
const data: any = response.body;          // BAD
const data: Record<string, unknown> = ... // BETTER

// Don't use enums (we use string unions project-wide)
enum Status { Pending, Running }          // BAD — not used in this project

// Don't create parallel type definitions — reuse from types/index.ts
// If a type exists server-side, mirror it client-side in the same shape
```

### JSON-Stored Fields

Several DB columns store serialized JSON (`input_config`, `model_config`, `executor_config`, `api_config`, `input_data`, `output_data`). The type system marks these as `string` in the DB model but they should be parsed to their typed shape when used:

```typescript
// DB layer — string
interface RecipeStep {
  executor_config?: string;  // JSON string
}

// Usage — parse and type-check
const config: HttpConfig = JSON.parse(step.executor_config || '{}');
```

---

## 5. Backend (Server)

### Entry Point (`server/src/index.ts`)

Middleware stack in order:

1. CORS (origin from `CLIENT_URL`)
2. Body parsers (JSON 10MB limit, urlencoded extended)
3. Request logger (method, path, status, duration)
4. Route handlers (`/api/*`)
5. 404 handler
6. Global error handler

### Routes

**Pattern**: Thin route handlers that delegate to services.

```typescript
// Good — route validates input, calls service, returns response
router.post('/', authMiddleware, (req: Request, res: Response) => {
  try {
    const { name, description, steps } = req.body;
    if (!name) {
      res.status(400).json({ error: 'Recipe name is required' });
      return;
    }
    const result = queries.createRecipe(name, description, req.user.id, false);
    res.status(201).json({ id: result.lastInsertRowid, name, description });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});
```

**Rules**:
- All routes require `authMiddleware` (MVP: demo user).
- Validate required fields at the top — return `400` early.
- Wrap in `try/catch` — return `500` for unexpected errors.
- Use correct HTTP status codes (see [Section 9](#9-error-handling)).
- Don't put business logic in route handlers — call services.

### Services

**Pattern**: Pure functions or modules that return result objects, never throw for expected failures.

```typescript
// Return shape for service operations
{ success: true, content: "...", model: "gpt-4o", usage: { ... } }
{ success: false, content: "", error: "API key not configured" }
```

**Key services**:

| Service | Purpose |
|---------|---------|
| `aiService.ts` | Multi-provider AI abstraction (OpenAI, Anthropic, Google, Mock) |
| `workflowEngine.ts` | Workflow orchestration with human-in-the-loop |
| `promptParser.ts` | Variable extraction + prompt compilation |
| `workflowAssistant.ts` | AI-powered workflow generation from chat |
| `brightDataService.ts` | E-commerce review scraping |
| `csvParserService.ts` | CSV parsing + export |
| `usageTrackingService.ts` | API usage logging + billing |

**Rules**:
- Services should be stateless — don't store mutable state at module scope (exception: lazy-initialized API clients).
- Log with context: `console.error('[ServiceName] Description:', error.message)`.
- Use result objects, not exceptions, for expected failures.

### Executor Plugin System

The executor system allows adding new step types without modifying the workflow engine.

**To add a new executor:**

1. Create `server/src/executors/MyExecutor.ts` implementing `StepExecutor`:

```typescript
import { StepExecutor, StepExecutorContext, StepExecutorResult, ExecutorConfigSchema } from './StepExecutor';

export class MyExecutor implements StepExecutor {
  type = 'my_type';
  displayName = 'My Executor';
  icon = '🔧';
  description = 'Does something useful';

  validateConfig(step: RecipeStep): { valid: boolean; errors: string[] } {
    const errors: string[] = [];
    // Validate required config fields
    return { valid: errors.length === 0, errors };
  }

  async execute(step: RecipeStep, context: StepExecutorContext): Promise<StepExecutorResult> {
    // Implementation here
    return { success: true, content: 'result' };
  }

  getConfigSchema(): ExecutorConfigSchema {
    return {
      fields: [
        { name: 'option', label: 'Option', type: 'text', required: true }
      ]
    };
  }
}
```

2. Register in `server/src/executors/registry.ts`:

```typescript
import { MyExecutor } from './MyExecutor';
registerExecutor(new MyExecutor());
```

3. Add the step type to the `StepType` union in both `server/src/types/index.ts` and `client/src/types/index.ts`.

---

## 6. Frontend (Client)

### React Patterns

- **Functional components only** — no class components.
- **Hooks for all state and effects** — `useState`, `useEffect`, `useContext`, `useMemo`, `useRef`.
- **No external state management** — use React Context for shared state, local `useState` for component state.

### Component Structure

```typescript
// components/FeatureName/FeatureName.tsx

import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { Button, Card } from '../common';
import { api } from '../../services/api';
import { Recipe } from '../../types';

interface FeatureNameProps {
  // explicit props interface — always define it
}

export const FeatureName: React.FC<FeatureNameProps> = ({ ... }) => {
  const [isLoading, setIsLoading] = useState(false);
  const { user } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    setIsLoading(true);
    try {
      const data = await api.getRecipes();
      // ...
    } catch (error) {
      console.error('Failed to load:', error);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* JSX */}
    </div>
  );
};
```

### Barrel Exports

Every feature folder has an `index.ts`:

```typescript
// components/Dashboard/index.ts
export { Dashboard } from './Dashboard';
```

Import as:

```typescript
import { Dashboard } from '../components/Dashboard';
```

### Context Usage

Three contexts are available app-wide:

```typescript
const { user, isAuthenticated, login, logout } = useAuth();
const { language, setLanguage, t } = useLanguage();
const { addNotification, trackExecution } = useNotifications();
```

### Routing

Routes are defined in `App.tsx` using React Router v6. Follow the existing pattern:

```typescript
<Route path="/feature" element={<FeatureComponent />} />
<Route path="/feature/:id" element={<FeatureDetailComponent />} />
```

Access params with `useParams()`, navigate with `useNavigate()`.

### API Calls

Use the singleton `api` client from `services/api.ts`:

```typescript
import { api } from '../services/api';

// All methods are typed and return parsed JSON
const recipes = await api.getRecipes();
const recipe = await api.getRecipe(id);
await api.createRecipe({ name, description, steps });
```

**Don't** use `fetch` directly — always go through the `api` client for auth headers and consistent error handling.

### Common Components Reference

| Component | Location | Props | Purpose |
|-----------|----------|-------|---------|
| `Button` | `common/Button.tsx` | `variant`, `size`, `isLoading` | Primary action button |
| `Card` | `common/Card.tsx` | `hoverable`, `onClick` | Container with optional header/body/footer |
| `Input` | `common/Input.tsx` | `label`, `error`, `helperText` | Form input, also exports `TextArea`, `Select` |
| `Modal` | `common/Modal.tsx` | `isOpen`, `onClose`, `title`, `size` | Dialog overlay |
| `ExecutorConfigFields` | `common/ExecutorConfigFields.tsx` | `stepType`, `executors`, `executorConfig` | Dynamic form for executor config |
| `DynamicInput` | `common/DynamicInput.tsx` | field config object | Type-aware input renderer |

---

## 7. Styling (Tailwind)

### Theme

Custom color scales are defined in `tailwind.config.js`:

- **`primary-*`** — Sky blue (`#0ea5e9` at 500). Use for actions, links, active states.
- **`secondary-*`** — Slate gray (`#64748b` at 500). Use for text, borders, backgrounds.

Fonts:
- **Sans**: Inter, system-ui, sans-serif
- **Mono**: JetBrains Mono, monospace

### Usage Rules

1. **Use Tailwind utilities** — no external CSS files, no CSS modules, no styled-components.

2. **Use the `primary-*` / `secondary-*` scales** — don't hardcode hex colors.

```html
<!-- Good -->
<button className="bg-primary-600 hover:bg-primary-700 text-white">

<!-- Bad — hardcoded color -->
<button className="bg-[#0284c7] text-white">
```

3. **Responsive grid pattern** — mobile-first, use breakpoints:

```html
<div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
```

4. **Spacing** — use Tailwind's spacing scale consistently. `space-y-4` for vertical spacing between children, `p-6` for padding, `gap-4` for grid/flex gaps.

5. **States**: `hover:`, `focus:`, `disabled:` prefixes.

```html
<button className="bg-primary-600 hover:bg-primary-700 focus:ring-2 focus:ring-primary-500 disabled:opacity-50">
```

6. **Custom utilities** are defined in `src/index.css` under `@layer`:
   - `.prose` — Markdown content styling
   - `.line-clamp-2`, `.line-clamp-3` — Text truncation
   - `.scrollbar-thin` — Slim scrollbar
   - `.animate-slide-in-right` — Notification entrance

---

## 8. API Contract

### Base URL

```
http://localhost:3001/api
```

### Endpoints

| Group | Prefix | Key Endpoints |
|-------|--------|---------------|
| Auth | `/auth` | `POST /login`, `GET /me` |
| Recipes | `/recipes` | CRUD + `POST /:id/clone` |
| Executions | `/executions` | CRUD + `POST /:id/steps/:stepId/approve\|reject\|retry` |
| Standards | `/standards` | CRUD + `GET /type/:type` |
| AI | `/ai` | `GET /models`, `GET /providers`, `POST /test` |
| Assistant | `/assistant` | `POST /generate`, `POST /save` |
| Executors | `/executors` | `GET /` (list available types) |
| Scraping | `/scraping` | `POST /reviews`, `POST /csv/parse`, `POST /export` |
| Usage | `/usage` | `GET /`, `GET /history`, `GET /billing` |
| Outputs | `/outputs` | `GET /`, `GET /:id`, `GET /export` |

### Response Shapes

**Success** (single item):
```json
{ "id": 1, "name": "My Recipe", "description": "..." }
```

**Success** (collection):
```json
[{ "id": 1, ... }, { "id": 2, ... }]
```

**Error**:
```json
{ "error": "Human-readable error message" }
```

### Status Codes

| Code | Meaning | When |
|------|---------|------|
| `200` | OK | Successful GET/PUT |
| `201` | Created | Successful POST (create) |
| `400` | Bad Request | Missing/invalid input |
| `401` | Unauthorized | No/invalid auth token |
| `404` | Not Found | Resource doesn't exist |
| `500` | Server Error | Unhandled exception |

---

## 9. Error Handling

### Backend — Three Layers

**1. Service layer** — return result objects, don't throw:

```typescript
// services/aiService.ts
return {
  success: false,
  content: '',
  model,
  error: error.message || 'API call failed'
};
```

**2. Route layer** — validate input, try/catch, return HTTP errors:

```typescript
router.post('/', (req, res) => {
  try {
    if (!req.body.name) {
      res.status(400).json({ error: 'Name is required' });
      return;                    // ← always return after sending response
    }
    const result = service.doWork(req.body);
    if (!result.success) {
      res.status(400).json({ error: result.error });
      return;
    }
    res.status(201).json(result.data);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});
```

**3. Global error handler** — catches anything that slips through:

```typescript
app.use((err: Error, req, res, next) => {
  console.error('Error:', err.message);
  res.status(500).json({ error: 'Internal server error' });
});
```

### Frontend

```typescript
try {
  const data = await api.someMethod();
  // handle success
} catch (error) {
  console.error('Context for the error:', error);
  addNotification({ type: 'error', message: 'User-friendly message' });
}
```

### Executor Validation

Each executor implements `validateConfig()` that returns `{ valid: boolean, errors: string[] }`. The workflow engine calls this before execution.

---

## 10. Database

### Engine

- **sql.js** — SQLite compiled to WebAssembly, runs in-process.
- **Synchronous API** — no `async/await` needed for queries.
- **File persistence** — saves to `server/data/novohaven.db`.

### Schema at a Glance

| Table | Purpose | Key Columns |
|-------|---------|-------------|
| `users` | User accounts | `id`, `email`, `password_hash` |
| `recipes` | Workflow definitions | `id`, `name`, `is_template`, `created_by` |
| `recipe_steps` | Steps within a recipe | `recipe_id`, `step_order`, `step_type`, `prompt_template`, `executor_config` |
| `company_standards` | Brand voice/guidelines | `user_id`, `standard_type`, `content` (JSON) |
| `workflow_executions` | Running/completed workflows | `recipe_id`, `status`, `input_data` (JSON) |
| `step_executions` | Individual step results | `execution_id`, `status`, `output_data` (JSON) |
| `api_usage` | API call tracking | `service`, `request_count`, `records_fetched` |

### Query Pattern

All queries go through the `queries` object exported from `database.ts`. Don't write raw SQL elsewhere.

```typescript
import { queries } from '../models/database';

// Synchronous — no await needed
const recipe = queries.getRecipeById(id);
const steps = queries.getStepsByRecipeId(recipe.id);
queries.createRecipe(name, description, userId, false);
```

### Column Naming

Database columns use `snake_case` consistently: `recipe_id`, `step_order`, `created_at`, `is_template`.

### Migrations

Schema changes use `ALTER TABLE ... ADD COLUMN` with `IF NOT EXISTS`-style guards in `database.ts` `initializeDatabase()`. There is no migration framework — changes are applied on startup.

---

## 11. Testing

### Server

- **Framework**: Jest + ts-jest
- **Location**: `server/src/__tests__/`
- **Pattern**: `__tests__/**/*.test.ts`
- **Run**: `cd server && npm test`

```typescript
// server/src/__tests__/services/myService.test.ts
describe('MyService', () => {
  it('should return success for valid input', () => {
    const result = myService.doWork(validInput);
    expect(result.success).toBe(true);
    expect(result.data).toBeDefined();
  });
});
```

### Client

- **Framework**: Jest via react-scripts (CRA default)
- **Run**: `cd client && npm test`
- **Note**: Minimal test coverage currently — new features should include tests.

### What to Test

- **Services**: Unit test business logic, mock external API calls.
- **Executors**: Test `validateConfig()` and `execute()` with mock contexts.
- **Route handlers**: Integration test request/response cycles.
- **Components**: Test user interactions and rendered output (React Testing Library).

---

## 12. i18n (Internationalization)

### Supported Languages

- **English** (`en`) — default
- **Chinese** (`zh`)

### Architecture

1. **Static UI strings** — translation dictionary in `client/src/i18n/translations.ts`:

```typescript
const { t } = useLanguage();
<h1>{t('dashboardTitle')}</h1>
```

2. **Dynamic content** (recipe names, descriptions) — translated at runtime via MyMemory API with caching:

```typescript
const translatedName = useTranslatedText(recipe.name, 'en');
```

3. **Language toggle** — in sidebar (Layout.tsx), persisted to localStorage.

### Adding a New Translation Key

1. Add the key + English value to `translations.en` in `translations.ts`.
2. Add the key + Chinese value to `translations.zh`.
3. Use via `t('yourNewKey')` in components.

---

## 13. Environment & Secrets

### Required Variables

```bash
# Server
PORT=3001
CLIENT_URL=http://localhost:3000
DATABASE_PATH=./data/novohaven.db

# AI Providers (add the ones you use)
OPENAI_API_KEY=sk-...
ANTHROPIC_API_KEY=sk-ant-...
GOOGLE_API_KEY=AIza...

# Scraping (optional)
BRIGHTDATA_API_KEY=...

# Client
REACT_APP_API_URL=http://localhost:3001/api
```

### Rules

- **Never commit real API keys.** The `.env` file is gitignored.
- **`.env.example` must only contain placeholder values** (e.g., `sk-your-key-here`), never real keys.
- Client-side env vars must be prefixed with `REACT_APP_` (CRA requirement).
- Check provider availability at runtime with `isProviderConfigured()` — the app works without any AI keys using the Mock provider.

---

## 14. Git & Code Review

### Branch Strategy

- `main` — stable branch.
- Feature branches: `feature/<short-description>`
- Bug fixes: `fix/<short-description>`

### Commit Messages

Write concise commits describing the *why*:

```
Add executor config validation before workflow execution
Fix step ordering bug when cloning templates
Update AI model list with Gemini 2.5 Pro
```

### Code Review Checklist

- [ ] **Naming** follows conventions (Section 3)
- [ ] **Types** are explicit — no untyped `any` without justification
- [ ] **Error handling** follows the result-object pattern (services) or try/catch (routes)
- [ ] **No hardcoded colors** — uses `primary-*` / `secondary-*`
- [ ] **No scattered types** — new interfaces go in `types/index.ts`
- [ ] **No business logic in routes** — delegated to services
- [ ] **Barrel exports** updated if a new component/feature folder is added
- [ ] **i18n keys** added for any new user-facing strings
- [ ] **No secrets** in committed files
- [ ] **Database changes** have migration guards in `initializeDatabase()`

---

## 15. Architecture Patterns

### Key Patterns at a Glance

| Pattern | Where | How |
|---------|-------|-----|
| **Service layer** | Backend | Business logic in `/services`, routes are thin wrappers |
| **Executor plugin** | Backend | `StepExecutor` interface + `registry.ts` — new step types plug in without modifying engine |
| **Result objects** | Backend services | `{ success, content, error }` — no thrown exceptions for expected failures |
| **Variable system** | Workflow engine | `{{variable}}` for user input, `{{step_N_output}}` for chaining, company standards auto-resolved |
| **Human-in-the-loop** | Workflow engine | Steps pause at `awaiting_review`, require explicit approve/reject |
| **Multi-provider AI** | `aiService.ts` | Single `callAI()` dispatches to OpenAI/Anthropic/Google/Mock |
| **React Context** | Frontend | Auth, Language, Notification — no Redux |
| **Fetch-based API client** | Frontend | Singleton `api` object in `services/api.ts` |
| **Feature-based folders** | Frontend | Each feature = folder + component + barrel export |
| **Composition** | UI components | `Card` + `CardHeader` + `CardBody` + `CardFooter` |

### Data Flow

```
User → Component (useState) → api.method() → Express Route → Service → Database
                                                                ↓
                                                          Executor (if workflow step)
                                                                ↓
                                                          External API (AI, BrightData)
```

### Workflow Execution Lifecycle

```
1. User starts execution → status: 'pending'
2. Engine runs step 1    → step status: 'running'
3. Step completes        → step status: 'awaiting_review'
4. User approves         → step status: 'completed', next step starts
   User rejects          → step status: 'failed', execution: 'paused'
   User retries          → step re-executes with modified input
5. All steps complete    → execution status: 'completed'
```

---

## 16. Common Pitfalls

### sql.js is Synchronous

All database operations block the event loop. Queries are fast for current scale, but don't run expensive aggregations in hot paths.

```typescript
// This is synchronous — no await
const recipe = queries.getRecipeById(id);
```

### JSON Columns Need Parsing

Database stores JSON as strings. Always parse when reading, stringify when writing:

```typescript
// Reading
const config = JSON.parse(step.executor_config || '{}');

// Writing
queries.createStep(recipeId, order, name, type, model, template,
  JSON.stringify(inputConfig), outputFormat, JSON.stringify(modelConfig));
```

### snake_case ↔ camelCase Boundary

Database uses `snake_case`, JavaScript uses `camelCase`. The boundary is at the query/route layer. Don't rename fields — the codebase uses snake_case in interfaces that map directly to DB rows:

```typescript
// This is correct — interface mirrors DB columns
interface Recipe {
  created_by: number;   // snake_case because it maps to DB
  is_template: boolean;
}
```

### Auth Is Mock (MVP)

The `authMiddleware` always resolves to the demo user. Don't build features that depend on multi-user isolation until real auth is implemented.

### Client-Side Env Vars Are Public

Anything prefixed `REACT_APP_` is bundled into the client build and visible to users. Never put secrets there.

### Step Output References

`{{step_N_output}}` uses 1-based indexing matching `step_order`, not 0-based array indexing.

---

*Last updated: February 2025*
