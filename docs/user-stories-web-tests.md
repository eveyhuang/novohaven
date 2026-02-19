# NovoHaven Web Test User Stories

## Notes
- Source used: `DEVELOPER_GUIDELINES.md` 
- These stories are written to be directly translated into automated web tests.

## Reusable Test Data (Fixtures)

### `review_data.csv`
```csv
rating,title,review
5,Great kettle,"Boils in 3 minutes and looks premium."
2,Stopped working,"Stopped heating after 2 weeks."
4,Good value,"Fast boil and easy to clean."
```

### `requirements.json`
```json
{
  "background": "clean white seamless",
  "lighting": "soft daylight, low shadow",
  "angle": "45-degree hero shot",
  "style": "minimal premium e-commerce",
  "aspect_ratio": "1:1"
}
```

### `agent_note.txt`
```txt
Please summarize the top 3 customer pain points from this file.
```

### Shared Input Values
- `product_name = "AeroBrew Coffee Grinder"`
- `target_audience = "Home baristas in small apartments"`
- `analysis_focus = "durability, noise, value for money"`
- `workflow_name = "Listing + Review Pipeline"`

## Happy-Path User Stories

### HP-01
User lands on `/` and is auto-authenticated. User sees sidebar brand `NovoHaven`, nav links (`Dashboard`, `Agent Chat`, `New Skill`, etc.), and footer user `demo@novohaven.com` with `Demo Account`. No login form is shown.

### HP-02
User toggles language from sidebar on `/`. User clicks `Language` toggle once; expects badge changes from `EN` to `中文` and page strings change to Chinese (for example dashboard title becomes `仪表板`). User refreshes page; expects Chinese remains (localStorage persistence). User toggles again; English returns.

### HP-03
User verifies dashboard navigation cards on `/`. User sees health cards (`Active Sessions`, `Pending Drafts`, `Skills`, `Workflows`) and `Build with AI` card. User clicks `Build with AI` card (or `Get Started` button); expects navigation to `/workflows/ai-builder`.

### HP-04
User creates a new AI skill at `/skills/new`. User enters name `QA Listing Writer`, description `Generate concise Amazon listing copy`, prompt `Write a 5-bullet listing for {{product_name}} for {{target_audience}}.`, output format `Markdown`, temperature `0.3`, max tokens `1200`. User clicks `Create Template`; expects redirect to `/` and new card visible under `My Skills` titled `QA Listing Writer`.

### HP-05
User configures variables in skill editor at `/skills/:id`. User opens `Input Variables`, adds variable `product_name` and `target_audience`, sets labels `Product Name` and `Target Audience`, clicks save. User reopens skill; expects prompt still contains `{{product_name}}` and `{{target_audience}}`, and configured labels persist.

### HP-06
User runs a skill from `/skills/:id` with valid inputs. User clicks `Run`, enters `AeroBrew Coffee Grinder` and `Home baristas in small apartments`, clicks `Run` in modal; expects navigation to `/executions/{id}`.

### HP-07
User creates a workflow at `/workflows/new`. User enters workflow name `Listing + Review Pipeline`, description `Generate listing then summarize review pain points`, clicks `Add Template`, selects `QA Listing Writer`, saves. User expects workflow editor persists and route is the saved editor route (`/recipes/{id}` in current implementation).

### HP-08
User edits workflow steps at `/workflows/:id`. User selects step, changes step name to `Listing Draft Step`, uses move-down/up controls, then clicks `Save Changes`. User reloads page; expects step order and renamed step persist.

### HP-09
User runs workflow with input values at `/workflows/:id/run`. User sees `Input Values` section with required fields, enters `product_name` and `target_audience`, clicks `Start Workflow`. User expects redirect to `/executions/{id}` and execution header showing `Execution #{id}`.

### HP-10
User monitors executions at `/executions`. User sees execution row with status pill, recipe name, and progress text like `1 / 1 steps`. User clicks row; expects open `/executions/{id}`.

### HP-11
User cancels a running execution at `/executions`. User clicks cancel icon on running row; expects status changes to `cancelled` after refresh.

### HP-12
User deletes an execution at `/executions`. User clicks trash icon on one row, sees modal `Delete Execution`, clicks `Delete`; expects row removed from list.

### HP-13
User reviews execution chat details at `/executions/:id`. User sees step/system/output messages. On an output message, user clicks `Copy`; expects button text changes to `Copied!` briefly. If execution completes, user sees status badge `completed`.

### HP-14
User chats with agent at `/chat`. User clicks `+ New Chat`, types `Summarize three benefits of stainless steel water bottles.` and presses Enter. User expects own message bubble immediately, session appears in sidebar with title starting from prompt text, and assistant response (or assistant error message bubble) appears afterward.

### HP-15
User sends attachment in agent chat at `/chat`. User clicks attachment icon, uploads `agent_note.txt`, clicks send with empty text. User expects attachment chip shown in user bubble and session remains active.

### HP-16
User manages chat sessions in `/chat`. User clicks `Clear all chats`; expects sidebar session list clears and empty state `No conversations yet` appears.

### HP-17
User monitors sessions at `/sessions`. User sees table columns (`Session ID`, `Channel`, `Status`, `User`, `Last Active`, `Messages`). User clicks a row; expects transcript panel expands with user/assistant bubbles. User clicks `Close`; expects row status becomes `closed`.

### HP-18
User manages plugins at `/plugins`. User expands `Browser Automation` plugin, changes `timeout` from `30000` to `45000`, clicks `Save Config`; collapses and reopens, expects value `45000` persists. User toggles plugin enabled switch off then on; expects switch state updates without page error.

### HP-19
User reviews skill drafts at `/drafts` (seed at least one draft). User sees draft table with `Name`, `Type`, `Change Summary`, `Created`. User clicks row; expects expanded comparison (`Original` vs `Proposed Changes`). User clicks `Approve`; expects draft disappears from list.

### HP-20
User browses generated outputs at `/outputs`. User clicks `Text`, `Markdown`, `JSON`, `Images`, `Files` tabs and sees count badges update. User opens one output card; expects modal with `Recipe`, `Model`, `Executed` metadata. User clicks `Download Text` (or `Download JSON` / `Download Markdown`); expects file download starts. User clicks `View Execution`; expects navigation to `/executions/{executionId}`.

### HP-21
User manages company standards at `/standards`. User clicks `Add Standard` and creates:
- `Name: Brand Voice - Ecommerce`
- `Type: Brand Voice`
- `Tone: Professional yet approachable`
- `Style: Benefit-first, concise`
- `Guidelines: "Use active voice", "Lead with customer value"`
User clicks `Create Standard`; expects new card appears in `Brand Voice` tab showing tone/style/guidelines. User clicks `Edit`, updates tone to `Friendly expert`, saves, sees updated value. User clicks `Delete`, confirms, and card is removed.

### HP-22
User checks usage analytics at `/usage`. User sees `Usage Dashboard` with `Overview` and `History` tabs. In `Overview`, user sees period cards (`Today`, `This Week`, `This Month`) and service breakdown rows. User clicks `History`; expects table with `Date`, `Service`, `Endpoint`, `Requests`, `Records`.

### HP-23
User builds workflow via AI assistant at `/workflows/ai-builder` (requires at least one configured AI provider model). User enters `Create a 2-step workflow: research electric kettles, then draft an Amazon listing.`, clicks `Send`. User expects assistant chat response and right-side `Workflow Preview` populated with name/description/steps. User edits first step name to `Kettle Research`, clicks `Save as Recipe`; expects navigation to `/recipes/{id}`.

### HP-24
User runs Manus task when configured at `/manus`. User enters prompt `Find top 5 ergonomic office chairs under $300 and summarize pros/cons.`, clicks `Start Task`; expects navigation to `/executions/{id}`.

### HP-25
User verifies relevant existing-skill/workflow recommendation in `/chat`. Preconditions: user already has a skill named `Product Review Analyzer` and a workflow named `Listing + Review Pipeline`. User sends `I need to analyze customer reviews for my new kettle listing.` Agent should suggest one or both previously created assets by exact name (or ID), instead of proposing unrelated from-scratch steps.

### HP-26
User verifies required-input collection and execution after skill suggestion in `/chat`. Preconditions: `Product Review Analyzer` has required inputs `review_data` and optional `analysis_focus`. User sends `Run Product Review Analyzer` without inputs. Agent should ask for missing required input(s). User replies with `review_data.csv` attachment and text `analysis_focus=durability`. Agent should execute suggested skill/workflow and user should see output in chat plus a new execution in `/executions`.

### HP-27
User verifies agent self-heals a broken skill and submits draft for review. Preconditions: create a broken skill named `Broken Sentiment Skill` with unresolved variable like `{{missing_column}}` in prompt. In `/chat`, user asks `Run Broken Sentiment Skill and fix it if it fails.` Agent should diagnose failure/validation issues, propose a fix, and create a pending draft (response includes draft reference). In `/drafts`, user should see a new pending draft for that skill with change summary explaining the fix.

### HP-28
User verifies agent self-heals a broken workflow and submits draft for review. Preconditions: create workflow `Broken Pipeline` where step 1 references `{{step_2_output}}` (invalid order). In `/chat`, user asks `Use Broken Pipeline and repair it.` Agent should identify sequencing/config errors, submit a workflow draft for review, and explain what changed. In `/drafts`, user should see a pending workflow draft. After approve, running the workflow from `/workflows/:id/run` should no longer fail for the original ordering issue.

### HP-29
User verifies AI Workflow Builder self-healing loop at `/workflows/ai-builder`. User asks assistant to create a workflow, then intentionally requests a breaking change: `Now rewrite this so step 1 uses {{step_3_output}} and remove required inputs.` Assistant should correct itself on follow-up (repair invalid variable chain and restore needed inputs), update right-side `Workflow Preview`, and produce a runnable workflow that can be saved and started without structural validation failure.

## Error / Edge-Case User Stories

### EE-01
User validates required-input behavior in skill run modal at `/skills/:id`. User clicks `Run`, leaves fields empty, clicks `Run`; expects inline error starting with `Please fill in all required fields`.

### EE-02
User validates Manus unconfigured state at `/manus`. If `MANUS_API_KEY` is missing, user sees red not-configured badge and message explaining Manus is not configured.

### EE-03
User validates 404 handling. User opens `/not-a-real-page`; expects `Page Not Found` and text `The page you're looking for doesn't exist.`

## Priority Tags (Automation Planning)

### Priority Levels
- `P0`: must-run on every CI pass (critical user paths)
- `P1`: important regression coverage (daily/nightly)
- `P2`: lower-risk or admin/diagnostic flows (scheduled)

### Priority Matrix

| Story ID | Priority | Why |
|---|---|---|
| HP-01 | P0 | App boot/auth baseline |
| HP-02 | P1 | i18n persistence |
| HP-03 | P1 | Dashboard navigation entry points |
| HP-04 | P0 | Core skill creation |
| HP-05 | P1 | Variable config persistence |
| HP-06 | P0 | Skill execution launch |
| HP-07 | P0 | Core workflow creation |
| HP-08 | P1 | Workflow edit persistence |
| HP-09 | P0 | Workflow run start |
| HP-10 | P0 | Execution visibility |
| HP-11 | P1 | Execution control action |
| HP-12 | P1 | Execution deletion control |
| HP-13 | P1 | Execution detail rendering |
| HP-14 | P0 | Agent chat send/receive |
| HP-15 | P1 | Chat attachment handling |
| HP-16 | P2 | Chat bulk cleanup |
| HP-17 | P2 | Session monitor admin flow |
| HP-18 | P2 | Plugin manager admin flow |
| HP-19 | P2 | Draft review admin flow |
| HP-20 | P1 | Output gallery + downloads |
| HP-21 | P1 | Standards CRUD |
| HP-22 | P2 | Usage analytics |
| HP-23 | P1 | AI builder workflow generation |
| HP-24 | P1 | Manus configured flow |
| HP-25 | P0 | Ensures agent reuses user-created assets correctly |
| HP-26 | P0 | Validates missing-input prompt + output execution in chat |
| HP-27 | P1 | Agent self-healing for broken skill via draft workflow |
| HP-28 | P1 | Agent self-healing for broken workflow via draft workflow |
| HP-29 | P1 | AI builder iterative self-correction before save/run |
| EE-01 | P0 | Required-field validation |
| EE-02 | P1 | Manus unconfigured guardrail |
| EE-03 | P1 | 404 route fallback |
